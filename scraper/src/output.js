// Sharded, merge-on-write output. The "database" is a set of per-state JSON files under
// public/officials/ that Netlify serves as static assets. Sharding by state keeps each
// browser fetch small (~1-3MB) versus a single nationwide blob (~50-100MB), and the
// frontend already knows the state from geocoding so it fetches exactly one shard.
//
// Writes are UPSERT-MERGE, not overwrite: a scoped run (e.g. only Austin) must not wipe
// the other cities already stored for that state. Records are matched by `id` (the stable
// key produced in normalize.js).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function upsertById(existing, incoming) {
  // Keep every existing record; replace one only when an incoming record shares its id.
  // Incoming wins (it's the fresher scrape).
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const rec of incoming) byId.set(rec.id, rec);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function writeShards(officials, { publicDir, now }) {
  await mkdir(publicDir, { recursive: true });

  // Group this run's officials by state.
  const byState = new Map();
  for (const rec of officials) {
    const st = (rec.jurisdiction?.state || "US").toUpperCase();
    if (!byState.has(st)) byState.set(st, []);
    byState.get(st).push(rec);
  }

  const writtenStates = [];
  for (const [state, incoming] of byState) {
    const shardPath = join(publicDir, `${state}.json`);
    const prev = await readJsonIfExists(shardPath);
    const merged = upsertById(prev?.officials || [], incoming);

    const cities = [...new Set(merged.map((r) => r.jurisdiction?.city).filter(Boolean))].sort();
    const shard = { state, generated_at: now, count: merged.length, cities, officials: merged };
    await writeFile(shardPath, JSON.stringify(shard, null, 2));
    writtenStates.push({ state, count: merged.length, cities });
  }

  // Rebuild index.json from all shards currently on disk, not just this run's states, so
  // coverage stays accurate across scoped runs. We only have this run's states in memory,
  // so merge them onto whatever the previous index recorded.
  const indexPath = join(publicDir, "index.json");
  const prevIndex = (await readJsonIfExists(indexPath)) || { states: {} };
  const states = { ...prevIndex.states };
  for (const s of writtenStates) {
    states[s.state] = { count: s.count, cities: s.cities, updated: now };
  }
  const index = { generated_at: now, states };
  await writeFile(indexPath, JSON.stringify(index, null, 2));

  return { states: writtenStates, indexPath };
}
