import { test } from "node:test";
import assert from "node:assert/strict";
import { censusUrlsForState, countyPopulationUrl } from "./fetch-census-data.js";

const OPTS = { gazetteerYear: "2025", popestVintage: "2020-2025", popestYear: "2025" };

test("censusUrlsForState() builds the confirmed-live 2025-vintage URLs for a known state", () => {
  const urls = censusUrlsForState("TX", OPTS);
  assert.equal(urls.places, "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_gaz_place_48.txt");
  assert.equal(urls.counties, "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_gaz_counties_48.txt");
  assert.equal(urls.placePopulation, "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/cities/totals/sub-est2025_48.csv");
});

test("censusUrlsForState() is case-insensitive on the state code", () => {
  const urls = censusUrlsForState("tx", OPTS);
  assert.match(urls.places, /_48\.txt$/);
});

test("censusUrlsForState() throws on a state with no FIPS mapping rather than building a bad URL", () => {
  assert.throws(() => censusUrlsForState("ZZ", OPTS), /Unknown state code/);
});

test("censusUrlsForState() honors a different vintage without code changes", () => {
  const urls = censusUrlsForState("CA", { gazetteerYear: "2026", popestVintage: "2020-2026", popestYear: "2026" });
  assert.equal(urls.places, "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2026_Gazetteer/2026_gaz_place_06.txt");
  assert.equal(urls.placePopulation, "https://www2.census.gov/programs-surveys/popest/datasets/2020-2026/cities/totals/sub-est2026_06.csv");
});

test("countyPopulationUrl() builds the one shared national county population file", () => {
  assert.equal(
    countyPopulationUrl(OPTS),
    "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/counties/totals/co-est2025-alldata.csv"
  );
});
