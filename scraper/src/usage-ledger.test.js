import { test } from "node:test";
import assert from "node:assert/strict";
import { usedToday, remainingBudget, estimateBudgetFromRemaining } from "./usage-ledger.js";

test("usedToday() returns 0 when there's no stored ledger yet", () => {
  assert.equal(usedToday(null, "2026-08-20"), 0);
});

test("usedToday() returns 0 when the stored ledger is from a previous day (quota reset)", () => {
  assert.equal(usedToday({ date: "2026-08-19", calls_used: 900 }, "2026-08-20"), 0);
});

test("usedToday() returns the stored count when the ledger is from today", () => {
  assert.equal(usedToday({ date: "2026-08-20", calls_used: 900 }, "2026-08-20"), 900);
});

test("remainingBudget() subtracts used from the daily cap, never going negative", () => {
  assert.equal(remainingBudget(900, 1450), 550);
  assert.equal(remainingBudget(1450, 1450), 0);
  assert.equal(remainingBudget(2000, 1450), 0); // already over cap (e.g. a heavy 429-retry day)
});

test("estimateBudgetFromRemaining() converts a call budget into a jurisdiction-count budget", () => {
  // 550 calls left, ~2.5 calls/jurisdiction for scrape, 0.85 safety margin
  assert.equal(estimateBudgetFromRemaining(550, 2.5, 0.85), 187);
});

test("estimateBudgetFromRemaining() returns 0 rather than dividing by zero for an unknown avg cost", () => {
  assert.equal(estimateBudgetFromRemaining(550, 0), 0);
});

test("estimateBudgetFromRemaining() defaults to a 0.85 safety margin", () => {
  const withDefault = estimateBudgetFromRemaining(1000, 5);
  const explicit = estimateBudgetFromRemaining(1000, 5, 0.85);
  assert.equal(withDefault, explicit);
});
