// Promotes "suggest an official" URL submissions (netlify/functions/submit-official.mjs) into
// the permanent, git-committed dataset — the sibling of promote-blob-finds.js for user-submitted
// URLs instead of on-demand searches. Same reasoning as that script's own header comment: a
// submission that's already been fetched, extracted, and normalized shouldn't sit in Netlify
// Blobs forever (no backups, and the batch scraper never sees it) when it could be a permanent
// part of the dataset with the same 30-day refresh cycle everything else gets.
//
// Every submission is already fully scraped by the time it lands in Blobs (submit-official.mjs
// runs the real fetch → extract → normalize pipeline synchronously, at submit time) — so, same
// as promote-blob-finds.js, this script makes ZERO LLM calls of its own. It only decides which
// already-extracted results are trustworthy enough to promote automatically:
//
//   PROMOTED automatically when the submission's extraction reported is_government_source,
//   resolved a city+state, is local/county level (the scope this dataset covers — state
//   legislators/executives and federal reps are sourced elsewhere), and at least one official
//   cleared MIN_PROMOTABLE_CONFIDENCE (mirrors submit-official.mjs's own `promotable` flag,
//   recomputed here rather than trusted blindly in case that logic ever changes and old
//   Blobs entries were written under an older version of it).
//
//   Everything else (a non-government source, an unresolved jurisdiction, a state/federal
//   official, or a low-confidence extraction) is left alone — reported in this script's "needs a
//   look" output instead of silently discarded, so a legitimate submission that just needs a
//   human glance (e.g. confirm the jurisdiction) doesn't get lost. It stays in Blobs, unpromoted,
//   for next run to reconsider (or a person to act on directly).
//
// Needs live Netlify credentials — same two secrets as promote-blob-finds.js:
//   NETLIFY_AUTH_TOKEN   a personal/team API token (User settings -> Applications -> New access token)
//   NETLIFY_SITE_ID      the site's ID (Site configuration -> General -> Site details)
//
// Usage:
//   NETLIFY_AUTH_TOKEN=... NETLIFY_SITE_ID=... node scripts/promote-url-submissions.js

import { getStore } from "@netlify/blobs";
import { writeFile, mkdir, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readJsonIfExists, jurisdictionKey, loadJurisdictions, CONFIG_DIR } from "../src/seeds.js";
import { writeShards } from "../src/output.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PUBLIC_OFFICIALS_DIR = join(REPO_ROOT, "public", "officials");

const STORE_NAME = "official-url-submissions";
const DISCOVERED_PATH = join(CONFIG_DIR, "seeds.discovered.json");

// Kept in sync with submit-official.mjs's own constant of the same name — this dataset (and the
// frontend's local-officials matching) only covers local/county jurisdictions.
const PROMOTABLE_LEVELS = new Set(["local", "county"]);
const MIN_PROMOTABLE_CONFIDENCE = 0.6;

// Recomputes whether a stored submission is trustworthy enough to auto-promote, independent of
// whatever `entry.promotable` says (see this file's own header comment for why). Pure so it's
// directly testable without touching Blobs.
export function isPromotableSubmission(entry) {
  if (!entry?.ok || entry.promoted || !entry.officials?.length) return false;
  if (!entry.is_government_source) return false;
  const first = entry.officials[0];
  const level = first?.level;
  if (!PROMOTABLE_LEVELS.has(level)) return false;
  if (!first?.jurisdiction?.city || !first?.jurisdiction?.state) return false;
  return entry.officials.some((o) => (o.confidence ?? 0) >= MIN_PROMOTABLE_CONFIDENCE);
}

// One-line reason a submission wasn't auto-promoted, for the "needs a look" report — never
// shown to the submitter (that happens at submit time, in submit-official.mjs's own response),
// this is only for whoever is triaging config/seeds.json by hand. Pure/no I/O.
export function reasonNotPromotable(entry) {
  if (!entry?.ok) return `couldn't load the page: ${entry?.error || "unknown error"}`;
  if (!entry.officials?.length) return "no officials extracted";
  if (!entry.is_government_source) return "doesn't look like an official government source";
  const first = entry.officials[0];
  if (!first?.jurisdiction?.city || !first?.jurisdiction?.state) return "jurisdiction not resolved";
  if (!PROMOTABLE_LEVELS.has(first?.level)) return `out of scope for this dataset (level: ${first?.level || "unknown"})`;
  return "extraction confidence too low";
}

