import { test } from "node:test";
import assert from "node:assert/strict";
import { isPromotableSubmission, reasonNotPromotable, jurisdictionFromSubmission } from "./promote-url-submissions.js";

function baseEntry(overrides = {}) {
  return {
    url: "https://www.elgintx.com/149/City-Council",
    note: "",
    ok: true,
    is_government_source: true,
    jurisdiction: { city: "Elgin", county: null, state: "TX", level: "local", body: "Elgin City Council" },
    officials: [
      {
        name: "Jane Doe",
        office: "Mayor",
        level: "local",
        body: "Elgin City Council",
        jurisdiction: { city: "Elgin", state: "TX" },
        confidence: 0.95,
      },
    ],
    checked_at: "2026-08-01T00:00:00.000Z",
    promoted: false,
    ...overrides,
  };
}

test("isPromotableSubmission() accepts a confident, government-sourced, local-level submission", () => {
  assert.equal(isPromotableSubmission(baseEntry()), true);
});

test("isPromotableSubmission() rejects a submission not marked ok (fetch/extract failure)", () => {
  assert.equal(isPromotableSubmission(baseEntry({ ok: false })), false);
});

test("isPromotableSubmission() rejects one already promoted", () => {
  assert.equal(isPromotableSubmission(baseEntry({ promoted: true })), false);
});

test("isPromotableSubmission() rejects an empty officials list", () => {
  assert.equal(isPromotableSubmission(baseEntry({ officials: [] })), false);
});

test("isPromotableSubmission() rejects a non-government source", () => {
  assert.equal(isPromotableSubmission(baseEntry({ is_government_source: false })), false);
});

test("isPromotableSubmission() rejects state/federal level (out of this dataset's scope)", () => {
  const entry = baseEntry();
  entry.officials[0].level = "federal";
  assert.equal(isPromotableSubmission(entry), false);
});

test("isPromotableSubmission() rejects an unresolved jurisdiction", () => {
  const entry = baseEntry();
  entry.officials[0].jurisdiction = { city: null, state: null };
  assert.equal(isPromotableSubmission(entry), false);
});

test("isPromotableSubmission() rejects when every official is below the confidence floor", () => {
  const entry = baseEntry();
  entry.officials[0].confidence = 0.3;
  assert.equal(isPromotableSubmission(entry), false);
});

test("isPromotableSubmission() accepts when at least one of several officials clears the floor", () => {
  const entry = baseEntry();
  entry.officials.push({ ...entry.officials[0], name: "Low Confidence Guy", confidence: 0.1 });
  assert.equal(isPromotableSubmission(entry), true);
});

test("reasonNotPromotable() explains a fetch/extract failure", () => {
  assert.match(reasonNotPromotable(baseEntry({ ok: false, error: "HTTP 404" })), /couldn't load/i);
});

test("reasonNotPromotable() explains a non-government source", () => {
  assert.match(reasonNotPromotable(baseEntry({ is_government_source: false })), /government source/i);
});

test("reasonNotPromotable() explains an unresolved jurisdiction", () => {
  const entry = baseEntry();
  entry.officials[0].jurisdiction = { city: null, state: null };
  assert.match(reasonNotPromotable(entry), /jurisdiction not resolved/i);
});

test("reasonNotPromotable() explains a state/federal submission", () => {
  const entry = baseEntry();
  entry.officials[0].level = "state";
  assert.match(reasonNotPromotable(entry), /out of scope/i);
});

test("reasonNotPromotable() falls back to a confidence explanation", () => {
  const entry = baseEntry();
  entry.officials[0].confidence = 0.1;
  assert.match(reasonNotPromotable(entry), /confidence/i);
});

test("jurisdictionFromSubmission() builds a seeds.discovered.json-shaped record", () => {
  assert.deepEqual(jurisdictionFromSubmission(baseEntry()), {
    city: "Elgin",
    state: "TX",
    level: "local",
    body: "Elgin City Council",
    urls: ["https://www.elgintx.com/149/City-Council"],
    discovered_at: "2026-08-01T00:00:00.000Z",
  });
});

test("jurisdictionFromSubmission() returns null for a non-promotable submission", () => {
  assert.equal(jurisdictionFromSubmission(baseEntry({ is_government_source: false })), null);
});

test("jurisdictionFromSubmission() falls back to `now` when checked_at is missing", () => {
  const entry = baseEntry({ checked_at: undefined });
  const result = jurisdictionFromSubmission(entry, { now: "2026-08-20T00:00:00.000Z" });
  assert.equal(result.discovered_at, "2026-08-20T00:00:00.000Z");
});
