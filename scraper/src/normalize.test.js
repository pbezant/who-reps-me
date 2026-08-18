import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, buildId } from "./normalize.js";

const AUSTIN = { state: "TX", city: "Austin", level: "local", body: "Austin City Council" };

test("normalize() keeps the previous id shape for the common case", () => {
  const rec = normalize(
    { name: "Vanessa Fuentes", office: "Council Member", district: "District 2" },
    { jurisdiction: AUSTIN, sourceUrl: "https://example.com", extractedAt: "2026-01-01T00:00:00.000Z" }
  );
  assert.equal(rec.id, "tx:austin:council-member:vanessa-fuentes");
  // Display fields are untouched by id canonicalization.
  assert.equal(rec.office, "Council Member");
  assert.equal(rec.name, "Vanessa Fuentes");
});

test("buildId() folds 'City Council Member' and 'Council Member' onto the same id", () => {
  const a = buildId(AUSTIN, "City Council Member", "Vanessa Fuentes");
  const b = buildId(AUSTIN, "Council Member", "Vanessa Fuentes");
  assert.equal(a, b);
});

test("buildId() folds 'Councilmember' (no space) onto the same id as 'Council Member'", () => {
  const a = buildId(AUSTIN, "Councilmember", "Vanessa Fuentes");
  const b = buildId(AUSTIN, "Council Member", "Vanessa Fuentes");
  assert.equal(a, b);
});

test("buildId() ignores straight vs curly quotes around a nickname", () => {
  const curly = buildId(AUSTIN, "City Council Member", "José “Chito” Vela");
  const straightDouble = buildId(AUSTIN, "City Council Member", 'José "Chito" Vela');
  const straightSingle = buildId(AUSTIN, "Council Member", "José 'Chito' Vela");
  assert.equal(curly, straightDouble);
  assert.equal(curly, straightSingle);
});

test("buildId() ignores whitespace differences around a slash in combined titles", () => {
  const spaced = buildId(AUSTIN, "Mayor Pro Tem / Council Member", "Becki Ross");
  const tight = buildId(AUSTIN, "Mayor Pro Tem/Council Member", "Becki Ross");
  assert.equal(spaced, tight);
});

test("buildId() still separates genuinely different offices for the same person", () => {
  // A person legitimately holding two distinct offices in one jurisdiction must not be
  // collapsed into a single record — only phrasing variants of the *same* office should fold.
  const mayor = buildId(AUSTIN, "Mayor", "Pat Example");
  const council = buildId(AUSTIN, "Council Member", "Pat Example");
  assert.notEqual(mayor, council);
});

test("buildId() still separates different people with the same office", () => {
  const a = buildId(AUSTIN, "Council Member", "Vanessa Fuentes");
  const b = buildId(AUSTIN, "Council Member", "Paige Ellis");
  assert.notEqual(a, b);
});

test("buildId() falls back to '?' for a missing office, same as before", () => {
  const id = buildId(AUSTIN, undefined, "Vanessa Fuentes");
  assert.equal(id, "tx:austin:?:vanessa-fuentes");
});

test("normalize() returns null for a blank name (unchanged behavior)", () => {
  const rec = normalize(
    { name: "  ", office: "Mayor" },
    { jurisdiction: AUSTIN, sourceUrl: "https://example.com", extractedAt: "2026-01-01T00:00:00.000Z" }
  );
  assert.equal(rec, null);
});
