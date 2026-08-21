// Orchestrates one jurisdiction: fetch each seed URL -> extract -> normalize -> dedupe.
// At nationwide scale this same function is called per-jurisdiction by a queue worker;
// here run.js just loops the seed file.

import { fetchPage } from "./fetch.js";
import { extractOfficials, extractOfficialDetail } from "./extract.js";
import { normalize, mergeEnrichment } from "./normalize.js";
import { suggestLinks } from "./suggest.js";
import { findMediaCandidates, stripSharedMedia } from "./media.js";

// Look at the site's homepage for a better candidate URL. Best-effort: never throws.
async function findSuggestions(url, allowBrowser) {
  try {
    const origin = new URL(url).origin;
    const home = await fetchPage(origin, { allowBrowser });
    // home.url, not origin: fetchPage() follows redirects, so the bare origin can itself land
    // elsewhere (see fetch.js's fetchStatic()) — resolving suggestLinks()'s relative hrefs
    // against the pre-redirect origin would suggest a broken URL.
    return home.ok ? suggestLinks(home.html, home.url) : [];
  } catch {
    return [];
  }
}

// Fields the bio-page follow-up tries to fill in — a record still missing at least one of
// these, with a non-null `url` to actually follow, is a candidate for the second pass.
const ENRICHMENT_FIELDS = ["photo_url", "address", "phone", "email", "hours", "bio"];

export function needsEnrichment(record) {
  return ENRICHMENT_FIELDS.some((f) => record[f] == null);
}

// 90 days, matching local-officials.mjs's own hit-cache TTL precedent — a bio page recently
// checked and found to have nothing new isn't worth spending budget on again so soon.
const BIO_RECHECK_MS = 1000 * 60 * 60 * 24 * 90;

export function recentlyChecked(record, now) {
  if (!record.bio_checked_at) return false;
  const age = Date.parse(now) - Date.parse(record.bio_checked_at);
  return Number.isFinite(age) && age < BIO_RECHECK_MS;
}

// Picks which records this run's bio-page follow-up should actually fetch, in order, bounded by
// `budget`. Pure/no I/O so it's unit-testable on its own (see pipeline.test.js) separately from
// the fetch/extract mechanics in enrichFromBioPages() below. Skips: a record with no url to
// follow, one that's already complete (needsEnrichment), one checked too recently
// (recentlyChecked), and — the cross-fetch shared-media guard described on
// enrichFromBioPages() — any url shared by 2+ officials in this batch.
export function selectEnrichmentCandidates(records, { now, budget }) {
  const urlCounts = new Map();
  for (const r of records) {
    if (r.url) urlCounts.set(r.url, (urlCounts.get(r.url) || 0) + 1);
  }
  const candidates = [];
  for (const record of records) {
    if (candidates.length >= budget) break;
    if (!record.url || urlCounts.get(record.url) > 1) continue;
    if (!needsEnrichment(record) || recentlyChecked(record, now)) continue;
    candidates.push(record);
  }
  return candidates;
}

// Bio-page follow-up crawl (the deferred enhancement named in scraper/README.md's "Photos and
// social links" section): for each candidate selected above, fetch their own bio-page `url` and
// run a second, narrower extraction scoped to just them (extractOfficialDetail), then fill in
// whatever the roster page alone couldn't (mergeEnrichment — fills nulls only, never overrides
// what the roster page already found). Budget-capped per jurisdiction per run
// (SCRAPER_ENRICH_BUDGET, default 10) so a large council doesn't blow past a free-tier LLM rate
// limit in one run — a jurisdiction that hits the cap just resumes where it left off next run,
// since a record still missing fields is picked up again automatically.
//
// The shared-url skip in selectEnrichmentCandidates() exists because a bio-page follow-up is
// only trustworthy when the page is actually about one specific person (see
// extractOfficialDetail's prompt) — several officials pointing at the same URL almost always
// means it's a generic page (a "Contact Us" hub, or the roster page itself linked back as
// everyone's "url"), not a personal bio, and extracting a "personal" photo/social from it would
// misattribute one official's data to all of them — the same shared-media problem
// stripSharedMedia() guards against for the roster pass, but that check can't see across two
// separate fetches, so this pass needs its own version of it.
async function enrichFromBioPages(records, { now, allowBrowser }) {
  const budget = Number(process.env.SCRAPER_ENRICH_BUDGET || 10);
  if (budget <= 0) return records;

  const candidates = new Set(selectEnrichmentCandidates(records, { now, budget }));
  if (!candidates.size) return records;

  const enriched = [...records];
  for (let i = 0; i < enriched.length; i++) {
    const record = enriched[i];
    if (!candidates.has(record)) continue;

    const page = await fetchPage(record.url, { allowBrowser }).catch(() => null);
    if (!page?.ok) continue;

    // page.url, not record.url: same fetchPage()-follows-redirects reasoning as the roster pass
    // in scrapeJurisdiction() above — a bio-page url pulled off the roster page can itself
    // redirect elsewhere by the time it's fetched here.
    const media = findMediaCandidates(page.html, page.url);
    let raw;
    try {
      raw = await extractOfficialDetail({
        text: page.text,
        url: page.url,
        name: record.name,
        office: record.office,
        media,
      });
    } catch (err) {
      // A misconfigured/retired provider fails identically on every subsequent call — stop the
      // whole run rather than grinding through the rest of the budget, same as the roster pass.
      if (err?.fatal) throw err;
      continue;
    }
    if (!raw) continue;

    enriched[i] = mergeEnrichment(record, raw, { sourceUrl: page.url, extractedAt: now });
  }
  return enriched;
}

