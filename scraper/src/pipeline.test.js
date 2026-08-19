import { test } from "node:test";
import assert from "node:assert/strict";
import { needsEnrichment, recentlyChecked, selectEnrichmentCandidates } from "./pipeline.js";

const NOW = "2026-08-19T00:00:00.000Z";

function record(overrides = {}) {
  return {
    id: "tx:austin:council-member:pat-example",
    name: "Pat Example",
    office: "Council Member",
    url: "https://example.com/bio/pat",
    photo_url: null,
    address: null,
    phone: null,
    email: null,
    hours: null,
    bio: null,
    bio_checked_at: null,
    ...overrides,
  };
}

test("needsEnrichment() is true when any enrichment field is still null", () => {
  assert.equal(needsEnrichment(record()), true);
  assert.equal(needsEnrichment(record({ photo_url: null, address: "1 Main St" })), true);
});

test("needsEnrichment() is false once every enrichment field is populated", () => {
  const complete = record({
    photo_url: "https://example.com/p.jpg",
    address: "1 Main St",
    phone: "512-555-0000",
    email: "pat@example.com",
    hours: "9-5",
    bio: "A short bio.",
  });
  assert.equal(needsEnrichment(complete), false);
});

test("recentlyChecked() is false when bio_checked_at is unset", () => {
  assert.equal(recentlyChecked(record(), NOW), false);
});

test("recentlyChecked() is true within the 90-day cooldown, false after it", () => {
  const withinCooldown = record({ bio_checked_at: "2026-08-01T00:00:00.000Z" }); // 18 days before NOW
  assert.equal(recentlyChecked(withinCooldown, NOW), true);

  const beforeCooldown = record({ bio_checked_at: "2026-01-01T00:00:00.000Z" }); // well over 90 days
  assert.equal(recentlyChecked(beforeCooldown, NOW), false);
});

test("selectEnrichmentCandidates() picks a record with a url and a gap", () => {
  const candidates = selectEnrichmentCandidates([record()], { now: NOW, budget: 10 });
  assert.equal(candidates.length, 1);
});

test("selectEnrichmentCandidates() skips a record with no url to follow", () => {
  const candidates = selectEnrichmentCandidates([record({ url: null })], { now: NOW, budget: 10 });
  assert.equal(candidates.length, 0);
});

test("selectEnrichmentCandidates() skips a record that's already complete", () => {
  const complete = record({
    photo_url: "https://example.com/p.jpg",
    address: "1 Main St",
    phone: "512-555-0000",
    email: "pat@example.com",
    hours: "9-5",
    bio: "A short bio.",
  });
  assert.equal(selectEnrichmentCandidates([complete], { now: NOW, budget: 10 }).length, 0);
});

test("selectEnrichmentCandidates() skips a record checked too recently", () => {
  const recent = record({ bio_checked_at: "2026-08-01T00:00:00.000Z" });
  assert.equal(selectEnrichmentCandidates([recent], { now: NOW, budget: 10 }).length, 0);
});

test("selectEnrichmentCandidates() skips a url shared by 2+ officials in the batch", () => {
  const sharedUrl = "https://example.com/council";
  const records = [
    record({ id: "a", name: "A", url: sharedUrl }),
    record({ id: "b", name: "B", url: sharedUrl }),
  ];
  assert.equal(selectEnrichmentCandidates(records, { now: NOW, budget: 10 }).length, 0);
});

test("selectEnrichmentCandidates() does not skip a url used by only one official", () => {
  const records = [
    record({ id: "a", name: "A", url: "https://example.com/bio/a" }),
    record({ id: "b", name: "B", url: "https://example.com/bio/b" }),
  ];
  assert.equal(selectEnrichmentCandidates(records, { now: NOW, budget: 10 }).length, 2);
});

test("selectEnrichmentCandidates() stops at the budget, in array order", () => {
  const records = [
    record({ id: "a", name: "A", url: "https://example.com/bio/a" }),
    record({ id: "b", name: "B", url: "https://example.com/bio/b" }),
    record({ id: "c", name: "C", url: "https://example.com/bio/c" }),
  ];
  const candidates = selectEnrichmentCandidates(records, { now: NOW, budget: 2 });
  assert.deepEqual(candidates.map((r) => r.id), ["a", "b"]);
});

test("selectEnrichmentCandidates() returns [] for an empty budget or record list", () => {
  assert.deepEqual(selectEnrichmentCandidates([record()], { now: NOW, budget: 0 }), []);
  assert.deepEqual(selectEnrichmentCandidates([], { now: NOW, budget: 10 }), []);
});
