import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeShards } from "./output.js";
import { normalize } from "./normalize.js";

const AUSTIN = { state: "TX", city: "Austin", level: "local", body: "Austin City Council" };

// Regression test for the bug this fix addresses: two scrape runs that extract the same
// person with slightly different `office` phrasing (or quote style) used to produce two
// different ids, so upsertById() kept both forever instead of the newer one replacing the
// older one. See normalize.js's buildId()/canonicalizeOffice().
test("writeShards() upserts a re-scrape that only changed office phrasing, not duplicates it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "who-reps-me-output-test-"));
  try {
    const first = normalize(
      { name: "José 'Chito' Vela", office: "Council Member", district: "District 4", confidence: 0.9 },
      { jurisdiction: AUSTIN, sourceUrl: "https://example.com", extractedAt: "2026-08-18T16:54:37.375Z" }
    );
    await writeShards([first], { publicDir: dir, now: first.extracted_at });

    const second = normalize(
      { name: "José “Chito” Vela", office: "City Council Member", district: "District 4", confidence: 1 },
      { jurisdiction: AUSTIN, sourceUrl: "https://example.com", extractedAt: "2026-08-18T18:11:02.875Z" }
    );
    await writeShards([second], { publicDir: dir, now: second.extracted_at });

    const shard = JSON.parse(await readFile(join(dir, "TX.json"), "utf8"));
    const matches = shard.officials.filter((o) => o.name.includes("Vela"));
    assert.equal(matches.length, 1, "the re-scrape should replace the record, not add a second one");
    assert.equal(matches[0].office, "City Council Member", "the newer scrape's fields should win");
    assert.equal(matches[0].confidence, 1);
    assert.equal(shard.count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Regression test for the bug mergeRecordFields() (normalize.js) fixes: upsertById() used to
// fully replace a record by id, so a later run that re-scrapes a jurisdiction's roster page but
// doesn't reach a given official's bio page again (bio-page enrichment budget exhausted that
// run) would silently erase enrichment — a photo, office hours — a previous run had already
// found, just because this run's incoming record has null for those fields.
test("writeShards() keeps a previously-found value when a later run's incoming record has null for it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "who-reps-me-output-test-"));
  try {
    const enriched = normalize(
      { name: "Vanessa Fuentes", office: "Council Member", district: "District 2", confidence: 0.9 },
      { jurisdiction: AUSTIN, sourceUrl: "https://example.com", extractedAt: "2026-08-01T00:00:00.000Z" }
    );
    enriched.hours = "9-5 M-F";
    enriched.photo_url = "https://example.com/fuentes.jpg";
    await writeShards([enriched], { publicDir: dir, now: enriched.extracted_at });

    // A later run's roster-only pass: same person, but this run's bio-page budget never
    // reached them again, so normalize() produces hours/photo_url as null, same as always.
    const rosterOnly = normalize(
      { name: "Vanessa Fuentes", office: "Council Member", district: "District 2", confidence: 1 },
      { jurisdiction: AUSTIN, sourceUrl: "https://example.com", extractedAt: "2026-08-18T00:00:00.000Z" }
    );
    await writeShards([rosterOnly], { publicDir: dir, now: rosterOnly.extracted_at });

    const shard = JSON.parse(await readFile(join(dir, "TX.json"), "utf8"));
    const [match] = shard.officials.filter((o) => o.name.includes("Fuentes"));
    assert.equal(match.hours, "9-5 M-F", "previously-found hours must survive a roster-only re-scrape");
    assert.equal(match.photo_url, "https://example.com/fuentes.jpg", "previously-found photo must survive");
    assert.equal(match.confidence, 1, "the newer scrape's own fields still win");
    assert.equal(match.extracted_at, "2026-08-18T00:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
