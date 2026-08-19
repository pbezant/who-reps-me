// Shared jurisdiction-list loader: merges the hand-authored config/seeds.json with the
// auto-discovered config/seeds.discovered.json (written by discover-jurisdictions.js), so
// run.js and probe.js both scrape/verify the union of "a human vetted this" and "the batch
// discovery script found this" without duplicating the merge logic.
//
// config/seeds.json always wins on a (state, city, level) conflict, so a hand-fixed URL is
// never clobbered by automation. This is the concrete sense in which seeds.json "isn't the only
// source of jurisdictions anymore" (see scraper/README.md's "Dynamic jurisdiction discovery"
// section): it shrinks to overrides/corrections, and the bulk of coverage comes from
// discover-jurisdictions.js's budget-capped runs instead of a human pasting in every URL.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONFIG_DIR = join(__dirname, "..", "config");

export async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export function jurisdictionKey(j) {
  return `${(j?.state || "").toUpperCase()}:${(j?.city || "").toLowerCase()}:${j?.level || "local"}`;
}

// Merges two jurisdiction lists by (state, city, level), with `override` entries always winning
// a shared key. Exported mainly so tests can exercise the precedence rule directly without
// touching the filesystem.
export function mergeJurisdictions(base, override) {
  const byKey = new Map((base || []).map((j) => [jurisdictionKey(j), j]));
  for (const j of override || []) byKey.set(jurisdictionKey(j), j);
  return [...byKey.values()];
}

// Loads config/seeds.json (required — the repo always ships this) merged with
// config/seeds.discovered.json (optional — only exists once discover-jurisdictions.js has run
// at least once), with seeds.json's hand-authored entries always winning a conflict.
export async function loadJurisdictions() {
  const seeds = JSON.parse(await readFile(join(CONFIG_DIR, "seeds.json"), "utf8"));
  const discovered = await readJsonIfExists(join(CONFIG_DIR, "seeds.discovered.json"));
  return mergeJurisdictions(discovered?.jurisdictions, seeds.jurisdictions);
}
