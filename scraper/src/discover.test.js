import { test } from "node:test";
import assert from "node:assert/strict";
import { sameOriginNewLinks } from "./discover.js";

const ORIGIN = "https://www.example-city.gov";

test("sameOriginNewLinks() keeps a same-origin link", () => {
  const links = [[`${ORIGIN}/government/city-council`, "City Council"]];
  assert.deepEqual(sameOriginNewLinks(links, ORIGIN, new Set()), [`${ORIGIN}/government/city-council`]);
});

test("sameOriginNewLinks() drops a third-party link — the Ann Arbor regression case", () => {
  // Confirmed against Ann Arbor, MI: its own Instagram account matched suggestLinks()'s
  // keyword scan and got offered as a roster-page candidate before this filter existed.
  const links = [
    [`${ORIGIN}/government/city-council`, "City Council"],
    ["https://instagram.com/cityofannarbor", "Follow us"],
  ];
  assert.deepEqual(sameOriginNewLinks(links, ORIGIN, new Set()), [`${ORIGIN}/government/city-council`]);
});

test("sameOriginNewLinks() drops an already-visited link", () => {
  const already = `${ORIGIN}/government/city-council`;
  const links = [[already, "City Council"], [`${ORIGIN}/government/mayor`, "Mayor"]];
  const visited = new Set([already]);
  assert.deepEqual(sameOriginNewLinks(links, ORIGIN, visited), [`${ORIGIN}/government/mayor`]);
});

test("sameOriginNewLinks() skips an unparseable href instead of throwing", () => {
  const links = [["not a url", "broken"], [`${ORIGIN}/government/mayor`, "Mayor"]];
  assert.deepEqual(sameOriginNewLinks(links, ORIGIN, new Set()), [`${ORIGIN}/government/mayor`]);
});

test("sameOriginNewLinks() tolerates a missing/empty links list", () => {
  assert.deepEqual(sameOriginNewLinks(undefined, ORIGIN, new Set()), []);
  assert.deepEqual(sameOriginNewLinks([], ORIGIN, new Set()), []);
});
