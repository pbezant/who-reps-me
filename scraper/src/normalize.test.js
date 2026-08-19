import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, buildId, normalizeOffices } from "./normalize.js";

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

test("normalize() defaults offices to [] when the source has none, without touching phone/address", () => {
  const rec = normalize(
    { name: "Vanessa Fuentes", office: "Council Member", phone: "5125551234", address: "301 W 2nd St" },
    { jurisdiction: AUSTIN, sourceUrl: "https://example.com", extractedAt: "2026-01-01T00:00:00.000Z" }
  );
  assert.deepEqual(rec.offices, []);
  assert.equal(rec.phone, "512-555-1234");
  assert.equal(rec.address, "301 W 2nd St");
});

test("normalize() maps raw.offices onto the record via normalizeOffices()", () => {
  const rec = normalize(
    {
      name: "Vanessa Fuentes",
      office: "Council Member",
      offices: [{ classification: "district", city: "Austin", address: "301 W 2nd St", phone: "5125551234" }],
    },
    { jurisdiction: AUSTIN, sourceUrl: "https://example.com", extractedAt: "2026-01-01T00:00:00.000Z" }
  );
  assert.equal(rec.offices.length, 1);
  assert.equal(rec.offices[0].classification, "district");
  assert.equal(rec.offices[0].phone, "512-555-1234");
});

test("normalizeOffices() tolerates a missing/non-array input", () => {
  assert.deepEqual(normalizeOffices(undefined), []);
  assert.deepEqual(normalizeOffices(null), []);
  assert.deepEqual(normalizeOffices("not an array"), []);
});

test("normalizeOffices() cleans phone the same way as the top-level phone field", () => {
  const [office] = normalizeOffices([{ classification: "capitol", phone: "(512) 555-1234" }]);
  assert.equal(office.phone, "512-555-1234");
});

test("normalizeOffices() passes through whatever classification string the source uses", () => {
  const [office] = normalizeOffices([{ classification: "district-mail", address: "PO Box 123" }]);
  assert.equal(office.classification, "district-mail");
});

test("normalizeOffices() defaults classification to 'other' rather than dropping the entry", () => {
  const [office] = normalizeOffices([{ address: "PO Box 123" }]);
  assert.equal(office.classification, "other");
});

test("normalizeOffices() drops an entry with nothing usable at all", () => {
  assert.deepEqual(normalizeOffices([{ classification: "capitol" }, { classification: "district" }]), []);
});

test("normalizeOffices() keeps an entry that has only an address, or only a phone", () => {
  const offices = normalizeOffices([
    { classification: "capitol", address: "Room 4S.2" },
    { classification: "district", phone: "5125550000" },
  ]);
  assert.equal(offices.length, 2);
});
