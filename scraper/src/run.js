// Prototype CLI runner. Loads the seed file, scrapes each jurisdiction, and writes the
// results as per-state JSON shards under public/officials/ — the static "database" the
// React app fetches (served free by Netlify). Runs locally or from the GitHub Actions
// cron; the scrape logic (pipeline.js) is identical either way.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... node src/run.js
//   ANTHROPIC_API_KEY=sk-... node src/run.js --only Kyle

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scrapeJurisdiction } from "./pipeline.js";
import { writeShards } from "./output.js";
import { closeBrowser, browserStatus } from "./browser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REPO_ROOT = join(ROOT, "..");
const PUBLIC_OFFICIALS_DIR = join(REPO_ROOT, "public", "officials");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

  const seeds = JSON.parse(await readFile(join(ROOT, "config", "seeds.json"), "utf8"));
  let jurisdictions = seeds.jurisdictions;
  if (only) jurisdictions = jurisdictions.filter((j) => j.city.toLowerCase() === only.toLowerCase());

  // Browser fallback is on unless explicitly disabled; it degrades to static-only when
  // Playwright isn't installed, so this is safe by default.
  const allowBrowser = process.env.SCRAPER_BROWSER !== "0";

  const now = new Date().toISOString();
  const allOfficials = [];
  const allProblems = [];

  for (const [i, j] of jurisdictions.entries()) {
    // Polite pause between jurisdictions — this is a low-volume crawler of public records,
    // not a load test on small-city web servers.
    if (i > 0) await sleep(1000);
    process.stdout.write(`Scraping ${j.city}, ${j.state} (${j.body}) ... `);
    const { officials, problems } = await scrapeJurisdiction(j, { now, allowBrowser });
    console.log(`${officials.length} officials, ${problems.length} problems`);
    allOfficials.push(...officials);
    for (const p of problems) allProblems.push({ city: j.city, state: j.state, ...p });
  }

  // Write per-state shards (upsert-merge) into public/officials/ — these are committed.
  const { states } = await writeShards(allOfficials, { publicDir: PUBLIC_OFFICIALS_DIR, now });
  console.log(`\nWrote ${allOfficials.length} officials across ${states.length} state shard(s):`);
  for (const s of states) console.log(`  - ${s.state}: ${s.count} total (${s.cities.length} cities)`);

  // Problems go to a scratch file (gitignored), not the committed data.
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(
    join(ROOT, "data", "problems.json"),
    JSON.stringify({ generated_at: now, problems: allProblems }, null, 2)
  );
  if (allProblems.length) {
    console.log(`\n${allProblems.length} problem page(s) (see scraper/data/problems.json):`);
    for (const p of allProblems) console.log(`  - ${p.city}, ${p.state}: ${p.url} -> ${p.error}`);
  }

  // If the browser fallback was wanted but unavailable, say so once — otherwise
  // "needs-browser" problems look unexplained.
  const bs = browserStatus();
  if (allowBrowser && !bs.available) {
    console.log(`\nBrowser fallback unavailable: ${bs.reason}`);
    console.log("Install it with: npm install playwright && npx playwright install chromium");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeBrowser());
