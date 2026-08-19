import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "dedupe-shard.js");

const AUSTIN = { city: "Austin", state: "TX" };

function official(overrides) {
  return {
    id: "placeholder",
    name: "Vanessa Fuentes",
    office: "Council Member",
    level: "local",
    body: "Austin City Council",
    district: "District 2",
    phone: null,
    email: null,
    url: null,
    photo_url: null,
    social: { twitter: null, facebook: null, instagram: null, linkedin: null, youtube: null },
    address: null,
    jurisdiction: AUSTIN,
    source_url: "https://example.com",
    extracted_at: "2026-08-18T16:54:37.375Z",
    confidence: 0.9,
    ...overrides,
  };
}

test("dedupe-shard.js merges an office-phrasing duplicate and backfills photo_url/social from the older record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "who-reps-me-dedupe-test-"));
  const shardPath = join(dir, "TX.json");
  try {
    const older = official({
      id: "tx:austin:council-member:vanessa-fuentes",
      office: "Council Member",
      extracted_at: "2026-08-18T16:54:37.375Z",
      confidence: 0.9,
      photo_url: "https://example.com/old-photo.jpg",
      social: { twitter: "https://twitter.com/vanessa", facebook: null, instagram: null, linkedin: null, youtube: null },
    });
    const newer = official({
      id: "tx:austin:city-council-member:vanessa-fuentes",
      office: "City Council Member",
      extracted_at: "2026-08-18T18:11:02.875Z",
      confidence: 1,
      photo_url: null, // newer scrape didn't pick up a photo this time
      social: { twitter: null, facebook: "https://facebook.com/vanessa", instagram: null, linkedin: null, youtube: null },
    });
    await writeFile(
      shardPath,
      JSON.stringify(
        { state: "TX", generated_at: newer.extracted_at, count: 2, cities: ["Austin"], officials: [older, newer] },
        null,
        2
      )
    );

    execFileSync("node", [SCRIPT, shardPath], { encoding: "utf8" });

    const result = JSON.parse(await readFile(shardPath, "utf8"));
    assert.equal(result.officials.length, 1, "the duplicate pair should merge into one record");
    const [merged] = result.officials;
    assert.equal(merged.office, "City Council Member", "newer record's office wins");
    assert.equal(merged.confidence, 1, "newer record's confidence wins");
    assert.equal(merged.photo_url, "https://example.com/old-photo.jpg", "backfilled from the older record");
    assert.equal(merged.social.twitter, "https://twitter.com/vanessa", "backfilled from the older record");
    assert.equal(merged.social.facebook, "https://facebook.com/vanessa", "kept from the newer record");
    assert.equal(result.count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dedupe-shard.js backfills hours/bio/offices from an older bio-page-enriched duplicate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "who-reps-me-dedupe-test-"));
  const shardPath = join(dir, "TX.json");
  try {
    const older = official({
      id: "tx:austin:council-member:vanessa-fuentes",
      office: "Council Member",
      extracted_at: "2026-08-18T16:54:37.375Z",
      confidence: 0.9,
      hours: "9-5 M-F",
      bio: "A short bio.",
      bio_checked_at: "2026-08-18T16:54:37.375Z",
      offices: [{ classification: "district", name: null, city: "Austin", address: "200 Oak St", phone: null, fax: null, hours: null }],
    });
    const newer = official({
      id: "tx:austin:city-council-member:vanessa-fuentes",
      office: "City Council Member",
      extracted_at: "2026-08-18T18:11:02.875Z",
      confidence: 1,
      // A roster-only re-scrape never touches these — normalize() defaults them to null/[].
      hours: null,
      bio: null,
      bio_checked_at: null,
      offices: [],
    });
    await writeFile(
      shardPath,
      JSON.stringify(
        { state: "TX", generated_at: newer.extracted_at, count: 2, cities: ["Austin"], officials: [older, newer] },
        null,
        2
      )
    );

    execFileSync("node", [SCRIPT, shardPath], { encoding: "utf8" });

    const [merged] = JSON.parse(await readFile(shardPath, "utf8")).officials;
    assert.equal(merged.hours, "9-5 M-F", "backfilled from the older, bio-enriched record");
    assert.equal(merged.bio, "A short bio.");
    assert.equal(merged.bio_checked_at, "2026-08-18T16:54:37.375Z");
    assert.equal(merged.offices.length, 1);
    assert.equal(merged.offices[0].address, "200 Oak St");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