// Builds a seeds.discovered.json-shaped jurisdiction from an already-normalized submission,
// trusting officials[0].jurisdiction/level/body — the normalize()'d values, not the raw LLM
// jurisdiction guess — same "read the authoritative normalized value, don't reconstruct it"
// approach as promote-blob-finds.js's own jurisdictionFromEntry(). Returns null when the
// submission isn't promotable at all (see isPromotableSubmission()). Pure so it's directly
// testable without a live Blobs store.
export function jurisdictionFromSubmission(entry, { now } = {}) {
  if (!isPromotableSubmission(entry)) return null;
  const first = entry.officials[0];
  return {
    city: first.jurisdiction.city,
    state: first.jurisdiction.state,
    level: first.level,
    body: first.body || null,
    urls: [entry.url].filter(Boolean),
    discovered_at: entry.checked_at || now || new Date().toISOString(),
  };
}

async function main() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteID = process.env.NETLIFY_SITE_ID;
  if (!token || !siteID) {
    console.error("Set NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID (see this file's header comment) — nothing to do without them.");
    process.exitCode = 1;
    return;
  }

  const store = getStore({ name: STORE_NAME, siteID, token });

  const alreadySeeded = await loadJurisdictions();
  const seededKeys = new Set(alreadySeeded.map(jurisdictionKey));

  const discoveredFile = (await readJsonIfExists(DISCOVERED_PATH)) || { jurisdictions: [], misses: [] };
  const discoveredKeys = new Set(discoveredFile.jurisdictions.map(jurisdictionKey));

  const now = new Date().toISOString();
  let scanned = 0;
  let promoted = 0;
  let newJurisdictions = 0;
  const promotedOfficials = [];
  const needsReview = [];

  const { blobs } = await store.list();
  for (const { key } of blobs) {
    scanned++;
    const entry = await store.get(key, { type: "json" }).catch(() => null);
    if (!entry) continue;

    if (!isPromotableSubmission(entry)) {
      // Only worth reporting once (not forever) — a submission already marked promoted from a
      // prior run, or one with literally nothing extracted, isn't "needs a look" material.
      if (entry.ok && !entry.promoted && entry.officials?.length) {
        needsReview.push({ url: entry.url, note: entry.note, reason: reasonNotPromotable(entry) });
      }
      continue;
    }

    const j = jurisdictionFromSubmission(entry, { now });
    const jKey = jurisdictionKey(j);
    if (!seededKeys.has(jKey) && !discoveredKeys.has(jKey)) {
      discoveredFile.jurisdictions.push(j);
      discoveredKeys.add(jKey);
      newJurisdictions++;
    }
    promotedOfficials.push(...entry.officials);
    await store.setJSON(key, { ...entry, promoted: true, promoted_at: now });
    promoted++;
    console.log(`  PROMOTED  ${j.city}, ${j.state}: ${entry.url} (${entry.officials.length} official(s))`);
  }

  if (newJurisdictions > 0) {
    discoveredFile.generated_at = now;
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(DISCOVERED_PATH, JSON.stringify(discoveredFile, null, 2));
  }

  if (promotedOfficials.length > 0) {
    const { states } = await writeShards(promotedOfficials, { publicDir: PUBLIC_OFFICIALS_DIR, now });
    console.log(`Wrote ${promotedOfficials.length} official(s) across ${states.length} state shard(s) at zero LLM cost.`);
  }

  console.log(
    `\nScanned ${scanned} submission(s), promoted ${promoted} (${newJurisdictions} new jurisdiction(s))` +
      (needsReview.length ? `, ${needsReview.length} need a manual look` : "") +
      "."
  );
  for (const r of needsReview) {
    console.log(`  NEEDS REVIEW  ${r.url}${r.note ? ` ("${r.note}")` : ""} — ${r.reason}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Suggested-official submissions`,
      ``,
      `- Scanned **${scanned}**, promoted **${promoted}** (${newJurisdictions} new jurisdiction(s))`,
      ...(needsReview.length
        ? [``, `### Needs a manual look`, ``, ...needsReview.map((r) => `- [${r.url}](${r.url})${r.note ? ` — "${r.note}"` : ""}: ${r.reason}`)]
        : []),
    ];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
}

// Only run when this file is executed directly, not when imported for its exported pure
// functions — see federal-details.js for the same guard and why it's needed.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
