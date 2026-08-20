// Prototype CLI runner. Loads the seed file, scrapes each jurisdiction, and writes the
// results as per-state JSON shards under public/officials/ — the static "database" the
// React app fetches (served free by Netlify). Runs locally or from the GitHub Actions
// cron; the scrape logic (pipeline.js) is identical either way.
//
// At Central-Texas scale (~26 jurisdictions) a full sweep every run was fine. At nationwide
// scale (thousands of jurisdictions, once discover-jurisdictions.js has been building up
// config/seeds.discovered.json) it isn't: GitHub Actions caps a job at 6 hours, and even a
// generous free-tier LLM rate limit can't push that many pages through in one run. So unless
// --only targets a single jurisdiction, this run is budget-capped and prioritized
// (selectScrapeCandidates() below) — never-scraped jurisdictions first, then whichever
// previously-scraped ones are most overdue for a refresh (SCRAPER_REFRESH_DAYS, default 30 —
// officials rarely change, so there's no value re-confirming a jurisdiction that was scraped
// last week). A run that doesn't get through everything due just picks up where it left off next
// time, the same resumable pattern discover-jurisdictions.js already established.
//
// The budget itself defaults to however much of the shared daily LLM-call cap
// (usage-ledger.js) is left when this run starts, converted to a jurisdiction count via this
// phase's own observed average cost (AVG_SCRAPE_CALLS_PER_JURISDICTION below) — see
// run-daily.yml, which runs this after promote-blob-finds.js and before
// discover-jurisdictions.js in one shared-budget job. Set SCRAPER_BUDGET explicitly to override
// that (a fixed number, ignoring the ledger) for a standalone/local run.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... node src/run.js
//   ANTHROPIC_API_KEY=sk-... node src/run.js --only Kyle
//   SCRAPER_BUDGET=200 node src/run.js

import { writeFile, mkdir, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scrapeJurisdiction } from "./pipeline.js";
import { writeShards } from "./output.js";
import { closeBrowser, browserStatus } from "./browser.js";
import { loadJurisdictions, jurisdictionKey, readJsonIfExists } from "./seeds.js";
import { getCallCount } from "./llm.js";
import { readUsedToday, remainingBudget, estimateBudgetFromRemaining, recordUsage } from "./usage-ledger.js";

// Observed average across a real nationwide run (78 jurisdictions in ~13 minutes of "Run
// scraper" wall time at Gemini's 15 RPM throttle) — most jurisdictions cost 1 call (roster pass
// only); enrichment's own budget-capped bio-page follow-ups push the average up a bit, not to
// the documented worst case of ~11. Used only when SCRAPER_BUDGET isn't set explicitly.
const AVG_SCRAPE_CALLS_PER_JURISDICTION = 2.5;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REPO_ROOT = join(ROOT, "..");
const PUBLIC_OFFICIALS_DIR = join(REPO_ROOT, "public", "officials");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Picks which jurisdictions this run should actually scrape, in priority order, bounded by
// `budget`. Pure/no I/O so it's unit-testable on its own (see run.test.js) separately from
// loadLastScrapedByKey()'s file reads below. A jurisdiction scraped more recently than
// `refreshMs` ago is dropped entirely (not just deprioritized) — no point spending budget on
// it this run. Among what's left, never-scraped (no entry in `lastScrapedByKey`) always sorts
// before any previously-scraped jurisdiction, however stale; ties keep their relative order
// (a stable sort), so a batch newly written by discover-jurisdictions.js in population-weighted
// order arrives here in that same order rather than being reshuffled.
export function selectScrapeCandidates(jurisdictions, lastScrapedByKey, { budget, refreshMs, now }) {
  const dueNowFirst = jurisdictions
    .map((j) => {
      const lastScraped = lastScrapedByKey.get(jurisdictionKey(j));
      const age = lastScraped ? Date.parse(now) - Date.parse(lastScraped) : Infinity;
      return { jurisdiction: j, age };
    })
    .filter((x) => x.age >= refreshMs)
    .sort((a, b) => {
      if (a.age === Infinity && b.age === Infinity) return 0;
      if (a.age === Infinity) return -1;
      if (b.age === Infinity) return 1;
      return b.age - a.age;
    });
  return dueNowFirst.slice(0, budget).map((x) => x.jurisdiction);
}

