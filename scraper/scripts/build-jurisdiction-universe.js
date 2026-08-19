// Builds scraper/data/jurisdictions/<STATE>.json — the "universe" of incorporated places and
// counties in one state, each carrying a population figure, used by discover-jurisdictions.js
// to know which jurisdictions to consider for auto-discovery (beyond whatever's already
// hand-seeded in config/seeds.json) and in what order — population-weighted, biggest first (see
// selectDiscoveryCandidates() in discover-jurisdictions.js).
//
// Sources: the US Census Bureau's annual Gazetteer Files (place/county names+GEOIDs) and its
// Population Estimates Program (POPESTIMATE by GEOID) — both public domain, no key:
//   https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html
//   https://www.census.gov/programs-surveys/popest/data/data-sets.html
//
// This script does NOT fetch anything itself — scripts/fetch-census-data.js does the network
// part (see that file's header for why the two are split) and calls this file's exported
// buildPlaces()/buildCounties() directly; this file's own CLI mode below is for local/manual use
// against already-downloaded files.
//
// Local usage:
//   node scripts/build-jurisdiction-universe.js TX \
//     --places /path/to/2025_gaz_place_48.txt --counties /path/to/2025_gaz_counties_48.txt \
//     [--place-population /path/to/sub-est2025_48.csv] [--county-population /path/to/co-est2025-alldata.csv]
// (population files are optional — omit either/both to get places/counties with population: null)
//
// What this does:
//   - Reads each Gazetteer file's header row and looks up columns BY NAME rather than a fixed
//     position, so a column-order change across years doesn't silently misparse — an
//     unrecognized header instead fails loudly (see columnIndex()). Confirmed live against the
//     2025 vintage: the place/county files are PIPE-delimited ("USPS|GEOID|GEOIDFQ|ANSICODE|
//     NAME|LSAD|FUNCSTAT|ALAND|..."), not tab-delimited as an earlier, never-live-verified
//     version of this script assumed.
//   - Places: keeps only rows for the target state AND FUNCSTAT === "A" (an active incorporated
//     government — excludes Census-only statistical areas/CDPs, which have no city council to
//     discover). Strips the trailing legal/statistical suffix Census appends to NAME ("Elgin
//     city" -> "Elgin") to match config/seeds.json's bare-name convention.
//   - Counties: keeps only rows for the target state. County NAME already includes its own
//     suffix ("Travis County"), matching seeds.json's own `"<Name> County"` convention, so no
//     stripping needed there.
//   - Population: each Gazetteer row's own GEOID (2-digit state FIPS + 5-digit place FIPS, or
//     2-digit state FIPS + 3-digit county FIPS — a stable Census identifier convention, not a
//     yearly-changing detail) is looked up directly against a population CSV's STATE+PLACE (or
//     STATE+COUNTY) columns concatenated the same way — see parsePopulationByGeoid(). A place/
//     county with no match (the population file only lists a subset — e.g. very new
//     incorporations) gets population: null rather than being dropped, so it's still
//     discoverable, just deprioritized by selectDiscoveryCandidates()'s population sort.
//   - Writes scraper/data/jurisdictions/<STATE>.json: { state, generated_at, places, counties },
//     each an array of { name, population }, sorted alphabetically by name (population-order
//     sorting happens at discovery-candidate-selection time, not here) — committed reference
//     data.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stateFips } from "../src/stateFips.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "data", "jurisdictions");

// Census Gazetteer files are pipe-delimited (confirmed live against the 2025 vintage — see this
// script's header comment). Blank lines (a trailing one is common) are dropped; every cell is
// trimmed defensively since some vintages pad fixed-width-looking columns with trailing
// whitespace even in the delimited release.
export function parseDelimited(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split("|").map((h) => h.trim());
  const rows = lines.slice(1).map((line) => line.split("|").map((c) => c.trim()));
  return { header, rows };
}

// Census population-estimates files (co-est<YEAR>-alldata.csv, sub-est<YEAR>_<FIPS>.csv) are
// plain comma-delimited CSVs with no embedded commas/quoting in the columns this script reads
// (all-numeric FIPS codes and POPESTIMATE figures) — a full CSV parser (quote/escape handling)
// isn't needed for those, so this stays a simple split like parseDelimited() above.
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((line) => line.split(",").map((c) => c.trim()));
  return { header, rows };
}

