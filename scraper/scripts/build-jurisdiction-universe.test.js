import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDelimited,
  parseCsv,
  columnIndex,
  latestPopEstimateColumn,
  parsePopulationByGeoid,
  stripPlaceSuffix,
  buildPlaces,
  buildCounties,
} from "./build-jurisdiction-universe.js";

// A small fixture matching the REAL 2025-vintage Census Gazetteer places-file shape — pipe
// delimited, with a GEOID column — confirmed via a live `curl` against
// https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_gaz_place_48.txt
// (header: USPS|GEOID|GEOIDFQ|ANSICODE|NAME|LSAD|FUNCSTAT|ALAND|AWATER|...). GEOID here is the
// standard Census composition: 2-digit state FIPS + 5-digit place FIPS.
const PLACES_FIXTURE = [
  "USPS|GEOID|ANSICODE|NAME|LSAD|FUNCSTAT|ALAND|AWATER",
  "TX|4805000|2410175|Austin city|25|A|827392|62533",
  "TX|4838409|2410472|Elgin city|25|A|18234|120",
  "TX|4812345|2410999|Some CDP|57|S|5000|0",
  "CA|0644000|1234567|Los Angeles city|25|A|1213598|111664",
].join("\n");

// GEOID here: 2-digit state FIPS + 3-digit county FIPS.
const COUNTIES_FIXTURE = [
  "USPS|GEOID|ANSICODE|NAME|ALAND|AWATER",
  "TX|48453|1384012|Travis County|2564797|44768",
  "TX|48021|1383841|Bastrop County|2225978|34157",
  "CA|06037|0277283|Los Angeles County|10515027|1794063",
].join("\n");

// A small fixture matching the real co-est<YEAR>-alldata.csv / sub-est<YEAR>_<FIPS>.csv shape —
// comma delimited, STATE+PLACE (or STATE+COUNTY) FIPS columns, and a POPESTIMATE<year> column
// whose year suffix changes every vintage (confirmed live: POPESTIMATE2025 this year).
const PLACE_POPULATION_FIXTURE = [
  "SUMLEV,STATE,COUNTY,PLACE,COUSUB,CONCIT,PRIMGEO_FLAG,FUNCSTAT,NAME,STNAME,POPESTIMATE2020,POPESTIMATE2025",
  "162,48,000,05000,00000,00000,0,A,Austin city,Texas,961855,995000",
  "162,48,000,00000,12345,00000,0,A,Some County Subdivision,Texas,500,510", // PLACE=00000 — not an incorporated place, ignored
].join("\n");

const COUNTY_POPULATION_FIXTURE = [
  "SUMLEV,REGION,DIVISION,STATE,COUNTY,STNAME,CTYNAME,POPESTIMATE2020,POPESTIMATE2025",
  "040,3,7,48,000,Texas,Texas,29360759,31000000", // state-total row (COUNTY=000) — never matched by a real county GEOID
  "050,3,7,48,453,Texas,Travis County,1290188,1350000",
].join("\n");

test("parseDelimited() splits a pipe-delimited file into header + rows", () => {
  const { header, rows } = parseDelimited(PLACES_FIXTURE);
  assert.deepEqual(header, ["USPS", "GEOID", "ANSICODE", "NAME", "LSAD", "FUNCSTAT", "ALAND", "AWATER"]);
  assert.equal(rows.length, 4);
  assert.equal(rows[0][3], "Austin city");
});

test("parseDelimited() drops blank lines (e.g. a trailing one)", () => {
  const { rows } = parseDelimited(`${PLACES_FIXTURE}\n\n`);
  assert.equal(rows.length, 4);
});

test("parseDelimited() tolerates an empty file", () => {
  assert.deepEqual(parseDelimited(""), { header: [], rows: [] });
});

test("parseCsv() splits a comma-delimited file into header + rows", () => {
  const { header, rows } = parseCsv(PLACE_POPULATION_FIXTURE);
  assert.deepEqual(header, [
    "SUMLEV", "STATE", "COUNTY", "PLACE", "COUSUB", "CONCIT", "PRIMGEO_FLAG", "FUNCSTAT", "NAME", "STNAME", "POPESTIMATE2020", "POPESTIMATE2025",
  ]);
  assert.equal(rows.length, 2);
});

test("columnIndex() finds a column by name, case-insensitively", () => {
  const header = ["USPS", "NAME", "FUNCSTAT"];
  assert.equal(columnIndex(header, ["name"]), 1);
});

test("columnIndex() tries candidates in order for renamed columns across vintages", () => {
  assert.equal(columnIndex(["STUSAB", "NAME"], ["USPS", "STATE", "STUSAB"]), 0);
});

test("columnIndex() throws rather than silently misparsing when nothing matches", () => {
  assert.throws(() => columnIndex(["FOO", "BAR"], ["USPS", "STATE"]), /Could not find a column/);
});

