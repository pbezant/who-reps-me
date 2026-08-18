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
