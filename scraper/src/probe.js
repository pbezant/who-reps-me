// Seed health check — ZERO Claude API cost.
//
// Fetches every URL in config/seeds.json and reports whether it is reachable and actually
// looks like a roster page (contains "Council Member", "Mayor", "Commissioner", "Place 3", …).
// When a seed URL fails or looks wrong, it pulls the site's homepage and suggests links whose
// text/href mentions council/commissioner — so a broken seed can be fixed without guessing.
//
// Run this before `npm run scrape` whenever seeds change: it costs nothing and stops you from
// spending extraction tokens on dead URLs.
//
// Usage:
//   npm run probe
//   npm run probe -- --only Kyle

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchPage } from "./fetch.js";
import { closeBrowser } from "./browser.js";
import { suggestLinks } from "./suggest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Signals that a page is a roster of officials rather than a generic landing page.
const ROSTER_RE =
  /council ?member|councilmember|city council|mayor|commissioner|alderman|place \d|district \d|precinct \d/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

  const seeds = JSON.parse(await readFile(join(ROOT, "config", "seeds.json"), "utf8"));
  let jurisdictions = seeds.jurisdictions;
  if (only) jurisdictions = jurisdictions.filter((j) => j.city.toLowerCase() === only.toLowerCase());

  const allowBrowser = process.env.SCRAPER_BROWSER !== "0";
  const TIMEOUT_MS = Number(process.env.SCRAPER_TIMEOUT_MS || 30000);

  const report = [];
  let ok = 0;

  for (const j of jurisdictions) {
    for (const url of j.urls) {
      const r = await fetchPage(url, { timeoutMs: TIMEOUT_MS, allowBrowser });
      let status;
      let suggestions = [];

      if (!r.ok) {
        status = `FAIL (${r.error})`;
        if (r.browserError) status += ` [browser: ${r.browserError}]`;
      } else if (r.needsBrowser) {
        status = "NEEDS-BROWSER (empty static render)";
        if (r.browserError) status += ` [browser: ${r.browserError}]`;
      } else if (!ROSTER_RE.test(r.text)) {
        status = "NO-ROSTER-KEYWORDS";
      } else {
        status = r.viaBrowser ? "OK (via browser)" : "OK";
        ok++;
      }

      // For anything that isn't clearly good, look at the homepage for a better candidate.
      if (status !== "OK") {
        try {
          const origin = new URL(url).origin;
          const home = await fetchPage(origin, { timeoutMs: TIMEOUT_MS, allowBrowser });
          if (home.ok) suggestions = suggestLinks(home.html, origin);
        } catch {
          /* ignore */
        }
      }

      console.log(`${status.padEnd(34)} ${j.city}, ${j.state}  ${url}`);
      for (const [href, text] of suggestions) console.log(`        try: ${href}  (${text})`);

      report.push({ city: j.city, state: j.state, url, status, suggestions });
      await sleep(800); // be polite between requests
    }
  }

  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(
    join(ROOT, "data", "probe.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), report }, null, 2)
  );

  console.log(`\n${ok}/${report.length} seed URL(s) look good. Full report: scraper/data/probe.json`);
  if (ok < report.length) {
    console.log("Fix or replace the non-OK URLs in scraper/config/seeds.json before scraping.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeBrowser());
