import { test } from "node:test";
import assert from "node:assert/strict";
import { jurisdictionKey, mergeJurisdictions } from "./seeds.js";

const AUSTIN_HAND = { city: "Austin", state: "TX", level: "local", body: "Austin City Council", urls: ["https://hand.example.com"] };
const AUSTIN_DISCOVERED = { city: "Austin", state: "TX", level: "local", body: "Austin City Council", urls: ["https://discovered.example.com"] };
const ELGIN_DISCOVERED = { city: "Elgin", state: "TX", level: "local", body: "Elgin City Council", urls: ["https://elgin.example.com"] };

test("jurisdictionKey() is case-insensitive on city and state, defaults level to local", () => {
  assert.equal(jurisdictionKey({ city: "Austin", state: "tx" }), jurisdictionKey({ city: "austin", state: "TX", level: "local" }));
});

test("jurisdictionKey() treats a county and a like-named city as different jurisdictions", () => {
  const city = jurisdictionKey({ city: "Bastrop", state: "TX", level: "local" });
  const county = jurisdictionKey({ city: "Bastrop County", state: "TX", level: "county" });
  assert.notEqual(city, county);
});

test("mergeJurisdictions() lets override win a shared key — seeds.json beats seeds.discovered.json", () => {
  const merged = mergeJurisdictions([AUSTIN_DISCOVERED], [AUSTIN_HAND]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], AUSTIN_HAND);
});

test("mergeJurisdictions() keeps a base entry that override has nothing for", () => {
  const merged = mergeJurisdictions([AUSTIN_DISCOVERED, ELGIN_DISCOVERED], [AUSTIN_HAND]);
  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.find((j) => j.city === "Elgin"),
    ELGIN_DISCOVERED
  );
});

test("mergeJurisdictions() tolerates missing/empty lists", () => {
  assert.deepEqual(mergeJurisdictions(undefined, undefined), []);
  assert.deepEqual(mergeJurisdictions([AUSTIN_HAND], []), [AUSTIN_HAND]);
  assert.deepEqual(mergeJurisdictions([], [AUSTIN_HAND]), [AUSTIN_HAND]);
});
