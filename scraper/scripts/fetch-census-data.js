// Downloads the Census Gazetteer + Population Estimates Program files for one or more states and
// builds/refreshes scraper/data/jurisdictions/<STATE>.json (via build-jurisdiction-universe.js's
// writeJurisdictionUniverse()) — the network half that script's own CLI mode deliberately doesn't
// do itself (see its header comment).
//
// This is meant to run in GitHub Actions (discover-jurisdictions.yml), not in an arbitrary dev
// sandbox: census.gov is unreachable from the environment this was originally written in, so the
// URL *shape* below was confirmed with a live `curl` from a machine that COULD reach it, not
// guessed. Census updates its data on its own schedule (a new Gazetteer year each fall; a new
// Population Estimates vintage folder each spring), which would make a hardcoded year eventually
// 404 — so unless GAZETTEER_YEAR/POPEST_VINTAGE are explicitly pinned (env var or repo variable),
// this script auto-detects the latest published one each run by listing the parent directory
// (detectLatestGazetteerYear()/detectLatestPopestVintage() below) — the exact technique used to
// confirm the URL shape by hand in the first place, now automated so nobody has to remember to
// bump a year annually. Listing the directory isn't proof the folder is actually populated,
// though — confirmed live on 2026-08-21, where a "2026_Gazetteer/" link was already listed but
// every per-state file inside it 404'd — so each candidate is probed against one small real file
// before being trusted, falling back to the next-older listed candidate first and only to the
// last-confirmed-good vintage if every listed one is unpopulated or detection itself fails
// (network hiccup, or Census restructuring the directory layout entirely).
//
// Usage:
//   DISCOVER_STATES=TX,CA node scripts/fetch-census-data.js
//   GAZETTEER_YEAR=2026 POPEST_VINTAGE=2020-2026 DISCOVER_STATES=TX node scripts/fetch-census-data.js  # pin instead of auto-detect

import { fileURLToPath } from "node:url";
import { stateFips, resolveStateList } from "../src/stateFips.js";
import { writeJurisdictionUniverse } from "./build-jurisdiction-universe.js";

// Last-confirmed-good vintage (via a live `curl` — see this file's header comment), used only
// when auto-detection itself fails; auto-detection is otherwise what actually picks the year.
const FALLBACK_GAZETTEER_YEAR = "2025";
const FALLBACK_POPEST_VINTAGE = "2020-2025";

const GAZETTEER_BASE = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer";
const POPEST_BASE = "https://www2.census.gov/programs-surveys/popest/datasets";

// Population files are named by the vintage's own end year (e.g. co-est2025-alldata.csv lives in
// the "2020-2025" folder) — deriving it from the vintage string instead of taking it as a
// separate config removes one more value that could drift out of sync with the other.
export function popestYearFromVintage(popestVintage) {
  const end = (popestVintage || "").split("-")[1];
  if (!/^\d{4}$/.test(end || "")) throw new Error(`Could not derive a year from popestVintage "${popestVintage}"`);
  return end;
}

// Pure URL construction, kept separate from the actual fetch() calls below so it's unit-testable
// without network mocking (see fetch-census-data.test.js) — the same split this codebase uses
// throughout (e.g. selectScrapeCandidates() vs. loadLastScrapedByKey() in run.js).
export function censusUrlsForState(state, { gazetteerYear, popestVintage }) {
  const fips = stateFips(state);
  if (!fips) throw new Error(`Unknown state code "${state}" (no FIPS mapping in src/stateFips.js)`);
  const popestYear = popestYearFromVintage(popestVintage);
  return {
    places: `${GAZETTEER_BASE}/${gazetteerYear}_Gazetteer/${gazetteerYear}_gaz_place_${fips}.txt`,
    counties: `${GAZETTEER_BASE}/${gazetteerYear}_Gazetteer/${gazetteerYear}_gaz_counties_${fips}.txt`,
    placePopulation: `${POPEST_BASE}/${popestVintage}/cities/totals/sub-est${popestYear}_${fips}.csv`,
  };
}

export function countyPopulationUrl({ popestVintage }) {
  return `${POPEST_BASE}/${popestVintage}/counties/totals/co-est${popestYearFromVintage(popestVintage)}-alldata.csv`;
}

async function fetchText(url, { required = true } = {}) {
  const res = await fetch(url);
  if (!res.ok) {
    if (!required) return null;
    throw new Error(`GET ${url} -> HTTP ${res.status}`);
  }
  return res.text();
}

// Parses "<year>_Gazetteer/" directory-listing links out of an index page's HTML — the same
// pattern confirmed live via `curl .../gazetteer/ | grep -oE 'href="[0-9]{4}_Gazetteer/"'` when
// this script was first written. Pure/no I/O so it's unit-testable on its own.
export function parseGazetteerYears(html) {
  return [...(html || "").matchAll(/href="(\d{4})_Gazetteer\/"/g)].map((m) => Number(m[1]));
}