// Builds a jurisdiction -> most-recent extracted_at map from the already-committed shards, so
// selectScrapeCandidates() can tell a never-scraped jurisdiction from one that's just due for a
// refresh. Only reads shards for states actually present in `jurisdictions` — no point reading
// all 50 states' worth when a run (or --only) only touches a handful.
async function loadLastScrapedByKey(jurisdictions, publicDir) {
  const states = [...new Set(jurisdictions.map((j) => j.state.toUpperCase()))];
  const byKey = new Map();
  for (const state of states) {
    const shard = await readJsonIfExists(join(publicDir, `${state}.json`));
    for (const rec of shard?.officials || []) {
      const key = jurisdictionKey({ state: rec.jurisdiction?.state, city: rec.jurisdiction?.city, level: rec.level });
      const prev = byKey.get(key);
      if (!prev || Date.parse(rec.extracted_at) > Date.parse(prev)) byKey.set(key, rec.extracted_at);
    }
  }
  return byKey;
}

async function main() {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

  // config/seeds.json (hand-authored) merged with config/seeds.discovered.json (auto-discovered
  // by discover-jurisdictions.js, when it exists) — seeds.json always wins a conflict. See
  // seeds.js's own header comment.
  let jurisdictions = await loadJurisdictions();
  const totalKnown = jurisdictions.length;
  let dueCount = totalKnown;

  if (only) {
    // A manual, targeted run bypasses budget/staleness entirely — you asked for this one.
    jurisdictions = jurisdictions.filter((j) => j.city.toLowerCase() === only.toLowerCase());
    dueCount = jurisdictions.length;
  } else {
    const remaining = remainingBudget(await readUsedToday());
    const ledgerBudget = estimateBudgetFromRemaining(remaining, AVG_SCRAPE_CALLS_PER_JURISDICTION);
    const budget = Number(process.env.SCRAPER_BUDGET || ledgerBudget);
    const refreshDays = Number(process.env.SCRAPER_REFRESH_DAYS || 30);
    const now = new Date().toISOString();
    const lastScrapedByKey = await loadLastScrapedByKey(jurisdictions, PUBLIC_OFFICIALS_DIR);
    const opts = { refreshMs: refreshDays * 24 * 60 * 60 * 1000, now };
    dueCount = selectScrapeCandidates(jurisdictions, lastScrapedByKey, { ...opts, budget: Infinity }).length;
    jurisdictions = selectScrapeCandidates(jurisdictions, lastScrapedByKey, { ...opts, budget });
  }

  console.log(
    `${jurisdictions.length} jurisdiction(s) this run (${dueCount} due for a scrape/refresh, ${totalKnown} known total).`
  );

  // Browser fallback is on unless explicitly disabled; it degrades to static-only when
  // Playwright isn't installed, so this is safe by default.
  const allowBrowser = process.env.SCRAPER_BROWSER !== "0";

  const now = new Date().toISOString();
  const allOfficials = [];
  const allProblems = [];
  let fatal = null;

  for (const [i, j] of jurisdictions.entries()) {
    // Polite pause between jurisdictions — this is a low-volume crawler of public records,
    // not a load test on small-city web servers.
    if (i > 0) await sleep(1000);
    process.stdout.write(`Scraping ${j.city}, ${j.state} (${j.body}) ... `);
    let officials, problems;
    try {
      ({ officials, problems } = await scrapeJurisdiction(j, { now, allowBrowser }));
    } catch (err) {
      if (err?.fatal) {
        // The provider is misconfigured or retired, so every remaining jurisdiction would
        // fail the same way. Stop now rather than burning through the rest of the list.
        console.log("FATAL");
        fatal = err;
        break;
      }
      throw err;
    }
    console.log(`${officials.length} officials, ${problems.length} problems`);
    allOfficials.push(...officials);
    for (const p of problems) allProblems.push({ city: j.city, state: j.state, ...p });
  }

  // Write per-state shards (upsert-merge) into public/officials/ — these are committed.
  const { states } = await writeShards(allOfficials, { publicDir: PUBLIC_OFFICIALS_DIR, now });
  console.log(`\nWrote ${allOfficials.length} officials across ${states.length} state shard(s):`);
  for (const s of states) console.log(`  - ${s.state}: ${s.count} total (${s.cities.length} cities)`);

  // Record real usage regardless of --only/fatal/problems — every branch above already made
  // whatever LLM calls it made, so the shared ledger needs to reflect that either way.
  const usage = await recordUsage(getCallCount(), { phase: "scrape" });
  console.log(`\nLLM calls this run: ${getCallCount()} (today's running total: ${usage.calls_used}).`);

  // Problems go to a scratch file (gitignored), not the committed data.
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(
    join(ROOT, "data", "problems.json"),
    JSON.stringify({ generated_at: now, problems: allProblems }, null, 2)
  );
  if (allProblems.length) {
    console.log(`\n${allProblems.length} problem page(s) (see scraper/data/problems.json):`);
    for (const p of allProblems) {
      console.log(`  - ${p.city}, ${p.state}: ${p.url} -> ${p.error}`);
      for (const [href, text] of p.suggestions || []) console.log(`        try: ${href}  (${text})`);
    }
  }

  // In CI, surface the outcome on the run's summary page so "did it work?" doesn't require
  // digging through logs.
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Local officials scrape`,
      ``,
      `- **${allOfficials.length}** officials extracted`,
      `- **${jurisdictions.length}** jurisdictions attempted`,
      `- **${allProblems.length}** page(s) failed`,
      ``,
      ...states.map((s) => `- \`${s.state}.json\`: ${s.count} officials across ${s.cities.length} cities`),
    ];
    if (fatal) {
      lines.push(``, `> **Run aborted — LLM provider unusable:** ${fatal.message}`, ``);
    }
    if (allProblems.length) {
      lines.push(``, `### Failed pages`, ``);
      for (const p of allProblems) {
        lines.push(`- **${p.city}, ${p.state}**: ${p.error}`);
        for (const [href] of p.suggestions || []) lines.push(`  - try: ${href}`);
      }
    }
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }

  if (fatal) {
    console.error(`\nRUN ABORTED — LLM provider unusable:\n  ${fatal.message}`);
    if (fatal.jurisdiction) console.error(`  (first failed at ${fatal.jurisdiction})`);
    console.error(
      [
        "",
        "Fix: set the repo variable LLM_PRESET to a working provider.",
        "  ovh       - no key required",
        "  groq      - needs secret LLM_API_KEY (free key at console.groq.com)",
        "  gemini    - needs secret LLM_API_KEY (free key at aistudio.google.com)",
        "  anthropic - needs secret ANTHROPIC_API_KEY",
      ].join("\n")
    );
    process.exitCode = 1;
  }

  // If the browser fallback was wanted but unavailable, say so once — otherwise
  // "needs-browser" problems look unexplained.
  const bs = browserStatus();
  if (allowBrowser && !bs.available) {
    console.log(`\nBrowser fallback unavailable: ${bs.reason}`);
    console.log("Install it with: npm install playwright && npx playwright install chromium");
  }
}

// Guarded so importing this module for its exported pure functions (run.test.js) never
// triggers a real scrape — the same bug bit federal-details.js, build-jurisdiction-universe.js,
// and discover-jurisdictions.js earlier in this project for the identical reason.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closeBrowser());
}
