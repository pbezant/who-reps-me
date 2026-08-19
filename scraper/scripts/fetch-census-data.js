// Downloads the Census Gazetteer + Population Estimates Program files for one or more states and
// builds/refreshes scraper/data/jurisdictions/<STATE>.json (via build-jurisdiction-universe.js's
// writeJurisdictionUniverse()) — the network half that script's own CLI mode deliberately doesn't
// do itself (see its header comment).
//
// This is meant to run in GitHub Actions (discover-jurisdictions.yml), not in an arbitrary dev
// sandbox: census.gov is unreachable from the environment this was originally written in, so the
// URLs below were confirmed with a live `curl` from a machine that COULD reach it, not guessed —
// but they're still hardcoded to specific data vintages that Census updates on its own schedule
// (a new Gazetteer year each fall; a new Population Estimates vintage folder each spring), so a
// stale value here will eventually 404. When that happens: bump GAZETTEER_YEAR / POPEST_VINTAGE /
// POPEST_YEAR (repo variables — see discover-jurisdictions.yml) rather than editing this file.
// Confirmed vintages as of writing: GAZETTEER_YEAR=2025 (folder .../gazetteer/2025_Gazetteer/,
// files named 2025_gaz_place_<FIPS>.txt), POPEST_VINTAGE=2020-2025 with POPEST_YEAR=2025 (folder
// .../popest/datasets/2020-2025/, files named co-est2025-alldata.csv / sub-est2025_<FIPS>.csv —
// note the population *column* inside those files, POPESTIMATE<year>, is found dynamically by
// latestPopEstimateColumn() regardless of this year value, so getting POPEST_YEAR slightly wrong
// only affects which file gets fetched, not how it's parsed).
//
// Usage:
//   DISCOVER_STATES=TX,CA node scripts/fetch-census-data.js
//   GAZETTEER_YEAR=2026 POPEST_VINTAGE=2020-2026 POPEST_YEAR=2026 DISCOVER_STATES=TX node scripts/fetch-census-data.js

import { fileURLToPath } from "node:url";
import { stateFips } from "../src/stateFips.js";
import { writeJurisdictionUniverse } from "./build-jurisdiction-universe.js";

const GAZETTEER_BASE = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer";
const POPEST_BASE = "https://www2.census.gov/programs-surveys/popest/datasets";

// Pure URL construction, kept separate from the actual fetch() calls below so it's unit-testable
// without network mocking (see fetch-census-data.test.js) — the same split this codebase uses
// throughout (e.g. selectScrapeCandidates() vs. loadLastScrapedByKey() in run.js).
export function censusUrlsForState(state, { gazetteerYear, popestVintage, popestYear }) {
  const fips = stateFips(state);
  if (!fips) throw new Error(`Unknown state code "${state}" (no FIPS mapping in src/stateFips.js)`);
  return {
    places: `${GAZETTEER_BASE}/${gazetteerYear}_Gazetteer/${gazetteerYear}_gaz_place_${fips}.txt`,
    counties: `${GAZETTEER_BASE}/${gazetteerYear}_Gazetteer/${gazetteerYear}_gaz_counties_${fips}.txt`,
    placePopulation: `${POPEST_BASE}/${popestVintage}/cities/totals/sub-est${popestYear}_${fips}.csv`,
  };
}

export function countyPopulationUrl({ popestVintage, popestYear }) {
  return `${POPEST_BASE}/${popestVintage}/counties/totals/co-est${popestYear}-alldata.csv`;
}

async function fetchText(url, { required = true } = {}) {
  const res = await fetch(url);
  if (!res.ok) {
    if (!required) return null;
    throw new Error(`GET ${url} -> HTTP ${res.status}`);
  }
  return res.text();
}

export async function fetchCensusDataForState(state, { gazetteerYear, popestVintage, popestYear, countyPopulationText }) {
  const urls = censusUrlsForState(state, { gazetteerYear, popestVintage, popestYear });

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
  const states = (process.env.DISCOVER_STATES || "TX")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const gazetteerYear = process.env.GAZETTEER_YEAR || "2025";
  const popestVintage = process.env.POPEST_VINTAGE || "2020-2025";
  const popestYear = process.env.POPEST_YEAR || "2025";

  // County population is one national file shared by every state — fetch it once, not once per
  // state, both to be a polite crawler and because it's the same download either way.
  const countyPopUrl = countyPopulationUrl({ popestVintage, popestYear });
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
      await fetchCensusDataForState(state, { gazetteerYear, popestVintage, popestYear, countyPopulationText });
    } catch (err) {
      failures++;
      console.error(`FAILED ${state}: ${err.message}`);
    }
  }

  if (failures === states.length && states.length > 0) {
    console.error(
      `\nAll ${states.length} state(s) failed — likely a stale GAZETTEER_YEAR/POPEST_VINTAGE/POPEST_YEAR ` +
        `(Census may have published a new vintage). See this script's own header comment.`
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
