import { test } from "node:test";
import assert from "node:assert/strict";
import { selectScrapeCandidates } from "./run.js";

const NOW = "2026-08-19T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_MS = 30 * DAY_MS;

test("selectScrapeCandidates() puts a never-scraped jurisdiction ahead of a stale one", () => {
  const jurisdictions = [
    { city: "Elgin", state: "TX", level: "local" },
    { city: "Kyle", state: "TX", level: "local" },
  ];
  const lastScrapedByKey = new Map([["TX:kyle:local", "2026-01-01T00:00:00.000Z"]]); // long overdue
  const picked = selectScrapeCandidates(jurisdictions, lastScrapedByKey, { budget: 10, refreshMs: REFRESH_MS, now: NOW });
  assert.deepEqual(picked.map((j) => j.city), ["Elgin", "Kyle"]);
});

test("selectScrapeCandidates() drops a jurisdiction scraped more recently than refreshMs", () => {
  const jurisdictions = [{ city: "Elgin", state: "TX", level: "local" }];
  const lastScrapedByKey = new Map([["TX:elgin:local", "2026-08-18T00:00:00.000Z"]]); // 1 day ago
  const picked = selectScrapeCandidates(jurisdictions, lastScrapedByKey, { budget: 10, refreshMs: REFRESH_MS, now: NOW });
  assert.equal(picked.length, 0);
});

test("selectScrapeCandidates() keeps a jurisdiction exactly at the refresh boundary", () => {
  const jurisdictions = [{ city: "Elgin", state: "TX", level: "local" }];
  const lastScrapedByKey = new Map([["TX:elgin:local", new Date(Date.parse(NOW) - REFRESH_MS).toISOString()]]);
  const picked = selectScrapeCandidates(jurisdictions, lastScrapedByKey, { budget: 10, refreshMs: REFRESH_MS, now: NOW });
  assert.equal(picked.length, 1);
});

test("selectScrapeCandidates() orders previously-scraped jurisdictions oldest-first", () => {
  const jurisdictions = [
    { city: "Elgin", state: "TX", level: "local" },
    { city: "Kyle", state: "TX", level: "local" },
  ];
  const lastScrapedByKey = new Map([
    ["TX:elgin:local", "2026-06-01T00:00:00.000Z"], // ~79 days ago — more overdue
    ["TX:kyle:local", "2026-07-01T00:00:00.000Z"], // ~49 days ago
  ]);
  const picked = selectScrapeCandidates(jurisdictions, lastScrapedByKey, { budget: 10, refreshMs: REFRESH_MS, now: NOW });
  assert.deepEqual(picked.map((j) => j.city), ["Elgin", "Kyle"]);
});

test("selectScrapeCandidates() stops at the budget", () => {
  const jurisdictions = [
    { city: "Elgin", state: "TX", level: "local" },
    { city: "Kyle", state: "TX", level: "local" },
    { city: "Bastrop", state: "TX", level: "local" },
  ];
  const picked = selectScrapeCandidates(jurisdictions, new Map(), { budget: 2, refreshMs: REFRESH_MS, now: NOW });
  assert.equal(picked.length, 2);
});

test("selectScrapeCandidates() preserves input order among ties (stable sort)", () => {
  const jurisdictions = [
    { city: "Bastrop", state: "TX", level: "local" },
    { city: "Austin", state: "TX", level: "local" },
    { city: "Elgin", state: "TX", level: "local" },
  ];
  // None ever scraped — all tie at age=Infinity, so population-weighted arrival order must survive.
  const picked = selectScrapeCandidates(jurisdictions, new Map(), { budget: 10, refreshMs: REFRESH_MS, now: NOW });
  assert.deepEqual(picked.map((j) => j.city), ["Bastrop", "Austin", "Elgin"]);
});

test("selectScrapeCandidates() returns [] for an empty jurisdiction list", () => {
  const picked = selectScrapeCandidates([], new Map(), { budget: 10, refreshMs: REFRESH_MS, now: NOW });
  assert.deepEqual(picked, []);
});
