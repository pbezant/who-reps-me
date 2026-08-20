// Thoroughness/correctness check: re-fetches a sample of already-scraped jurisdictions' own
// source_url, re-runs the exact same fetch -> extract -> normalize pipeline run.js itself uses,
// and diffs the fresh extraction against what's currently stored. Flags a roster page where
// they disagree — an official no longer showing up (left office, or the original extraction was
// wrong), or new ones the stored record is missing — as worth a look, and merges in whatever the
// fresh pass found that the stored record didn't (writeShards()'s own upsert-merge — see
// output.js — never erases enrichment a previous pass found, so this can only add/correct, not
// silently delete; a name missing from the fresh pass is reported, never auto-removed, since a
// bad fetch/render is a much likelier explanation than someone actually leaving office in the
// interval between two scrapes).
//
// Deliberately reuses the real pipeline rather than a heuristic ("a county with < 3 officials
// looks wrong") — a fresh, independent extraction catches actual drift (a councilmember who's
// left, a redesigned page) that a size-only rule can't, at the cost of one real LLM call per
// roster page checked.
//
// Sampling is weighted toward records most worth re-checking (oldest extraction first, lowest
// confidence as the tiebreaker) and capped at QA_SAMPLE_SIZE (default 25) regardless of how much
// shared daily budget remains — this phase runs last in run-daily.yml and is meant to spot-check,
// not spend a large slice of the day's calls.
//
// Usage:
//   LLM_PRESET=gemini LLM_API_KEY=... node scripts/qa-check.js
//   QA_SAMPLE_SIZE=10 node scripts/qa-check.js

import { readFile, readdir, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchPage } from "../src/fetch.js";
import { extractOfficials } from "../src/extract.js";
import { normalize } from "../src/normalize.js";
import { findMediaCandidates } from "../src/media.js";
import { writeShards } from "../src/output.js";
import { getCallCount } from "../src/llm.js";
import { readUsedToday, remainingBudget, estimateBudgetFromRemaining, recordUsage } from "../src/usage-ledger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PUBLIC_OFFICIALS_DIR = join(REPO_ROOT, "public", "officials");

const DEFAULT_SAMPLE_SIZE = 25;
// One re-extraction call per sampled roster page (no bio-page follow-up pass here — this is a
// completeness/drift check on the roster itself, not a field-enrichment pass).
const AVG_QA_CALLS_PER_JURISDICTION = 1;

// Groups already-committed official records by source_url — a jurisdiction is one or more
// officials sharing the same roster page, which is the unit this script re-fetches/re-extracts,
// not the individual official. Pure so it's directly testable.
export function groupBySourceUrl(officials) {
  const byUrl = new Map();
  for (const rec of officials) {
    if (!rec.source_url) continue;
    if (!byUrl.has(rec.source_url)) byUrl.set(rec.source_url, []);
    byUrl.get(rec.source_url).push(rec);
  }
  return byUrl;
}

// Orders roster pages worst-first for a QA pass: oldest extraction first (most likely stale),
// lowest confidence as the tiebreaker (least trusted the first time). Pure so it's directly
// testable without touching the filesystem.
export function rankForReview(groups) {
  return [...groups.entries()].sort(([, recsA], [, recsB]) => {
    const oldestA = Math.min(...recsA.map((r) => Date.parse(r.extracted_at) || 0));
    const oldestB = Math.min(...recsB.map((r) => Date.parse(r.extracted_at) || 0));
    if (oldestA !== oldestB) return oldestA - oldestB;
    const minConfA = Math.min(...recsA.map((r) => (r.confidence == null ? 1 : r.confidence)));
    const minConfB = Math.min(...recsB.map((r) => (r.confidence == null ? 1 : r.confidence)));
    return minConfA - minConfB;
  });
}

// Compares a fresh extraction against the stored records for the same source_url. Returns null
// when they agree, or a finding describing the discrepancy. Matched by name (lowercased/
// trimmed) rather than id, since a fresh extraction's id could differ on office-phrasing even
// for the same person — see normalize.js's buildId()/canonicalizeOffice() for why that
// canonicalization exists in the first place. Pure/no I/O.
export function diffExtraction(storedRecords, freshRecords) {
  const storedNames = new Set(storedRecords.map((r) => r.name.toLowerCase().trim()));
  const freshNames = new Set(freshRecords.map((r) => r.name.toLowerCase().trim()));
  const missing = [...storedNames].filter((n) => !freshNames.has(n));
  const added = [...freshNames].filter((n) => !storedNames.has(n));
  if (!missing.length && !added.length) return null;
  return { stored_count: storedRecords.length, fresh_count: freshRecords.length, missing_from_fresh: missing, new_in_fresh: added };
}

