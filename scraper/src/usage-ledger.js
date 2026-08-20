// Shared daily LLM-call budget, tracked across the sequence of phases run-daily.yml runs
// (promote -> scrape -> discover -> qa-check) in one job. Each phase asks "how much of today's
// budget is left" before deciding how many jurisdictions to attempt, then records exactly how
// many calls it actually made (llm.js's own getCallCount() — a real count, not an estimate) so
// the next phase in the same run sees an accurate remaining balance.
//
// Deliberately NOT trying to query the provider's own remaining-quota (Gemini's free API-key
// tier doesn't expose that in real time the way some APIs do) — we already know exactly how
// many requests we've made, since we're the ones making them.
//
// scraper/data/llm-usage.json is committed (unlike the rest of data/*, which is gitignored
// scratch — see scraper/.gitignore's own exception for data/jurisdictions/) so the day's running
// total survives between this job's own steps, which each run as a fresh `node` process.
//
// No cross-process write race to guard against: run-daily.yml runs every phase sequentially in
// one job, never two phases writing at once — unlike the shard/seeds commits, which do need the
// fetch+rebase retry (see that workflow's own commit step) because a *different* workflow could
// be pushing concurrently.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const LEDGER_PATH = join(__dirname, "..", "data", "llm-usage.json");

// A little under Gemini's real 1,500 requests/day cap, so a day's last phase stops before
// actually hitting the wall (and whatever headroom's left absorbs a 429 retry or two without
// tipping the shared cap over).
export const DEFAULT_DAILY_CAP = 1450;

const todayUTC = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// Pure: how many calls are already "used today" per a stored ledger. A ledger from a previous
// day is stale — the quota reset, so its count doesn't carry over. Exported so this rollover
// rule is directly testable without touching the filesystem.
export function usedToday(storedLedger, today = todayUTC()) {
  if (!storedLedger || storedLedger.date !== today) return 0;
  return storedLedger.calls_used || 0;
}

async function readLedger() {
  try {
    return JSON.parse(await readFile(LEDGER_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function readUsedToday() {
  return usedToday(await readLedger());
}

export function remainingBudget(used, dailyCap = Number(process.env.LLM_DAILY_CAP || DEFAULT_DAILY_CAP)) {
  return Math.max(0, dailyCap - used);
}

// Adds `callsThisPhase` to today's running total and writes it back. `by_phase` accumulates
// across the day too (informational — what a run-daily.yml log/summary can report), reset
// alongside calls_used whenever the stored ledger rolls over to a new day.
export async function recordUsage(callsThisPhase, { phase } = {}) {
  const today = todayUTC();
  const stored = await readLedger();
  const sameDay = stored?.date === today;
  const calls_used = (sameDay ? stored.calls_used || 0 : 0) + callsThisPhase;
  const by_phase = sameDay ? { ...stored.by_phase } : {};
  if (phase) by_phase[phase] = (by_phase[phase] || 0) + callsThisPhase;

  await mkdir(dirname(LEDGER_PATH), { recursive: true });
  await writeFile(LEDGER_PATH, JSON.stringify({ date: today, calls_used, by_phase }, null, 2));
  return { date: today, calls_used, by_phase };
}

// Converts a remaining call budget into a jurisdiction-count budget for a phase whose actual
// per-jurisdiction cost varies (a handful of hops for a hard one, one call for an easy one).
// `avgCallsPerJurisdiction` is that phase's own observed average (see run.js/
// discover-jurisdictions.js for the current estimates and where they came from);
// `safetyMargin` (0-1) trims the estimate down since it's an average, not a ceiling — better to
// stop a little early than overshoot the shared daily cap on a heavier-than-average run.
export function estimateBudgetFromRemaining(remaining, avgCallsPerJurisdiction, safetyMargin = 0.85) {
  if (!avgCallsPerJurisdiction) return 0;
  return Math.max(0, Math.floor((remaining / avgCallsPerJurisdiction) * safetyMargin));
}
