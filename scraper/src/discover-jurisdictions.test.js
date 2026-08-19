import { test } from "node:test";
import assert from "node:assert/strict";
import { guessBodyName, selectDiscoveryCandidates } from "./discover-jurisdictions.js";

const NOW = "2026-08-19T00:00:00.000Z";

test("guessBodyName() names a city council vs. a county commissioners court", () => {
  assert.equal(guessBodyName("Elgin", "local"), "Elgin City Council");
  assert.equal(guessBodyName("Bastrop County", "county"), "Bastrop County Commissioners Court");
});

test("selectDiscoveryCandidates() keeps a jurisdiction with no prior attempt", () => {
  const candidates = [{ city: "Elgin", state: "TX", level: "local" }];
  const kept = selectDiscoveryCandidates(candidates, { seededKeys: new Set(), discoveredKeys: new Set(), misses: [], now: NOW });
  assert.equal(kept.length, 1);
});

test("selectDiscoveryCandidates() skips a jurisdiction already in seeds.json", () => {
  const candidates = [{ city: "Austin", state: "TX", level: "local" }];
  const seededKeys = new Set(["TX:austin:local"]);
  const kept = selectDiscoveryCandidates(candidates, { seededKeys, discoveredKeys: new Set(), misses: [], now: NOW });
  assert.equal(kept.length, 0);
});

test("selectDiscoveryCandidates() skips a jurisdiction already in seeds.discovered.json", () => {
  const candidates = [{ city: "Elgin", state: "TX", level: "local" }];
  const discoveredKeys = new Set(["TX:elgin:local"]);
  const kept = selectDiscoveryCandidates(candidates, { seededKeys: new Set(), discoveredKeys, misses: [], now: NOW });
  assert.equal(kept.length, 0);
});

test("selectDiscoveryCandidates() skips a miss still inside its cooldown", () => {
  const candidates = [{ city: "Nowhere", state: "TX", level: "local" }];
  const misses = [{ city: "Nowhere", state: "TX", level: "local", checked_at: "2026-08-01T00:00:00.000Z" }]; // 18 days ago
  const kept = selectDiscoveryCandidates(candidates, { seededKeys: new Set(), discoveredKeys: new Set(), misses, now: NOW });
  assert.equal(kept.length, 0);
});

test("selectDiscoveryCandidates() retries a miss once its cooldown has passed", () => {
  const candidates = [{ city: "Nowhere", state: "TX", level: "local" }];
  const misses = [{ city: "Nowhere", state: "TX", level: "local", checked_at: "2026-01-01T00:00:00.000Z" }]; // well over 90 days
  const kept = selectDiscoveryCandidates(candidates, { seededKeys: new Set(), discoveredKeys: new Set(), misses, now: NOW });
  assert.equal(kept.length, 1);
});

test("selectDiscoveryCandidates() treats a county and a like-named city as different jurisdictions", () => {
  const candidates = [
    { city: "Bastrop", state: "TX", level: "local" },
    { city: "Bastrop County", state: "TX", level: "county" },
  ];
  const seededKeys = new Set(["TX:bastrop:local"]); // only the city is already seeded
  const kept = selectDiscoveryCandidates(candidates, { seededKeys, discoveredKeys: new Set(), misses: [], now: NOW });
  assert.deepEqual(kept.map((j) => j.city), ["Bastrop County"]);
});

test("selectDiscoveryCandidates() respects a custom cooldown window", () => {
  const candidates = [{ city: "Nowhere", state: "TX", level: "local" }];
  const misses = [{ city: "Nowhere", state: "TX", level: "local", checked_at: "2026-08-18T00:00:00.000Z" }]; // 1 day ago
  const kept = selectDiscoveryCandidates(candidates, {
    seededKeys: new Set(),
    discoveredKeys: new Set(),
    misses,
    now: NOW,
    missCooldownMs: 1000 * 60 * 60, // 1 hour — the 1-day-old miss is well outside it
  });
  assert.equal(kept.length, 1);
});
