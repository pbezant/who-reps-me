import { test } from "node:test";
import assert from "node:assert/strict";
import { stateFips, resolveStateList, STATE_FIPS } from "./stateFips.js";

test("stateFips() looks up a known state, case-insensitively", () => {
  assert.equal(stateFips("TX"), "48");
  assert.equal(stateFips("tx"), "48");
});

test("stateFips() returns null for an unknown code", () => {
  assert.equal(stateFips("ZZ"), null);
  assert.equal(stateFips(""), null);
});

test("resolveStateList() expands 'ALL' to every state in STATE_FIPS", () => {
  assert.deepEqual(resolveStateList("ALL"), Object.keys(STATE_FIPS));
});

test("resolveStateList() defaults to 'ALL' when unset", () => {
  assert.deepEqual(resolveStateList(undefined), Object.keys(STATE_FIPS));
  assert.deepEqual(resolveStateList(""), Object.keys(STATE_FIPS));
});

test("resolveStateList() is case-insensitive on the 'ALL' sentinel", () => {
  assert.deepEqual(resolveStateList("all"), Object.keys(STATE_FIPS));
});

test("resolveStateList() splits a comma-separated list otherwise", () => {
  assert.deepEqual(resolveStateList("tx, ca ,ny"), ["TX", "CA", "NY"]);
});