// Finds a column by name (case-insensitive), trying each candidate in order — Census has used
// slightly different header spellings across vintages (e.g. "USPS" vs "STUSAB"). Throws rather
// than returning -1: a caller silently indexing into the wrong column would corrupt every row
// instead of failing once, obviously, up front.
export function columnIndex(header, candidates) {
  const lower = header.map((h) => h.toLowerCase());
  for (const name of candidates) {
    const i = lower.indexOf(name.toLowerCase());
    if (i !== -1) return i;
  }
  throw new Error(`Could not find a column matching any of [${candidates.join(", ")}] in header: ${header.join(", ")}`);
}

// Census renames its population-estimate column every vintage (POPESTIMATE2025 this year,
// POPESTIMATE2026 next) — scanning for the highest year present avoids hardcoding one that would
// silently stop matching (columnIndex() throwing) once Census publishes a new vintage.
export function latestPopEstimateColumn(header) {
  const years = header
    .map((h) => /^POPESTIMATE(\d{4})$/.exec(h))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  if (!years.length) {
    throw new Error(`No POPESTIMATE<year> column found in header: ${header.join(", ")}`);
  }
  const year = Math.max(...years);
  return { column: `POPESTIMATE${year}`, year };
}

// Builds a GEOID -> population Map from a Census population-estimates CSV. `geoColumn` is
// "COUNTY" for the county file (co-est*.csv) or "PLACE" for the place file (sub-est*.csv); each
// row's key is built the same way a Gazetteer row's own GEOID is composed — 2-digit state FIPS
// immediately followed by the geographic code (3-digit county / 5-digit place) — so
// buildPlaces()/buildCounties() can join population on by looking up a Gazetteer row's GEOID
// directly, no separate join logic needed on that side. FIPS codes are zero-padded defensively
// in case a cell lost its leading zeros somewhere upstream.
export function parsePopulationByGeoid(csvText, geoColumn, geoWidth) {
  const { header, rows } = parseCsv(csvText);
  const stateIdx = columnIndex(header, ["STATE"]);
  const geoIdx = columnIndex(header, [geoColumn]);
  const { column: popColumn } = latestPopEstimateColumn(header);
  const popIdx = columnIndex(header, [popColumn]);

  const byGeoid = new Map();
  for (const r of rows) {
    const state = (r[stateIdx] || "").padStart(2, "0");
    const geo = (r[geoIdx] || "").padStart(geoWidth, "0");
    const pop = Number(r[popIdx]);
    if (state.length === 2 && geo.length === geoWidth && Number.isFinite(pop)) {
      byGeoid.set(`${state}${geo}`, pop);
    }
  }
  return byGeoid;
}

// Census's place NAME carries a trailing legal/statistical descriptor ("Elgin city", "Round
// Rock city") that needs stripping to match config/seeds.json's bare-name convention and the
// frontend's normalizePlace() (src/geocode.js). Covers the common LSAD suffixes; an
// unrecognized one is left as-is (the caller logs these) rather than mangled by a guess.
const PLACE_SUFFIXES = [/ city$/i, / town$/i, / village$/i, / borough$/i, / CDP$/i, / municipality$/i, / \(balance\)$/i];

export function stripPlaceSuffix(name) {
  for (const re of PLACE_SUFFIXES) {
    if (re.test(name)) return name.replace(re, "").trim();
  }
  return name;
}