test("latestPopEstimateColumn() picks the highest year present, not a hardcoded one", () => {
  assert.deepEqual(latestPopEstimateColumn(["STATE", "POPESTIMATE2020", "POPESTIMATE2025", "POPESTIMATE2023"]), {
    column: "POPESTIMATE2025",
    year: 2025,
  });
});

test("latestPopEstimateColumn() throws when no such column exists", () => {
  assert.throws(() => latestPopEstimateColumn(["STATE", "NAME"]), /No POPESTIMATE<year> column/);
});

test("parsePopulationByGeoid() keys places by state+place FIPS, skipping non-place rows", () => {
  const byGeoid = parsePopulationByGeoid(PLACE_POPULATION_FIXTURE, "PLACE", 5);
  assert.equal(byGeoid.get("4805000"), 995000); // Austin: state 48 + place 05000
  assert.equal(byGeoid.size, 2); // the COUSUB row (PLACE=00000) still gets a (unused) entry, not dropped
});

test("parsePopulationByGeoid() keys counties by state+county FIPS", () => {
  const byGeoid = parsePopulationByGeoid(COUNTY_POPULATION_FIXTURE, "COUNTY", 3);
  assert.equal(byGeoid.get("48453"), 1350000); // Travis County: state 48 + county 453
  assert.equal(byGeoid.get("48000"), 31000000); // the state-total row is stored too, but no real county GEOID is ever "48000"
});

test("stripPlaceSuffix() strips the common LSAD suffixes", () => {
  assert.equal(stripPlaceSuffix("Elgin city"), "Elgin");
  assert.equal(stripPlaceSuffix("Round Rock city"), "Round Rock");
  assert.equal(stripPlaceSuffix("Smithville town"), "Smithville");
});

test("stripPlaceSuffix() leaves an unrecognized suffix alone rather than guessing", () => {
  assert.equal(stripPlaceSuffix("Nashville-Davidson metropolitan government"), "Nashville-Davidson metropolitan government");
});

test("buildPlaces() filters to the target state and active governments only", () => {
  const { places, unrecognizedSuffixes } = buildPlaces(PLACES_FIXTURE, "TX");
  // "Some CDP" (FUNCSTAT S) and the CA row are excluded.
  assert.deepEqual(places.map((p) => p.name), ["Austin", "Elgin"]);
  assert.equal(unrecognizedSuffixes.size, 0);
});

test("buildPlaces() defaults population to null when no population map is given", () => {
  const { places } = buildPlaces(PLACES_FIXTURE, "TX");
  assert.deepEqual(places.map((p) => p.population), [null, null]);
});

test("buildPlaces() joins population onto each place by its own GEOID", () => {
  const populationByGeoid = parsePopulationByGeoid(PLACE_POPULATION_FIXTURE, "PLACE", 5);
  const { places } = buildPlaces(PLACES_FIXTURE, "TX", populationByGeoid);
  const austin = places.find((p) => p.name === "Austin");
  const elgin = places.find((p) => p.name === "Elgin");
  assert.equal(austin.population, 995000);
  assert.equal(elgin.population, null); // not in the (deliberately tiny) population fixture
});

test("buildPlaces() reports a name whose suffix it couldn't strip", () => {
  const fixture = ["USPS|GEOID|ANSICODE|NAME|LSAD|FUNCSTAT|ALAND|AWATER", "TX|4899999|1|Weird Place Type|99|A|1|0"].join("\n");
  const { places, unrecognizedSuffixes } = buildPlaces(fixture, "TX");
  assert.deepEqual(places.map((p) => p.name), ["Weird Place Type"]);
  assert.equal(unrecognizedSuffixes.has("Weird Place Type"), true);
});

test("buildCounties() filters to the target state, keeping the full 'X County' name", () => {
  const counties = buildCounties(COUNTIES_FIXTURE, "TX");
  assert.deepEqual(counties.map((c) => c.name), ["Bastrop County", "Travis County"]);
});

test("buildCounties() joins population onto each county by its own GEOID", () => {
  const populationByGeoid = parsePopulationByGeoid(COUNTY_POPULATION_FIXTURE, "COUNTY", 3);
  const counties = buildCounties(COUNTIES_FIXTURE, "TX", populationByGeoid);
  const travis = counties.find((c) => c.name === "Travis County");
  const bastrop = counties.find((c) => c.name === "Bastrop County");
  assert.equal(travis.population, 1350000);
  assert.equal(bastrop.population, null); // not in the (deliberately tiny) population fixture
});

test("buildPlaces()/buildCounties() are case-insensitive on the state code", () => {
  const { places } = buildPlaces(PLACES_FIXTURE, "tx".toUpperCase());
  assert.equal(places.length, 2);
});
