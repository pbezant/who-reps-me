// Batch jurisdiction discovery: budget-capped, incremental growth of the auto-discovered half
// of "which cities/counties get scraped" (see config/seeds.json's own header comment and
// scraper/README.md's "Dynamic jurisdiction discovery" section).
//
// Walks the "universe" of incorporated places + counties for one or more states
// (scraper/data/jurisdictions/<STATE>.json, built once by scripts/build-jurisdiction-universe.js
// from the US Census Gazetteer Files), skipping anything already in config/seeds.json or
// already recorded here (a hit, or a miss still inside its cooldown), and for up to
// DISCOVER_BUDGET (default 15) new jurisdictions per run: asks the configured LLM for the
// jurisdiction's official homepage (discoverJurisdictionSite(), discover.js), verifies it, then
// runs the same breadth-first roster-page crawl the on-demand path uses (findRosterPage(),
// discover.js). A hit is appended to config/seeds.discovered.json's `jurisdictions`; a miss is
// recorded in its `misses` (with a reason and a checked_at, so it's retried after a cooldown
// rather than forever).
//
// This does NOT itself extract/commit officials data — it only finds and verifies roster URLs.
// The next scheduled scrape.yml run picks up any newly discovered jurisdictions automatically
// via seeds.js's loadJurisdictions() (config/seeds.json ∪ config/seeds.discovered.json).
//
// Needs a real LLM_PRESET/LLM_API_KEY to be useful in a reasonable amount of time — each
// discovery attempt is up to 1 + fetchBudget LLM calls, so the keyless `ovh` default (2 RPM)
// makes even a 15-jurisdiction budget slow (same trade-off already documented for the on-demand
// Netlify path in scraper/README.md).
//
// Usage:
//   DISCOVER_STATES=TX LLM_PRESET=groq LLM_API_KEY=... node src/discover-jurisdictions.js
//   DISCOVER_STATES=TX DISCOVER_BUDGET=5 node src/discover-jurisdictions.js

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { discoverJurisdictionSite, findRosterPage } from "./discover.js";
import { loadJurisdictions, readJsonIfExists, jurisdictionKey, CONFIG_DIR } from "./seeds.js";
import { closeBrowser } from "./browser.js";

const DATA_DIR = join(CONFIG_DIR, "..", "data");
const DISCOVERED_PATH = join(CONFIG_DIR, "seeds.discovered.json");

// 90 days — long enough that a run doesn't waste budget re-trying the same likely-permanent
// miss every week, short enough that a small town that later gets a website is picked up again
// within a season, matching the spirit of local-officials.mjs's own miss-cache TTL.
const MISS_COOLDOWN_MS = 1000 * 60 * 60 * 24 * 90;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// No free source gives a government-body display name, and a 7th LLM call per jurisdiction just
// for a label isn't worth it — derive it mechanically, matching the pattern
// netlify/functions/local-officials.mjs already uses for its own on-demand jurisdictions. It's
// a fallback display label (toRepCard's `o.office || o.body || 'Local'` in src/App.js), not
// shown as authoritative, so an imperfect guess here is a cosmetic issue, not a data-quality one.
export function guessBodyName(city, level) {
  return level === "county" ? `${city} Commissioners Court` : `${city} City Council`;
}

// Picks which of `candidates` (the full universe of places+counties for the target states) are
// actually worth attempting this run: not already seeded/discovered, and not a miss still
// inside its cooldown. Pure/no I/O so it's unit-testable on its own (see
// discover-jurisdictions.test.js) separately from the discovery/crawl mechanics in main().
export function selectDiscoveryCandidates(candidates, { seededKeys, discoveredKeys, misses, now, missCooldownMs = MISS_COOLDOWN_MS }) {
  const missByKey = new Map((misses || []).map((m) => [jurisdictionKey(m), m]));
  return (candidates || []).filter((j) => {
    const key = jurisdictionKey(j);
    if (seededKeys.has(key) || discoveredKeys.has(key)) return false;
    const miss = missByKey.get(key);
    if (miss) {
      const age = Date.parse(now) - Date.parse(miss.checked_at || 0);
      if (Number.isFinite(age) && age < missCooldownMs) return false;
    }
    return true;
  });
}

