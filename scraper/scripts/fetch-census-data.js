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
// bump a year annually. If detection itself fails (network hiccup, or Census restructuring the
// directory layout entirely — a real but much rarer risk than "a new year exists"), it falls back
// to the last-confirmed-good vintage and logs why, rather than crashing the run outright.
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

// Finds the newest Gazetteer year actually published right now, instead of trusting a hardcoded
// one that will eventually go stale — falls back to `fallback` on any failure (network error, or
// an index page whose format this can't parse) so a transient hiccup degrades gracefully rather
// than blocking every state's discovery.
export async function detectLatestGazetteerYear(fallback) {
  try {
    const html = await fetchText(`${GAZETTEER_BASE}/`);
    const years = parseGazetteerYears(html);
    if (!years.length) throw new Error("no year folders found in directory listing");
    return String(Math.max(...years));
  } catch (err) {
    console.log(`Could not auto-detect the latest Gazetteer year (${err.message}) — using ${fallback}.`);
    return fallback;
  }
}

// Same idea for the Population Estimates vintage folder — picks the one with the latest end
// year (vintage folders are named "<first year still in the file>-<latest year>", e.g.
// "2020-2025"; a new vintage always extends the end year, sometimes also bumping the start).
export async function detectLatestPopestVintage(fallback) {
  try {
    const html = await fetchText(`${POPEST_BASE}/`);
    const vintages = parsePopestVintages(html);
    if (!vintages.length) throw new Error("no vintage folders found in directory listing");
    const latest = vintages.reduce((a, b) => (b.end > a.end ? b : a));
    return `${latest.start}-${latest.end}`;
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