async function loadAllOfficials() {
  const files = (await readdir(PUBLIC_OFFICIALS_DIR).catch(() => [])).filter(
    (f) => f.endsWith(".json") && f !== "index.json"
  );
  const all = [];
  for (const f of files) {
    const shard = JSON.parse(await readFile(join(PUBLIC_OFFICIALS_DIR, f), "utf8"));
    all.push(...(shard.officials || []));
  }
  return all;
}

async function main() {
  const remaining = remainingBudget(await readUsedToday());
  const estimatedFromRemaining = estimateBudgetFromRemaining(remaining, AVG_QA_CALLS_PER_JURISDICTION);
  const sampleSize = Math.min(Number(process.env.QA_SAMPLE_SIZE || DEFAULT_SAMPLE_SIZE), estimatedFromRemaining);

  if (sampleSize <= 0) {
    console.log("No shared daily budget left for a QA pass — skipping.");
    return;
  }

  const allOfficials = await loadAllOfficials();
  const groups = groupBySourceUrl(allOfficials);
  const ranked = rankForReview(groups).slice(0, sampleSize);
  console.log(`QA pass: re-checking ${ranked.length} of ${groups.size} known roster pages (sample cap ${sampleSize}).`);

  const allowBrowser = process.env.SCRAPER_BROWSER !== "0";
  const now = new Date().toISOString();
  const findings = [];
  const correctedOfficials = [];
  let checked = 0;
  let fatal = null;

  for (const [sourceUrl, storedRecords] of ranked) {
    checked++;
    const first = storedRecords[0];
    const jurisdiction = { city: first.jurisdiction?.city, state: first.jurisdiction?.state, level: first.level, body: first.body };
    try {
      const page = await fetchPage(sourceUrl, { allowBrowser });
      if (!page.ok) {
        findings.push({ source_url: sourceUrl, jurisdiction, issue: `page no longer reachable: ${page.error || "fetch failed"}` });
        continue;
      }
      const media = findMediaCandidates(page.html, sourceUrl);
      const raw = await extractOfficials({ text: page.text, url: sourceUrl, jurisdiction, media });
      const fresh = raw.map((r) => normalize(r, { jurisdiction, sourceUrl, extractedAt: now })).filter(Boolean);
      const diff = diffExtraction(storedRecords, fresh);
      if (diff) {
        findings.push({ source_url: sourceUrl, jurisdiction, ...diff });
        correctedOfficials.push(...fresh); // merge in whatever the fresh pass found — additive/corrective only, see header comment
      }
    } catch (err) {
      if (err?.fatal) {
        fatal = err;
        break;
      }
      findings.push({ source_url: sourceUrl, jurisdiction, issue: `re-check failed: ${err.message}` });
    }
  }

  if (correctedOfficials.length) {
    const { states } = await writeShards(correctedOfficials, { publicDir: PUBLIC_OFFICIALS_DIR, now });
    console.log(`Merged corrections into ${states.length} state shard(s) from ${correctedOfficials.length} re-extracted official(s).`);
  }

  console.log(`\n${findings.length} of ${checked} re-checked roster page(s) disagree with what's stored:`);
  for (const f of findings) {
    console.log(`  - ${f.jurisdiction.city}, ${f.jurisdiction.state}: ${f.issue || `stored ${f.stored_count} vs fresh ${f.fresh_count}`}`);
  }
  if (fatal) console.error(`\nQA pass stopped early — LLM provider unusable: ${fatal.message}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## QA check`,
      ``,
      `- Re-checked **${checked}** of ${groups.size} known roster pages`,
      `- **${findings.length}** disagree with what's currently stored`,
      ``,
      ...findings.map(
        (f) => `- **${f.jurisdiction.city}, ${f.jurisdiction.state}** (${f.source_url}): ${f.issue || `stored ${f.stored_count} officials, fresh extraction found ${f.fresh_count}`}`
      ),
    ];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }

  const usage = await recordUsage(getCallCount(), { phase: "qa" });
  console.log(`\nLLM calls this run: ${getCallCount()} (today's running total: ${usage.calls_used}).`);
}

// Only run when this file is executed directly, not when imported for its exported pure
// functions — see federal-details.js for the same guard and why it's needed.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
