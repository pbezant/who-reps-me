import { test } from "node:test";
import assert from "node:assert/strict";
import {
  censusUrlsForState,
  countyPopulationUrl,
  popestYearFromVintage,
  parseGazetteerYears,
  parsePopestVintages,
  detectLatestGazetteerYear,
  detectLatestPopestVintage,
} from "./fetch-census-data.js";

// detectLatestGazetteerYear()/detectLatestPopestVintage() call the bare global `fetch` (both to
// list the parent directory and to probe a candidate before trusting it), so stubbing
// globalThis.fetch here reaches them without any refactor — same pattern as fetch.test.js.
function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

const OPTS = { gazetteerYear: "2025", popestVintage: "2020-2025" };

test("popestYearFromVintage() derives the end year from a vintage string", () => {
  assert.equal(popestYearFromVintage("2020-2025"), "2025");
  assert.equal(popestYearFromVintage("2010-2011"), "2011");
});

test("popestYearFromVintage() throws on a malformed vintage rather than building a bad URL", () => {
  assert.throws(() => popestYearFromVintage("nonsense"), /Could not derive a year/);
  assert.throws(() => popestYearFromVintage(""), /Could not derive a year/);
});

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
  const urls = censusUrlsForState("CA", { gazetteerYear: "2026", popestVintage: "2020-2026" });
  assert.equal(urls.places, "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2026_Gazetteer/2026_gaz_place_06.txt");
  assert.equal(urls.placePopulation, "https://www2.census.gov/programs-surveys/popest/datasets/2020-2026/cities/totals/sub-est2026_06.csv");
});

test("countyPopulationUrl() builds the one shared national county population file", () => {
  assert.equal(
    countyPopulationUrl(OPTS),
    "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/counties/totals/co-est2025-alldata.csv"
  );
});

// Fixtures below wrap the exact href values a live `curl` against
// https://www2.census.gov/geo/docs/maps-data/data/gazetteer/ and
// https://www2.census.gov/programs-surveys/popest/datasets/ actually returned (see this script's
// header comment) in plausible anchor tags — the href strings are confirmed-real, not guessed;
// the surrounding markup is illustrative since parseGazetteerYears()/parsePopestVintages() only
// look at href="..." substrings regardless of the tag they sit in.
const GAZETTEER_INDEX_HTML = `
<a href="2023_Gazetteer/">2023_Gazetteer/</a>
<a href="2024_Gazetteer/">2024_Gazetteer/</a>
<a href="2025_Gazetteer/">2025_Gazetteer/</a>
`;

const POPEST_INDEX_HTML = `
<a href="2010-2019/">2010-2019/</a>
<a href="2010-2020/">2010-2020/</a>
<a href="2020-2024/">2020-2024/</a>
<a href="2020-2025/">2020-2025/</a>
`;

test("parseGazetteerYears() extracts every year folder from a directory listing", () => {
  assert.deepEqual(parseGazetteerYears(GAZETTEER_INDEX_HTML), [2023, 2024, 2025]);
});

test("parseGazetteerYears() tolerates unrelated links mixed in (site nav, etc.)", () => {
  const html = `<a href="https://www.census.gov/main/css/base.css">x</a>${GAZETTEER_INDEX_HTML}`;
  assert.deepEqual(parseGazetteerYears(html), [2023, 2024, 2025]);
});

test("parsePopestVintages() extracts every vintage folder with its start/end years", () => {
  assert.deepEqual(parsePopestVintages(POPEST_INDEX_HTML), [
    { start: 2010, end: 2019 },
    { start: 2010, end: 2020 },
    { start: 2020, end: 2024 },
    { start: 2020, end: 2025 },
  ]);
});

