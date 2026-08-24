import { test } from "node:test";
import assert from "node:assert/strict";
import { congressBillUrl, parseCongressLegislation, mergeCongressActivity } from "./congressVotes.js";

test("congressBillUrl() builds the public congress.gov page for a House bill", () => {
  assert.equal(
    congressBillUrl({ congress: 117, type: "HR", number: 3076 }),
    "https://www.congress.gov/bill/117th-congress/house-bill/3076"
  );
});

test("congressBillUrl() covers every legislation type", () => {
  const cases = [
    ["S", "senate-bill"],
    ["HJRES", "house-joint-resolution"],
    ["SJRES", "senate-joint-resolution"],
    ["HCONRES", "house-concurrent-resolution"],
    ["SCONRES", "senate-concurrent-resolution"],
    ["HRES", "house-resolution"],
    ["SRES", "senate-resolution"],
  ];
  for (const [type, path] of cases) {
    assert.equal(congressBillUrl({ congress: 118, type, number: 1 }), `https://www.congress.gov/bill/118th-congress/${path}/1`);
  }
});

test("congressBillUrl() applies the real ordinal suffix, including the 11/12/13 exception", () => {
  assert.match(congressBillUrl({ congress: 101, type: "HR", number: 1 }), /101st-congress/);
  assert.match(congressBillUrl({ congress: 102, type: "HR", number: 1 }), /102nd-congress/);
  assert.match(congressBillUrl({ congress: 103, type: "HR", number: 1 }), /103rd-congress/);
  assert.match(congressBillUrl({ congress: 111, type: "HR", number: 1 }), /111th-congress/);
  assert.match(congressBillUrl({ congress: 112, type: "HR", number: 1 }), /112th-congress/);
  assert.match(congressBillUrl({ congress: 113, type: "HR", number: 1 }), /113th-congress/);
  assert.match(congressBillUrl({ congress: 118, type: "HR", number: 1 }), /118th-congress/);
  assert.match(congressBillUrl({ congress: 121, type: "HR", number: 1 }), /121st-congress/);
});

test("congressBillUrl() returns an empty string for an unrecognized type or missing fields", () => {
  assert.equal(congressBillUrl({ congress: 118, type: "XX", number: 1 }), "");
  assert.equal(congressBillUrl({ congress: 118, type: "HR" }), "");
  assert.equal(congressBillUrl({ type: "HR", number: 1 }), "");
  assert.equal(congressBillUrl(), "");
});

test("parseCongressLegislation() maps identifier/title/url/action fields and tags the given role", () => {
  const items = [
    {
      congress: 118,
      type: "HR",
      number: 815,
      title: "Some Act of 2024",
      latestAction: { actionDate: "2024-06-01", text: "Passed House" },
    },
  ];
  assert.deepEqual(parseCongressLegislation(items, "Sponsor"), [
    {
      identifier: "HR 815",
      title: "Some Act of 2024",
      url: "https://www.congress.gov/bill/118th-congress/house-bill/815",
      latestActionDate: "2024-06-01",
      latestActionDescription: "Passed House",
      role: "Sponsor",
    },
  ]);
});

test("parseCongressLegislation() drops an entry with neither title nor identifier, tolerates a missing list", () => {
  assert.deepEqual(parseCongressLegislation([{ latestAction: { actionDate: "2024-01-01" } }], "Sponsor"), []);
  assert.deepEqual(parseCongressLegislation(undefined, "Sponsor"), []);
});

test("mergeCongressActivity() combines both lists, most recent action first, and tags role per source", () => {
  const sponsored = [{ type: "HR", number: 1, title: "Older bill", latestAction: { actionDate: "2024-01-01" } }];
  const cosponsored = [{ type: "S", number: 2, title: "Newer bill", latestAction: { actionDate: "2024-06-01" } }];
  const merged = mergeCongressActivity(sponsored, cosponsored);
  assert.equal(merged[0].title, "Newer bill");
  assert.equal(merged[0].role, "Cosponsor");
  assert.equal(merged[1].title, "Older bill");
  assert.equal(merged[1].role, "Sponsor");
});

test("mergeCongressActivity() caps the combined list at 10", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ type: "HR", number: i, title: `Bill ${i}`, latestAction: { actionDate: "2024-01-01" } }));
  const merged = mergeCongressActivity(many, many);
  assert.equal(merged.length, 10);
});