export async function scrapeJurisdiction(jurisdiction, { now, allowBrowser = false }) {
  const results = [];
  const problems = [];

  for (const url of jurisdiction.urls) {
    const page = await fetchPage(url, { allowBrowser });
    if (!page.ok) {
      // browserError explains why the Playwright fallback couldn't rescue a blocked/empty page.
      const detail = page.browserError ? `${page.error}; ${page.browserError}` : page.error;
      problems.push({ url, error: detail, suggestions: await findSuggestions(url, allowBrowser) });
      continue;
    }
    if (page.needsBrowser) {
      // Almost no text and no browser fallback available — flag rather than silently returning
      // nothing, so probe/problems output shows this page needs Playwright installed.
      problems.push({
        url,
        error: page.browserError
          ? `needs-browser (empty static render); ${page.browserError}`
          : "needs-browser (empty static render)",
        suggestions: await findSuggestions(url, allowBrowser),
      });
      continue;
    }

    // page.url, not the seed url above: fetchPage() follows redirects, and a seed URL can itself
    // land on a different domain by the time it's actually fetched (confirmed for Wayne County,
    // MI: waynecounty.com -> waynecountymi.gov — see fetch.js's fetchStatic()). Using the seed url
    // here would resolve this page's relative photo/social/profile links against the wrong base,
    // silently producing broken URLs rather than erroring.
    //
    // Regex-scanned from the raw HTML (fetch.js already stripped tags out of page.text for
    // the LLM) — see media.js for why this is what makes photo_url/social reachable at all.
    const media = findMediaCandidates(page.html, page.url);

    let raw;
    try {
      raw = await extractOfficials({ text: page.text, url: page.url, jurisdiction, media });
    } catch (err) {
      if (err?.fatal) {
        err.jurisdiction = `${jurisdiction.city}, ${jurisdiction.state}`;
        throw err;
      }
      problems.push({ url, error: `extract failed: ${err.message}` });
      continue;
    }

    for (const r of raw) {
      const rec = normalize(r, { jurisdiction, sourceUrl: page.url, extractedAt: now });
      if (rec) results.push(rec);
    }
  }

  // Dedupe by id (same person can appear on multiple seed pages), keep highest confidence.
  const byId = new Map();
  for (const rec of results) {
    const prev = byId.get(rec.id);
    if (!prev || (rec.confidence ?? 0) > (prev.confidence ?? 0)) byId.set(rec.id, rec);
  }
  const deduped = stripSharedMedia([...byId.values()]);

  // Second pass: follow each official's own bio-page url to fill in what the roster page alone
  // didn't show (mainly photos — see enrichFromBioPages()'s comment). enrichFromBioPages()
  // already swallows non-fatal per-official failures itself, so anything reaching this catch is
  // a fatal provider error — annotate it the same way the roster pass above does.
  let officials;
  try {
    officials = await enrichFromBioPages(deduped, { now, allowBrowser });
  } catch (err) {
    err.jurisdiction = `${jurisdiction.city}, ${jurisdiction.state}`;
    throw err;
  }

  return { officials, problems };
}