// Regression coverage for the 2026-08-21 incident: Census had already listed "2026_Gazetteer/" in
// the directory index, but every per-state file inside it 404'd (the folder was created before
// being populated) — detectLatestGazetteerYear() must probe a candidate before trusting it, not
// just trust whatever's newest in the listing.
function fakeRes(status, body = "") {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

const GAZETTEER_INDEX_WITH_UNPOPULATED_YEAR = `
<a href="2024_Gazetteer/">2024_Gazetteer/</a>
<a href="2025_Gazetteer/">2025_Gazetteer/</a>
<a href="2026_Gazetteer/">2026_Gazetteer/</a>
`;

test("detectLatestGazetteerYear() trusts the newest listed year when its probe file exists", async () => {
  const restore = stubFetch(async (url, opts) => {
    if (url.endsWith("/gazetteer/")) return fakeRes(200, GAZETTEER_INDEX_HTML);
    if (opts?.method === "HEAD" && url.endsWith("2025_Gazetteer/2025_gaz_place_44.txt")) return fakeRes(200);
    return fakeRes(404);
  });
  try {
    assert.equal(await detectLatestGazetteerYear("2020"), "2025");
  } finally {
    restore();
  }
});

test("detectLatestGazetteerYear() falls through to an older listed year when the newest is listed but not yet populated", async () => {
  const restore = stubFetch(async (url, opts) => {
    if (url.endsWith("/gazetteer/")) return fakeRes(200, GAZETTEER_INDEX_WITH_UNPOPULATED_YEAR);
    if (opts?.method === "HEAD" && url.endsWith("2026_Gazetteer/2026_gaz_place_44.txt")) return fakeRes(404);
    if (opts?.method === "HEAD" && url.endsWith("2025_Gazetteer/2025_gaz_place_44.txt")) return fakeRes(200);
    return fakeRes(404);
  });
  try {
    assert.equal(await detectLatestGazetteerYear("2020"), "2025");
  } finally {
    restore();
  }
});

test("detectLatestGazetteerYear() falls back to the fallback value when every listed year fails its probe", async () => {
  const restore = stubFetch(async (url) => {
    if (url.endsWith("/gazetteer/")) return fakeRes(200, `<a href="2026_Gazetteer/">2026_Gazetteer/</a>`);
    return fakeRes(404);
  });
  try {
    assert.equal(await detectLatestGazetteerYear("2025"), "2025");
  } finally {
    restore();
  }
});

test("detectLatestGazetteerYear() falls back to the fallback value when the directory listing itself fails", async () => {
  const restore = stubFetch(async () => {
    throw new Error("network down");
  });
  try {
    assert.equal(await detectLatestGazetteerYear("2025"), "2025");
  } finally {
    restore();
  }
});

test("detectLatestGazetteerYear() treats a HEAD 405 as unsupported and retries the probe with GET", async () => {
  const restore = stubFetch(async (url, opts) => {
    if (url.endsWith("/gazetteer/")) return fakeRes(200, `<a href="2025_Gazetteer/">2025_Gazetteer/</a>`);
    if (url.endsWith("2025_Gazetteer/2025_gaz_place_44.txt")) return fakeRes(opts?.method === "HEAD" ? 405 : 200);
    return fakeRes(404);
  });
  try {
    assert.equal(await detectLatestGazetteerYear("2020"), "2025");
  } finally {
    restore();
  }
});

const POPEST_INDEX_WITH_UNPOPULATED_VINTAGE = `
<a href="2020-2024/">2020-2024/</a>
<a href="2020-2025/">2020-2025/</a>
<a href="2020-2026/">2020-2026/</a>
`;

test("detectLatestPopestVintage() trusts the newest listed vintage when its probe file exists", async () => {
  const restore = stubFetch(async (url, opts) => {
    if (url.endsWith("/datasets/")) return fakeRes(200, POPEST_INDEX_HTML);
    if (opts?.method === "HEAD" && url.endsWith("2020-2025/counties/totals/co-est2025-alldata.csv")) return fakeRes(200);
    return fakeRes(404);
  });
  try {
    assert.equal(await detectLatestPopestVintage("2020-2020"), "2020-2025");
  } finally {
    restore();
  }
});

test("detectLatestPopestVintage() falls through to an older listed vintage when the newest is listed but not yet populated", async () => {
  const restore = stubFetch(async (url, opts) => {
    if (url.endsWith("/datasets/")) return fakeRes(200, POPEST_INDEX_WITH_UNPOPULATED_VINTAGE);
    if (opts?.method === "HEAD" && url.endsWith("2020-2026/counties/totals/co-est2026-alldata.csv")) return fakeRes(404);
    if (opts?.method === "HEAD" && url.endsWith("2020-2025/counties/totals/co-est2025-alldata.csv")) return fakeRes(200);
    return fakeRes(404);
  });
  try {
    assert.equal(await detectLatestPopestVintage("2020-2020"), "2020-2025");
  } finally {
    restore();
  }
});

test("detectLatestPopestVintage() falls back to the fallback value when every listed vintage fails its probe", async () => {
  const restore = stubFetch(async (url) => {
    if (url.endsWith("/datasets/")) return fakeRes(200, `<a href="2020-2026/">2020-2026/</a>`);
    return fakeRes(404);
  });
  try {
    assert.equal(await detectLatestPopestVintage("2020-2025"), "2020-2025");
  } finally {
    restore();
  }
});
