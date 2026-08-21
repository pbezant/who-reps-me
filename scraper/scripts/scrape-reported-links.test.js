import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLinkFromIssueBody,
  isPromotableExtraction,
  reasonNotPromotable,
  summarizeOfficials,
} from "./scrape-reported-links.js";

function baseResult(overrides = {}) {
  return {
    ok: true,
    isGovernmentSource: true,
    jurisdiction: { city: "Elgin", state: "TX", level: "local", body: "Elgin City Council" },
    officials: [{ name: "Jane Doe", office: "Mayor", confidence: 0.95 }],
    ...overrides,
  };
}

test("parseLinkFromIssueBody() reads the Link line report-bug.mjs writes", () => {
  const body = `Some cleaned description.\n\n---\n**Link:** https://www.elgintx.com/149/City-Council\n\n**Reported note:**\n> hi`;
  assert.equal(parseLinkFromIssueBody(body), "https://www.elgintx.com/149/City-Council");
});

test("parseLinkFromIssueBody() returns null when there's no Link line", () => {
  assert.equal(parseLinkFromIssueBody("Just a description, no link field."), null);
});

test("parseLinkFromIssueBody() returns null for an empty/missing body", () => {
  assert.equal(parseLinkFromIssueBody(""), null);
  assert.equal(parseLinkFromIssueBody(undefined), null);
});

test("isPromotableExtraction() accepts a confident, government-sourced, local-level result", () => {
  assert.equal(isPromotableExtraction(baseResult()), true);
});

test("isPromotableExtraction() rejects a fetch/extract failure", () => {
  assert.equal(isPromotableExtraction(baseResult({ ok: false, officials: [] })), false);
});

test("isPromotableExtraction() rejects an empty officials list", () => {
  assert.equal(isPromotableExtraction(baseResult({ officials: [] })), false);
});

test("isPromotableExtraction() rejects a non-government source", () => {
  assert.equal(isPromotableExtraction(baseResult({ isGovernmentSource: false })), false);
});

test("isPromotableExtraction() rejects state/federal level (sourced elsewhere)", () => {
  const result = baseResult();
  result.jurisdiction.level = "federal";
  assert.equal(isPromotableExtraction(result), false);
});

test("isPromotableExtraction() rejects an unresolved jurisdiction", () => {
  const result = baseResult();
  result.jurisdiction = { city: null, state: null, level: "local" };
  assert.equal(isPromotableExtraction(result), false);
});

test("isPromotableExtraction() rejects when every official is below the confidence floor", () => {
  const result = baseResult();
  result.officials[0].confidence = 0.3;
  assert.equal(isPromotableExtraction(result), false);
});

test("isPromotableExtraction() accepts when at least one of several officials clears the floor", () => {
  const result = baseResult();
  result.officials.push({ name: "Low Confidence Guy", office: "Council Member", confidence: 0.1 });
  assert.equal(isPromotableExtraction(result), true);
});

test("isPromotableExtraction() handles a missing/undefined result gracefully", () => {
  assert.equal(isPromotableExtraction(undefined), false);
  assert.equal(isPromotableExtraction({}), false);
});

test("reasonNotPromotable() explains a fetch/extract failure", () => {
  assert.match(reasonNotPromotable(baseResult({ ok: false, error: "HTTP 404", officials: [] })), /couldn't load/i);
});

test("reasonNotPromotable() explains a non-government source", () => {
  assert.match(reasonNotPromotable(baseResult({ isGovernmentSource: false })), /government source/i);
});

test("reasonNotPromotable() explains an unresolved jurisdiction", () => {
  const result = baseResult();
  result.jurisdiction = { city: null, state: null, level: "local" };
  assert.match(reasonNotPromotable(result), /jurisdiction not resolved/i);
});

test("reasonNotPromotable() explains a state/federal result", () => {
  const result = baseResult();
  result.jurisdiction.level = "state";
  assert.match(reasonNotPromotable(result), /out of scope/i);
});

test("reasonNotPromotable() falls back to a confidence explanation", () => {
  const result = baseResult();
  result.officials[0].confidence = 0.1;
  assert.match(reasonNotPromotable(result), /confidence/i);
});

test("summarizeOfficials() joins name + office", () => {
  const officials = [
    { name: "Jane Doe", office: "Mayor" },
    { name: "John Smith", office: null },
  ];
  assert.equal(summarizeOfficials(officials), "Jane Doe (Mayor), John Smith");
});

test("summarizeOfficials() handles an empty/missing list", () => {
  assert.equal(summarizeOfficials([]), "");
  assert.equal(summarizeOfficials(undefined), "");
});