// Parses "<start>-<end>/" vintage-folder links out of the Population Estimates datasets index
// page — same live-confirmed pattern as parseGazetteerYears() above.
export function parsePopestVintages(html) {
  return [...(html || "").matchAll(/href="(\d{4})-(\d{4})\/"/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
}

// Confirms a URL actually resolves to real content, used to verify a candidate Gazetteer year or
// population-estimates vintage is genuinely populated before trusting it — a directory listing
// only proves the folder link exists, not that files have been uploaded into it yet (see
// detectLatestGazetteerYear()'s header comment for the real case this was written for). A HEAD
// request is enough and cheaper than downloading the body, but falls back to a real GET for any
// server that doesn't support HEAD on static files (405/501) rather than misreading that as
// "missing".
async function urlExists(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (res.ok) return true;
    if (res.status === 405 || res.status === 501) return (await fetch(url)).ok;
    return false;
  } catch {
    return false;
  }
}

// Finds the newest Gazetteer year actually populated right now, instead of trusting a hardcoded
// one that will eventually go stale. Walks every listed year newest-first, probing Rhode Island's
// place file (small, always present for a real vintage) so a listed-but-empty folder falls
// through to the next-older listed year instead of being trusted outright. Falls back to
// `fallback` only once every listed year has failed the probe, or on any failure to list/parse
// the directory at all (network error, or an index page whose format this can't parse), so a
// transient hiccup degrades gracefully rather than blocking every state's discovery.
export async function detectLatestGazetteerYear(fallback) {
  try {
    const html = await fetchText(`${GAZETTEER_BASE}/`);
    const years = parseGazetteerYears(html);
    if (!years.length) throw new Error("no year folders found in directory listing");
    const candidates = [...new Set(years)].sort((a, b) => b - a);
    for (const year of candidates) {
      if (await urlExists(`${GAZETTEER_BASE}/${year}_Gazetteer/${year}_gaz_place_44.txt`)) return String(year);
      console.log(`${year}_Gazetteer/ is listed but not yet populated (Rhode Island probe file missing) — trying an older year.`);
    }
    throw new Error("no listed year folder has a populated probe file");
  } catch (err) {
    console.log(`Could not auto-detect the latest Gazetteer year (${err.message}) — using ${fallback}.`);
    return fallback;
  }
}

// Same idea for the Population Estimates vintage folder — walks candidates newest-end-year-first
// (vintage folders are named "<first year still in the file>-<latest year>", e.g. "2020-2025"; a
// new vintage always extends the end year, sometimes also bumping the start), probing the one
// national county population file (fetched once per run anyway, via countyPopulationUrl()) before
// trusting a candidate, for the same listed-but-not-yet-populated reason as the Gazetteer year
// above.
export async function detectLatestPopestVintage(fallback) {
  try {
    const html = await fetchText(`${POPEST_BASE}/`);
    const vintages = parsePopestVintages(html);
    if (!vintages.length) throw new Error("no vintage folders found in directory listing");
    const candidates = [...vintages].sort((a, b) => b.end - a.end);
    for (const { start, end } of candidates) {
      const vintage = `${start}-${end}`;
      if (await urlExists(countyPopulationUrl({ popestVintage: vintage }))) return vintage;
      console.log(`${vintage}/ is listed but not yet populated (county population probe file missing) — trying an older vintage.`);
    }
    throw new Error("no listed vintage folder has a populated probe file");
  } catch (err) {
    console.log(`Could not auto-detect the latest population-estimates vintage (${err.message}) — using ${fallback}.`);
    return fallback;
  }
}

export async function fetchCensusDataForState(state, { gazetteerYear, popestVintage, countyPopulationText }) {
  const urls = censusUrlsForState(state, { gazetteerYear, popestVintage });

  const [placesText, countiesText, placePopulationText] = await Promise.all([
    fetchText(urls.places),
    fetchText(urls.counties),
    // Population is an enhancement, not a requirement for discovery to work at all — a fetch
    // failure here degrades to population: null for this state (still discoverable, just
    // unweighted) rather than aborting the whole state.
    fetchText(urls.placePopulation, { required: false }),
  ]);

  await writeJurisdictionUniverse({ state, placesText, countiesText, placePopulationText, countyPopulationText });
}

async function main() {
  const states = resolveStateList(process.env.DISCOVER_STATES);

  // GAZETTEER_YEAR/POPEST_VINTAGE (env var or repo variable) pin a specific vintage when set —
  // useful for testing, or to roll back if a freshly-published vintage turns out broken. Left
  // unset (the default), this auto-detects the latest one published right now, so nobody has to
  // remember to bump a year annually — see this file's own header comment.
  const gazetteerYear = process.env.GAZETTEER_YEAR || (await detectLatestGazetteerYear(FALLBACK_GAZETTEER_YEAR));
  const popestVintage = process.env.POPEST_VINTAGE || (await detectLatestPopestVintage(FALLBACK_POPEST_VINTAGE));
  console.log(`Using Gazetteer year ${gazetteerYear}, population-estimates vintage ${popestVintage}.`);

  // County population is one national file shared by every state — fetch it once, not once per
  // state, both to be a polite crawler and because it's the same download either way.
  const countyPopUrl = countyPopulationUrl({ popestVintage });
  let countyPopulationText = null;
  try {
    countyPopulationText = await fetchText(countyPopUrl, { required: false });
  } catch (err) {
    console.log(`Could not fetch county population data (${err.message}) — counties will have population: null this run.`);
  }
  if (!countyPopulationText) {
    console.log(`No county population data fetched from ${countyPopUrl} — counties will have population: null this run.`);
  }

  let failures = 0;
  for (const state of states) {
    try {
      await fetchCensusDataForState(state, { gazetteerYear, popestVintage, countyPopulationText });
    } catch (err) {
      failures++;
      console.error(`FAILED ${state}: ${err.message}`);
    }
  }

  if (failures === states.length && states.length > 0) {
    console.error(
      `\nAll ${states.length} state(s) failed even after auto-detecting the vintage — this usually means Census has ` +
        `changed its directory/file layout in a way this script's parsing doesn't handle. See this script's own header comment.`
    );
    process.exitCode = 1;
  } else if (failures > 0) {
    console.log(`\n${failures}/${states.length} state(s) failed; continuing with the rest (see FAILED lines above).`);
  }
}

// Only run when this file is executed directly, not when imported for its exported pure
// functions (fetch-census-data.test.js does exactly that) — see federal-details.js for the same
// guard and why it's needed.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
