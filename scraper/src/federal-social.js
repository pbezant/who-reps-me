// Builds public/federal-social.json: a small { bioguideId: {twitter, facebook, instagram,
// youtube} } map for members of Congress, sourced from the public-domain
// unitedstates/congress-legislators project. No scraping, no LLM calls — this is a plain
// data merge, so it can (and should) refresh far more often than the officials scrape.
//
// 5calls' own `id` for House/Senate members already IS the bioguide ID (confirmed against
// src/response.json — "C001131", "C001056", ...), so the frontend merges this onto a 5calls
// record with a plain object lookup by id, no name matching needed.
//
// The source is YAML, not JSON, so it's parsed here (Node) rather than in the browser —
// keeps a YAML-parsing dependency out of the production frontend bundle.
//
// Usage: node src/federal-social.js

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const OUT_PATH = join(REPO_ROOT, "public", "federal-social.json");

const SOURCE_URL =
  "https://raw.githubusercontent.com/unitedstates/congress-legislators/main/legislators-social-media.yaml";

function profileUrl(platform, handle) {
  if (!handle) return null;
  if (platform === "twitter") return `https://twitter.com/${handle}`;
  if (platform === "facebook") return `https://facebook.com/${handle}`;
  if (platform === "instagram") return `https://instagram.com/${handle}`;
  return null;
}

// Prefer the human-readable channel name; fall back to the channel id when that's all the
// source has.
function youtubeUrl(social) {
  if (social.youtube) return `https://youtube.com/${social.youtube}`;
  if (social.youtube_id) return `https://youtube.com/channel/${social.youtube_id}`;
  return null;
}

async function main() {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Failed to fetch ${SOURCE_URL}: HTTP ${res.status}`);
  const text = await res.text();
  const entries = yaml.load(text);
  if (!Array.isArray(entries)) throw new Error("Unexpected YAML shape: expected a top-level array");

  const legislators = {};
  for (const entry of entries) {
    const bioguide = entry?.id?.bioguide;
    const social = entry?.social;
    if (!bioguide || !social) continue;
    const record = {
      twitter: profileUrl("twitter", social.twitter),
      facebook: profileUrl("facebook", social.facebook),
      instagram: profileUrl("instagram", social.instagram),
      youtube: youtubeUrl(social),
    };
    // Skip rows where nothing resolved to an actual link — no point carrying an all-null
    // entry in the shard.
    if (Object.values(record).some(Boolean)) legislators[bioguide] = record;
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  const generated_at = new Date().toISOString();
  await writeFile(
    OUT_PATH,
    JSON.stringify({ generated_at, source: SOURCE_URL, count: Object.keys(legislators).length, legislators }, null, 2)
  );
  console.log(`Wrote ${Object.keys(legislators).length} legislators' social links to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
