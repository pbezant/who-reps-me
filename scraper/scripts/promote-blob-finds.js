// Promotes on-demand scrape finds into the permanent, git-committed dataset.
//
// netlify/functions/local-officials.mjs already scrapes a jurisdiction the first time anyone
// searches it and caches the result in Netlify Blobs (store "local-officials-ondemand") so a
// repeat search is a cache hit. But per scraper/README.md's own "Dynamic jurisdiction discovery"
// section, that result never reaches config/seeds.discovered.json on its own — it works for
// this app's users, but the batch scraper never sees it, it never gets the 30-day refresh cycle
// discover-jurisdictions.js's own hits get, and Netlify Blobs isn't backed up at all. This script
// closes that gap: every city someone has actually searched and found officials for becomes a
// permanent part of the dataset, exactly like a discover-jurisdictions.js hit.
//
// Each Blobs entry is keyed "STATE/city-slug" and holds { ok, officials, source_url, checked_at,
// error? } — see local-officials.mjs's own cacheKey()/store.setJSON() calls. The slug is lossy
// (lowercased, non-alphanumerics collapsed to "-"), so this deliberately does NOT try to recover
// the city's real name/casing from it. Instead it reads officials[0].jurisdiction.{city,state}
// (the original-cased values normalize.js stamped onto every official record) and infers
// level ("county" vs "local") from officials[0].body, which local-officials.mjs itself sets to
// "<city> Commissioners Court" or "<city> City Council" at scrape time — both are authoritative,
// not reconstructed guesses.
//
// Writes straight into config/seeds.discovered.json's `jurisdictions` array, in exactly the
// shape discover-jurisdictions.js's own hits use, so seeds.js's loadJurisdictions() (and
// everything downstream: run.js's SCRAPER_BUDGET selection, the frontend's shard lookup) treats
// a promoted on-demand find identically to one discover-jurisdictions.js found itself. Skips
// anything already in config/seeds.json (hand-vetted always wins) or already in
// config/seeds.discovered.json (already permanent some other way).
//
// Needs live Netlify credentials — this reads Netlify's own runtime storage, which has no
// filesystem/git access from outside the Netlify site itself:
//   NETLIFY_AUTH_TOKEN   a personal/team API token (User settings -> Applications -> New access token)
//   NETLIFY_SITE_ID      the site's ID (Site configuration -> General -> Site details)
//
// Usage:
//   NETLIFY_AUTH_TOKEN=... NETLIFY_SITE_ID=... node scripts/promote-blob-finds.js

import { getStore } from "@netlify/blobs";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readJsonIfExists, jurisdictionKey, loadJurisdictions, CONFIG_DIR } from "../src/seeds.js";

const STORE_NAME = "local-officials-ondemand";
const DISCOVERED_PATH = join(CONFIG_DIR, "seeds.discovered.json");

// local-officials.mjs sets body to "<city> Commissioners Court" (county) or "<city> City
// Council" (local) at scrape time (see its own jurisdiction object) — normalize.js then stamps
// that exact string onto every official record from that jurisdiction, so reading it back here
// is reading real data, not guessing from the Blobs key's lossy slug.
export function levelFromBody(body) {
  return /commissioners court/i.test(body || "") ? "county" : "local";
}

// Turns one cached Blobs entry into a seeds.discovered.json-shaped jurisdiction, or null if it
// isn't a promotable hit (a cached miss, or a hit missing the fields we need to trust instead of
// guess). Pure so it's directly testable without a live Blobs store.
export function jurisdictionFromEntry(entry, { now } = {}) {
  if (!entry?.ok || !entry.officials?.length) return null;
  const first = entry.officials[0];
  const city = first?.jurisdiction?.city;
  const state = first?.jurisdiction?.state;
  if (!city || !state) return null;
  return {
    city,
    state,
    level: levelFromBody(first.body),
    body: first.body || null,
    urls: [entry.source_url].filter(Boolean),
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
  let skippedBadEntry = 0;

  const { blobs } = await store.list();
  for (const { key } of blobs) {
    scanned++;
    const entry = await store.get(key, { type: "json" }).catch(() => null);
    const j = jurisdictionFromEntry(entry, { now });
    if (!j) {
      if (entry?.ok) skippedBadEntry++; // a real hit we still couldn't trust enough to promote
      continue; // no hit, or a cached miss — nothing to promote
    }

    const jKey = jurisdictionKey(j);
    if (seededKeys.has(jKey) || discoveredKeys.has(jKey)) continue; // already permanent some other way

    discoveredFile.jurisdictions.push(j);
    discoveredKeys.add(jKey);
    promoted++;
    console.log(`  PROMOTED  ${j.city}, ${j.state}: ${j.urls[0] || "(no source url)"} (${entry.officials.length} officials)`);
  }

  if (promoted > 0) {
    discoveredFile.generated_at = now;
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(DISCOVERED_PATH, JSON.stringify(discoveredFile, null, 2));
  }

  console.log(
    `\nScanned ${scanned} cached on-demand result(s), promoted ${promoted} new jurisdiction(s)` +
      (skippedBadEntry ? `, skipped ${skippedBadEntry} hit(s) missing jurisdiction data` : "") +
      ` into ${DISCOVERED_PATH}.`
  );
}

// Only run when this file is executed directly, not when imported for its exported pure
// functions — see federal-details.js for the same guard and why it's needed.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