export function buildPlaces(placesText, state, populationByGeoid = new Map()) {
  const { header, rows } = parseDelimited(placesText);
  const usIdx = columnIndex(header, ["USPS", "STATE", "STUSAB"]);
  const nameIdx = columnIndex(header, ["NAME"]);
  const funcIdx = columnIndex(header, ["FUNCSTAT"]);
  const geoidIdx = columnIndex(header, ["GEOID"]);

  const unrecognizedSuffixes = new Set();
  const places = rows
    .filter((r) => r[usIdx]?.toUpperCase() === state && r[funcIdx] === "A")
    .map((r) => {
      const raw = r[nameIdx];
      const stripped = stripPlaceSuffix(raw);
      if (stripped === raw) unrecognizedSuffixes.add(raw);
      const population = populationByGeoid.get(r[geoidIdx]) ?? null;
      return { name: stripped, population };
    })
    .filter((p) => p.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { places, unrecognizedSuffixes };
}

export function buildCounties(countiesText, state, populationByGeoid = new Map()) {
  const { header, rows } = parseDelimited(countiesText);
  const usIdx = columnIndex(header, ["USPS", "STATE", "STUSAB"]);
  const nameIdx = columnIndex(header, ["NAME"]);
  const geoidIdx = columnIndex(header, ["GEOID"]);

  const counties = rows
    .filter((r) => r[usIdx]?.toUpperCase() === state)
    .map((r) => ({ name: r[nameIdx], population: populationByGeoid.get(r[geoidIdx]) ?? null }))
    .filter((c) => c.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  return counties;
}

// Builds and writes scraper/data/jurisdictions/<STATE>.json from already-read file contents —
// the part shared between this file's own CLI mode (reads local files) and
// fetch-census-data.js's network mode (downloads them), so the two never duplicate the actual
// join/write logic.
export async function writeJurisdictionUniverse({ state, placesText, countiesText, placePopulationText, countyPopulationText }) {
  const placePopulationByGeoid = placePopulationText ? parsePopulationByGeoid(placePopulationText, "PLACE", 5) : new Map();
  const countyPopulationByGeoid = countyPopulationText ? parsePopulationByGeoid(countyPopulationText, "COUNTY", 3) : new Map();

  const { places, unrecognizedSuffixes } = buildPlaces(placesText, state, placePopulationByGeoid);
  const counties = buildCounties(countiesText, state, countyPopulationByGeoid);

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `${state}.json`);
  const generated_at = new Date().toISOString();
  await writeFile(outPath, JSON.stringify({ state, generated_at, places, counties }, null, 2));

  const placesMatched = places.filter((p) => p.population != null).length;
  const countiesMatched = counties.filter((c) => c.population != null).length;
  console.log(
    `Wrote ${places.length} places (${placesMatched} with population) + ${counties.length} counties ` +
      `(${countiesMatched} with population) for ${state} to ${outPath}`
  );
  if (placePopulationText && places.length && placesMatched / places.length < 0.5) {
    console.log(
      `WARNING: fewer than half of ${state}'s places matched a population figure — the GEOID join may be` +
        ` broken (mismatched vintage year between the Gazetteer and population files?). Spot-check before trusting this file.`
    );
  }
  if (unrecognizedSuffixes.size) {
    const list = [...unrecognizedSuffixes].sort();
    console.log(`\n${list.length} place name(s) had no recognized suffix to strip (kept as-is) — spot-check before trusting the file:`);
    for (const name of list.slice(0, 20)) console.log(`  - ${name}`);
    if (list.length > 20) console.log(`  ... and ${list.length - 20} more`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const state = (args[0] || "").toUpperCase();
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  const placesPath = flag("--places");
  const countiesPath = flag("--counties");
  if (!/^[A-Z]{2}$/.test(state) || !stateFips(state) || !placesPath || !countiesPath) {
    console.error(
      "Usage: node scripts/build-jurisdiction-universe.js <STATE> --places <file> --counties <file>" +
        " [--place-population <file>] [--county-population <file>]"
    );
    process.exitCode = 1;
    return;
  }
  const placePopulationPath = flag("--place-population");
  const countyPopulationPath = flag("--county-population");

  const [placesText, countiesText, placePopulationText, countyPopulationText] = await Promise.all([
    readFile(placesPath, "utf8"),
    readFile(countiesPath, "utf8"),
    placePopulationPath ? readFile(placePopulationPath, "utf8") : Promise.resolve(null),
    countyPopulationPath ? readFile(countyPopulationPath, "utf8") : Promise.resolve(null),
  ]);

  await writeJurisdictionUniverse({ state, placesText, countiesText, placePopulationText, countyPopulationText });
}

// Only run when this file is executed directly, not when imported for its exported pure
// functions (build-jurisdiction-universe.test.js does exactly that) — see federal-details.js
// for the same guard and why it's needed.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