async function main() {
  const states = (process.env.DISCOVER_STATES || "TX")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const budget = Number(process.env.DISCOVER_BUDGET || 15);
  // Unlike the on-demand Netlify path (no time budget to spend on a real browser), a scheduled
  // batch run can afford the Playwright fallback for client-rendered/WAF-blocked sites — same
  // opt-out convention as run.js/probe.js.
  const allowBrowser = process.env.SCRAPER_BROWSER !== "0";

  const alreadySeeded = await loadJurisdictions();
  const seededKeys = new Set(alreadySeeded.map(jurisdictionKey));

  const discoveredFile = (await readJsonIfExists(DISCOVERED_PATH)) || { jurisdictions: [], misses: [] };
  const discoveredKeys = new Set(discoveredFile.jurisdictions.map(jurisdictionKey));
  const missByKey = new Map((discoveredFile.misses || []).map((m) => [jurisdictionKey(m), m]));

  const candidates = [];
  for (const state of states) {
    const universe = await readJsonIfExists(join(DATA_DIR, "jurisdictions", `${state}.json`));
    if (!universe) {
      console.log(`No jurisdiction universe file for ${state} (run scripts/build-jurisdiction-universe.js first) — skipping.`);
      continue;
    }
    for (const city of universe.places || []) candidates.push({ city, state, level: "local" });
    for (const city of universe.counties || []) candidates.push({ city, state, level: "county" });
  }

  const now = new Date().toISOString();
  const queue = selectDiscoveryCandidates(candidates, {
    seededKeys,
    discoveredKeys,
    misses: [...missByKey.values()],
    now,
  });

  console.log(`${queue.length} not-yet-attempted jurisdiction(s) across ${states.join(", ")}; budget ${budget} this run.`);

  let attempted = 0;
  let hits = 0;
  for (const j of queue) {
    if (attempted >= budget) break;
    attempted++;

    // Polite pause between jurisdictions — this is a low-volume crawler of public records, not
    // a load test on small-town web servers (llm.js's own throttle() already separately rate-
    // limits the LLM calls themselves against the configured provider's RPM).
    if (attempted > 1) await sleep(1000);

    const key = jurisdictionKey(j);
    let site, discoverError;
    try {
      site = await discoverJurisdictionSite(j);
    } catch (err) {
      if (err?.fatal) throw err; // a misconfigured provider fails identically every time — stop the run
      discoverError = err.message;
    }

    if (!site) {
      missByKey.set(key, { ...j, checked_at: now, reason: discoverError || "no site found" });
      console.log(`  MISS  ${j.city}, ${j.state}: ${discoverError || "no site found"}`);
      continue;
    }

    let result;
    try {
      result = await findRosterPage({
        startUrl: site.url,
        startPage: site.page,
        jurisdiction: { ...j, body: guessBodyName(j.city, j.level) },
        allowBrowser,
      });
    } catch (err) {
      if (err?.fatal) throw err;
      missByKey.set(key, { ...j, checked_at: now, reason: `roster crawl failed: ${err.message}` });
      console.log(`  MISS  ${j.city}, ${j.state}: roster crawl failed: ${err.message}`);
      continue;
    }

    if (!result.officials.length || !result.sourceUrl) {
      missByKey.set(key, { ...j, checked_at: now, reason: result.error || "roster page not found" });
      console.log(`  MISS  ${j.city}, ${j.state}: ${result.error || "roster page not found"}`);
      continue;
    }

    hits++;
    missByKey.delete(key); // a later hit supersedes an earlier recorded miss
    discoveredFile.jurisdictions.push({
      city: j.city,
      state: j.state,
      level: j.level,
      body: guessBodyName(j.city, j.level),
      urls: [result.sourceUrl],
      discovered_at: now,
    });
    discoveredKeys.add(key);
    console.log(`  HIT   ${j.city}, ${j.state}: ${result.sourceUrl} (${result.officials.length} officials found)`);
  }

  discoveredFile.misses = [...missByKey.values()];
  discoveredFile.generated_at = now;
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(DISCOVERED_PATH, JSON.stringify(discoveredFile, null, 2));

  console.log(`\n${attempted} attempted, ${hits} hit(s), ${attempted - hits} miss(es). Wrote ${DISCOVERED_PATH}.`);
  console.log(`Total auto-discovered jurisdictions so far: ${discoveredFile.jurisdictions.length}.`);
}

// Only run when this file is executed directly, not when imported for its exported pure
// functions (discover-jurisdictions.test.js does exactly that) — see federal-details.js for the
// same guard and why it's needed.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closeBrowser());
}
