import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, buildId, normalizeOffices, mergeRecordFields, mergeEnrichment } from "./normalize.js";

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

test("mergeRecordFields() keeps an existing value when the incoming record has null for it", () => {
  const existing = { id: "x", name: "Pat Example", photo_url: "https://example.com/p.jpg", hours: "9-5 M-F" };
  const incoming = { id: "x", name: "Pat Example", photo_url: null, hours: null };
  const merged = mergeRecordFields(existing, incoming);
  assert.equal(merged.photo_url, "https://example.com/p.jpg");
  assert.equal(merged.hours, "9-5 M-F");
});

test("mergeRecordFields() lets a non-null incoming value win over an existing one", () => {
  const existing = { id: "x", phone: "512-555-0000" };
  const incoming = { id: "x", phone: "512-555-9999" };
  assert.equal(mergeRecordFields(existing, incoming).phone, "512-555-9999");
});

test("mergeRecordFields() always takes the incoming value for provenance/identity fields, even if falsy", () => {
  const existing = { id: "x", office: "Council Member", extracted_at: "2026-01-01T00:00:00.000Z", confidence: 1 };
  const incoming = { id: "x", office: "City Council Member", extracted_at: "2026-02-01T00:00:00.000Z", confidence: 0.5 };
  const merged = mergeRecordFields(existing, incoming);
  assert.equal(merged.office, "City Council Member");
  assert.equal(merged.extracted_at, "2026-02-01T00:00:00.000Z");
  assert.equal(merged.confidence, 0.5);
});

test("mergeRecordFields() merges social per-platform rather than replacing the whole object", () => {
  const existing = { id: "x", social: { twitter: "https://twitter.com/a", facebook: null } };
  const incoming = { id: "x", social: { twitter: null, facebook: "https://facebook.com/a" } };
  assert.deepEqual(mergeRecordFields(existing, incoming).social, {
    twitter: "https://twitter.com/a",
    facebook: "https://facebook.com/a",
  });
});

test("mergeRecordFields() merges offices by dedup key instead of replacing the whole list", () => {
  const existing = { id: "x", offices: [{ classification: "capitol", address: "100 Main St", phone: null }] };
  const incoming = {
    id: "x",
    offices: [
      { classification: "capitol", address: "100 Main St", phone: "512-555-0000" },
      { classification: "district", address: "200 Oak St", phone: "512-555-1111" },
    ],
  };
  const merged = mergeRecordFields(existing, incoming);
  assert.equal(merged.offices.length, 2);
  const capitol = merged.offices.find((o) => o.classification === "capitol");
  assert.equal(capitol.phone, "512-555-0000"); // filled in by the incoming pass
  assert.equal(capitol.address, "100 Main St"); // kept from the existing entry
});

test("mergeRecordFields() tolerates a missing existing or incoming record", () => {
  const rec = { id: "x", name: "Pat" };
  assert.deepEqual(mergeRecordFields(null, rec), rec);
  assert.deepEqual(mergeRecordFields(rec, null), rec);
});

test("mergeEnrichment() fills a null photo_url from a bio page without touching an already-populated phone", () => {
  const record = normalize(
    { name: "Vanessa Fuentes", office: "Council Member", phone: "5125551234" },
    { jurisdiction: AUSTIN, sourceUrl: "https://example.com", extractedAt: "2026-01-01T00:00:00.000Z" }
  );
  assert.equal(record.photo_url, null);

  const merged = mergeEnrichment(
    record,
    { photo_url: "headshot.jpg", phone: "5129999999" },
    { sourceUrl: "https://example.com/bio/fuentes", extractedAt: "2026-02-01T00:00:00.000Z" }
  );
  assert.equal(merged.photo_url, "https://example.com/bio/headshot.jpg");
  assert.equal(merged.phone, "512-555-1234"); // roster-page phone survives, not overwritten
  assert.equal(merged.bio_checked_at, "2026-02-01T00:00:00.000Z");
});

test("mergeEnrichment() stamps bio_checked_at even when the bio page had nothing new", () => {
  const record = normalize(
    { name: "Vanessa Fuentes", office: "Council Member" },
    { jurisdiction: AUSTIN, sourceUrl: "https://example.com", extractedAt: "2026-01-01T00:00:00.000Z" }
  );
  const merged = mergeEnrichment(record, {}, { sourceUrl: "https://example.com/bio", extractedAt: "2026-02-01T00:00:00.000Z" });
  assert.equal(merged.photo_url, null);
  assert.equal(merged.bio_checked_at, "2026-02-01T00:00:00.000Z");
});
