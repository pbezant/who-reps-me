// One-off cleanup for the duplicate-id bug fixed in ../src/normalize.js.
//
// Before that fix, a record's `id` was built from the *raw* office string, so two scrape runs
// that extracted the same person with slightly different office phrasing ("City Council
// Member" vs "Council Member") or quote style around a nickname ("Chito" with straight vs
// curly quotes) produced two different ids. output.js's upsertById() then treated them as two
// different people and kept both forever instead of the newer one replacing the older.
//
// This script re-derives every record's id with the fixed, canonicalized buildId() and merges
// any records that land on the same id — so it both (a) dedupes the records that already
// piled up under the old scheme, and (b) rewrites every remaining record's stored `id` to the
// new canonical form, so the *next* scrape run correctly upserts onto it instead of minting yet
// another duplicate.
//
// Usage:
//   node scripts/dedupe-shard.js ../public/officials/TX.json [--dry-run]
//
// Merge rule within a duplicate group: the record with the newest `extracted_at` wins as the
// base (its office/name/district/confidence/source_url/extracted_at are kept as-is); any field
// (or, for `social`, any individual platform) on the base that is null is backfilled from the
// newest duplicate that has a non-null value for it — e.g. an older duplicate has a photo_url or
// a twitter link the newer one is missing. Nothing is dropped silently — the script prints every
// group it merges.

import { readFile, writeFile } from "node:fs/promises";
import { buildId } from "../src/normalize.js";

// Fields worth backfilling from an older duplicate when the newest one hasn't got them yet.
// Deliberately excludes identity/provenance fields (name, office, jurisdiction, source_url,
// extracted_at, confidence) — those always come from whichever record is newest. `hours`/`bio`/
// `bio_checked_at` are the bio-page follow-up crawl's own fields (see ../src/pipeline.js) —
// backfilling them the same way as photo_url means a duplicate-group merge never loses
// enrichment an older record already found, same principle as normalize.js's mergeRecordFields()
// (not reused directly here: this script's "oldest non-null wins" is a slightly different rule
// than mergeRecordFields' two-record precedence, and keeping this file's own small, explicit
// merge is clearer for a rarely-run one-off tool than threading a third merge direction through
// the shared helper).
const BACKFILL_FIELDS = ["phone", "email", "url", "photo_url", "address", "district", "hours", "bio", "bio_checked_at"];

// `social` (added alongside photo_url — see normalize.js's normalizeSocial()) is an object with
// one key per platform, always present but usually all-null, so it needs its own per-platform
// backfill rather than the single `!= null` check BACKFILL_FIELDS uses: the object itself is
// never null, only its individual platform values are.
const SOCIAL_PLATFORMS = ["twitter", "facebook", "instagram", "linkedin", "youtube"];

function mergeGroup(records) {
  const [base, ...rest] = [...records].sort(
    (a, b) => new Date(b.extracted_at).getTime() - new Date(a.extracted_at).getTime()
  );
  const merged = { ...base };
  for (const field of BACKFILL_FIELDS) {
    if (merged[field] != null) continue;
    const donor = rest.find((r) => r[field] != null);
    if (donor) merged[field] = donor[field];
  }
  if (rest.some((r) => r.social)) {
    const social = { ...merged.social };
    for (const platform of SOCIAL_PLATFORMS) {
      if (social[platform] != null) continue;
      const donor = rest.find((r) => r.social?.[platform] != null);
      if (donor) social[platform] = donor.social[platform];
    }
    merged.social = social;
  }
  // offices[] (see ../src/normalize.js's normalizeOffices()) — older committed records won't
  // have this key at all. A simple "take the first non-empty list" is good enough here: unlike
  // social's fixed platform keys, offices has no stable per-entry identity to merge finer than
  // that within this one-off tool.
  if (!merged.offices?.length) {
    const donor = rest.find((r) => r.offices?.length);
    if (donor) merged.offices = donor.offices;
  }
  return merged;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const shardPath = args.find((a) => !a.startsWith("--"));
  if (!shardPath) {
    console.error("Usage: node scripts/dedupe-shard.js <path/to/STATE.json> [--dry-run]");
    process.exitCode = 1;
    return;
  }

  const shard = JSON.parse(await readFile(shardPath, "utf8"));
  const groups = new Map();
  for (const rec of shard.officials) {
    const canonicalId = buildId(rec.jurisdiction, rec.office, rec.name);
    if (!groups.has(canonicalId)) groups.set(canonicalId, []);
    groups.get(canonicalId).push(rec);
  }

  let dupeGroups = 0;
  let dupeRecordsRemoved = 0;
  const merged = [];
  for (const [canonicalId, records] of groups) {
    const rec = mergeGroup(records);
    rec.id = canonicalId;
    merged.push(rec);
    if (records.length > 1) {
      dupeGroups += 1;
      dupeRecordsRemoved += records.length - 1;
      console.log(
        `merge ${canonicalId} (${records.length} records, kept extracted_at=${rec.extracted_at}):`
      );
      for (const r of records) console.log(`  - ${r.id}  office="${r.office}"  extracted_at=${r.extracted_at}`);
    }
  }
  merged.sort((a, b) => a.id.localeCompare(b.id));

  const cities = [...new Set(merged.map((r) => r.jurisdiction?.city).filter(Boolean))].sort();
  const nextShard = { ...shard, count: merged.length, cities, officials: merged };

  console.log(
    `\n${dupeGroups} duplicate group(s) found, removing ${dupeRecordsRemoved} record(s): ` +
      `${shard.officials.length} -> ${merged.length} total.`
  );

  if (dryRun) {
    console.log("(--dry-run: not writing changes)");
    return;
  }
  if (dupeRecordsRemoved === 0) {
    console.log("Nothing to write.");
    return;
  }
  // Match output.js's formatting exactly (no trailing newline) to keep the diff to just the
  // records that actually changed.
  await writeFile(shardPath, JSON.stringify(nextShard, null, 2));
  console.log(`Wrote ${shardPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
