import { test } from "node:test";
import assert from "node:assert/strict";
import { groupBySourceUrl, rankForReview, diffExtraction } from "./qa-check.js";

function official(overrides) {
  return {
    id: "placeholder",
    name: "Vanessa Fuentes",
    source_url: "https://www.austintexas.gov/department/city-council",
    extracted_at: "2026-08-01T00:00:00.000Z",
    confidence: 1,
    jurisdiction: { city: "Austin", state: "TX" },
    level: "local",
    body: "Austin City Council",
    ...overrides,
  };
}

test("groupBySourceUrl() groups officials sharing the same roster page", () => {
  const a1 = official({ name: "A", source_url: "https://a.gov" });
  const a2 = official({ name: "B", source_url: "https://a.gov" });
  const b1 = official({ name: "C", source_url: "https://b.gov" });
  const groups = groupBySourceUrl([a1, a2, b1]);
  assert.equal(groups.size, 2);
  assert.deepEqual(groups.get("https://a.gov"), [a1, a2]);
  assert.deepEqual(groups.get("https://b.gov"), [b1]);
});

test("groupBySourceUrl() skips a record with no source_url rather than crashing", () => {
  const groups = groupBySourceUrl([official({ source_url: null }), official({ name: "B" })]);
  assert.equal(groups.size, 1);
});

test("rankForReview() sorts oldest extraction first", () => {
  const groups = new Map([
    ["https://newer.gov", [official({ extracted_at: "2026-08-15T00:00:00.000Z" })]],
    ["https://older.gov", [official({ extracted_at: "2026-07-01T00:00:00.000Z" })]],
  ]);
  const ranked = rankForReview(groups);
  assert.deepEqual(ranked.map(([url]) => url), ["https://older.gov", "https://newer.gov"]);
});

test("rankForReview() uses lowest confidence as the tiebreaker on equal age", () => {
  const sameDate = "2026-08-01T00:00:00.000Z";
  const groups = new Map([
    ["https://confident.gov", [official({ extracted_at: sameDate, confidence: 1 })]],
    ["https://unsure.gov", [official({ extracted_at: sameDate, confidence: 0.5 })]],
  ]);
  const ranked = rankForReview(groups);
  assert.deepEqual(ranked.map(([url]) => url), ["https://unsure.gov", "https://confident.gov"]);
});

test("diffExtraction() returns null when the fresh pass agrees with what's stored", () => {
  const stored = [official({ name: "Vanessa Fuentes" }), official({ name: "José Vela" })];
  const fresh = [official({ name: "Vanessa Fuentes" }), official({ name: "José Vela" })];
  assert.equal(diffExtraction(stored, fresh), null);
});

test("diffExtraction() flags someone missing from the fresh pass", () => {
  const stored = [official({ name: "Vanessa Fuentes" }), official({ name: "José Vela" })];
  const fresh = [official({ name: "Vanessa Fuentes" })];
  const diff = diffExtraction(stored, fresh);
  assert.equal(diff.stored_count, 2);
  assert.equal(diff.fresh_count, 1);
  assert.deepEqual(diff.missing_from_fresh, ["josé vela"]);
  assert.deepEqual(diff.new_in_fresh, []);
});

test("diffExtraction() flags someone new in the fresh pass", () => {
  const stored = [official({ name: "Vanessa Fuentes" })];
  const fresh = [official({ name: "Vanessa Fuentes" }), official({ name: "New Member" })];
  const diff = diffExtraction(stored, fresh);
  assert.deepEqual(diff.new_in_fresh, ["new member"]);
  assert.deepEqual(diff.missing_from_fresh, []);
});

test("diffExtraction() is case/whitespace-insensitive on names", () => {
  const stored = [official({ name: "  Vanessa Fuentes  " })];
  const fresh = [official({ name: "vanessa fuentes" })];
  assert.equal(diffExtraction(stored, fresh), null);
});
