// Normalize a raw extracted official into the canonical record we store and serve.
// Every record carries provenance (source_url, extracted_at) and confidence so the
// frontend can show a "verified on" date and never present stale data as fresh.

function cleanPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d]/g, "");
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === "1")
    return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  return String(phone).trim();
}

function absolutize(maybeUrl, base) {
  if (!maybeUrl) return null;
  try {
    return new URL(maybeUrl, base).href;
  } catch {
    return null;
  }
}

// Straight and curly single/double quote characters. Different scrape runs (and different
// LLM extractions of the same page) render a quoted nickname inconsistently — e.g. José
// "Chito" Vela vs José 'Chito' Vela vs José "Chito" Vela — so these are stripped entirely
// before a name/office feeds into the id. The displayed `name`/`office` fields are untouched.
const QUOTE_CHARS = /['"‘’‚‛“”„‟′″]/g;

function stripQuotes(str) {
  return String(str || "").replace(QUOTE_CHARS, "");
}

// Canonicalize an office/title string for id-matching purposes only. Two scrape runs (or two
// LLM extractions of the same page) routinely phrase the exact same real-world office
// differently — "City Council Member" vs "Council Member" vs "Councilmember", or
// "Mayor Pro Tem / Council Member" vs "Mayor Pro Tem/Council Member" — and since the id used
// to fold the raw string in verbatim, upsertById() (output.js) saw those as two different
// people and kept both forever instead of the newer one replacing the older. This collapses
// known equivalent phrasings to one canonical form so re-scrapes upsert onto the same record.
//
// Office is still part of the id (not dropped): a person who legitimately holds two distinct
// offices in the same jurisdiction (e.g. "Mayor" and, separately, "Council Member") must still
// get two separate records, so canonicalization only folds together wording that refers to the
// same office, never distinct offices into one.
function canonicalizeOffice(office) {
  const cleaned = stripQuotes(office)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\bcouncilmember\b/g, "council member")
    .replace(/\bcity council member\b/g, "council member");
  return cleaned || "?";
}

// Stable-ish id for upsert: jurisdiction + canonicalized office + canonicalized name. Exported
// so the output-side cleanup tooling can recompute the same id from already-normalized records
// (dedupe-shards.js), without duplicating this logic.
export function buildId(jurisdiction, office, name) {
  const canonicalName = stripQuotes(name).toLowerCase().trim().replace(/\s+/g, " ");
  return `${jurisdiction.state}:${jurisdiction.city}:${canonicalizeOffice(office)}:${canonicalName}`
    .toLowerCase()
    .replace(/\s+/g, "-");
}

const SOCIAL_PLATFORMS = ["twitter", "facebook", "instagram", "linkedin", "youtube"];

// Always emit every platform key (null when absent) so every record has the same shape —
// the frontend can render a fixed set of icon slots without checking each key exists first.
function normalizeSocial(raw, base) {
  const social = {};
  for (const platform of SOCIAL_PLATFORMS) {
    social[platform] = absolutize(raw?.[platform], base);
  }
  return social;
}

// Canonical shape for one physical office (capitol, district, field, DC, ...) — the same shape
// is reused identically across local (this scraper), state (Open States' `offices`, see
// src/stateLegislators.js), and federal (5calls' `field_offices` + the congress-legislators
// YAML files, see src/App.js) so the frontend renders every tier's "other offices" the same
// way. `classification` is deliberately not validated against a fixed enum — sources disagree
// on the exact string ("capitol", "district-mail", "dc", ...) and passing it through as-is is
// more useful than collapsing it. `address`/`hours` are free text, not URLs, so unlike `url`/
// `photo_url` elsewhere in this module they are never absolutized.
//
// Nothing populates this from the roster-page extraction yet (raw.offices is undefined for
// every call today) — this is schema groundwork for the bio-page follow-up crawl and the
// state/federal enrichment that read it. Every consumer must read `record.offices || []`,
// never assume the key is present, since committed records scraped before this change won't
// have it at all.
export function normalizeOffices(rawOffices) {
  if (!Array.isArray(rawOffices)) return [];
  return rawOffices
    .map((o) => ({
      classification: o?.classification ? String(o.classification).trim() : "other",
      name: o?.name ? String(o.name).trim() : null,
      city: o?.city ? String(o.city).trim() : null,
      address: o?.address ? String(o.address).trim() : null,
      phone: cleanPhone(o?.phone),
      fax: o?.fax ? String(o.fax).trim() : null,
      hours: o?.hours ? String(o.hours).trim() : null,
    }))
    // Drop an entry that carried nothing usable at all (e.g. a source's placeholder row) —
    // never render an office row with every field blank.
    .filter((o) => o.address || o.phone || o.fax || o.hours);
}

export function normalize(raw, { jurisdiction, sourceUrl, extractedAt }) {
  const name = (raw.name || "").trim();
  if (!name) return null;
  return {
    id: buildId(jurisdiction, raw.office, name),
    name,
    office: (raw.office || "").trim() || null,
    level: jurisdiction.level || "local",
    body: jurisdiction.body || null,
    district: raw.district || null,
    phone: cleanPhone(raw.phone),
    email: raw.email ? String(raw.email).trim() : null,
    url: absolutize(raw.url, sourceUrl),
    photo_url: absolutize(raw.photo_url, sourceUrl),
    social: normalizeSocial(raw.social, sourceUrl),
    address: raw.address ? String(raw.address).trim() : null,
    offices: normalizeOffices(raw.offices),
    // Only ever populated by the bio-page follow-up pass (see pipeline.js/extractOfficialDetail
    // in extract.js) — a roster-page-only extraction always leaves these null.
    hours: raw.hours ? String(raw.hours).trim() : null,
    bio: raw.bio ? String(raw.bio).trim() : null,
    // Stamped whenever a bio-page enrichment attempt was made for this official, whether or not
    // it found anything new — lets pipeline.js skip a record that was recently checked and
    // genuinely has nothing further to find, instead of re-fetching its bio page (and spending
    // budget on it) every single run. See mergeEnrichment() below.
    bio_checked_at: null,
    jurisdiction: { city: jurisdiction.city, state: jurisdiction.state },
    source_url: sourceUrl,
    extracted_at: extractedAt,
    confidence: typeof raw.confidence === "number" ? raw.confidence : null,
  };
}

// Fields that always take the incoming record's value on a merge, never falling back to an
// existing value: they describe *this* extraction (provenance/identity), not accumulated
// knowledge about the official, so an older value here would be actively wrong, not just less
// complete. Every other field is treated as "accumulated knowledge" — see mergeRecordFields().
const ALWAYS_INCOMING_FIELDS = new Set([
  "id",
  "name",
  "office",
  "level",
  "body",
  "district",
  "jurisdiction",
  "source_url",
  "extracted_at",
  "confidence",
  "bio_checked_at",
]);

// Merges one scalar value under either precedence direction: `incomingWins` is a normal
// re-scrape's "newer data wins, but a null finding never erases an old value" rule (used by
// mergeRecordFields()); the opposite direction is mergeEnrichment()'s "the roster page is the
// authoritative source, a bio-page follow-up only fills in what's still missing" rule — a bio
// page is never allowed to override data the roster page already found, even if it disagrees.
function mergeScalar(existingVal, incomingVal, incomingWins) {
  const has = (v) => v != null && v !== "";
  if (incomingWins) return has(incomingVal) ? incomingVal : existingVal;
  return has(existingVal) ? existingVal : incomingVal;
}

function mergeSocialWithPrecedence(existing, incoming, incomingWins) {
  const merged = { ...(existing || {}) };
  for (const [platform, url] of Object.entries(incoming || {})) {
    merged[platform] = mergeScalar(merged[platform], url, incomingWins);
  }
  return merged;
}

// Dedup key for one office entry. Two offices from different sources/passes are treated as
// "the same physical office" when they share a classification and the same address/city/phone/
// name (in that priority order, first non-empty wins) — deliberately NOT always phone: phone is
// often exactly the field a later pass is filling in, so keying on it would make an office an
// existing record already has (address known, phone null) look like a brand new one once a
// later pass supplies the phone, instead of the same office being enriched in place.
function officeKey(o) {
  const identity = o?.address || o?.city || o?.phone || o?.name || "";
  return `${o?.classification || ""}|${String(identity).toLowerCase()}`;
}

function mergeOfficeListsWithPrecedence(existing, incoming, incomingWins) {
  const byKey = new Map((existing || []).map((o) => [officeKey(o), o]));
  for (const inc of incoming || []) {
    const key = officeKey(inc);
    const prev = byKey.get(key);
    byKey.set(key, prev ? mergeFieldsWithPrecedence(prev, inc, incomingWins, EMPTY_SET) : inc);
  }
  return [...byKey.values()];
}

const EMPTY_SET = new Set();

function mergeFieldsWithPrecedence(existing, incoming, incomingWins, alwaysIncomingFields) {
  const merged = { ...existing };
  for (const key of Object.keys(incoming)) {
    if (alwaysIncomingFields.has(key)) {
      merged[key] = incoming[key];
      continue;
    }
    if (key === "social") {
      merged.social = mergeSocialWithPrecedence(existing.social, incoming.social, incomingWins);
      continue;
    }
    if (key === "offices") {
      merged.offices = mergeOfficeListsWithPrecedence(existing.offices, incoming.offices, incomingWins);
      continue;
    }
    merged[key] = mergeScalar(existing[key], incoming[key], incomingWins);
  }
  return merged;
}

// Merges an incoming record onto an existing one field-by-field, instead of a full replace: a
// field the incoming pass legitimately found nothing new for (null) keeps whatever the existing
// record already had, so a later run can never silently erase enrichment a previous pass already
// discovered. Used by output.js's upsertById() (a later scheduled run re-scraping this
// jurisdiction) — see scraper/README.md's "Photos and social links" section for why this exists.
// mergeEnrichment() below is the *opposite*-precedence sibling for a bio-page follow-up within
// the same run, not a use of this function — see its own comment for why they must differ.
export function mergeRecordFields(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return mergeFieldsWithPrecedence(existing, incoming, true, ALWAYS_INCOMING_FIELDS);
}

// Merges a bio-page extraction (see extractOfficialDetail() in extract.js — photo_url/address/
// phone/email/hours/bio/offices/social for ONE already-known official, not a full record) onto
// an existing normalized record. Cleans/absolutizes the raw fields the same way normalize()
// does, then fills in only whatever the existing record still has null — the REVERSE precedence
// from mergeRecordFields(): the roster page is the human-vetted-URL, authoritative source, and a
// bio-page follow-up is a supplementary lookup for gaps, never a second opinion that overrides
// what the roster page already said. bio_checked_at is stamped unconditionally (even when
// nothing new was found) so pipeline.js can skip re-fetching a bio page that was recently
// checked and genuinely had nothing further to give.
export function mergeEnrichment(record, raw, { sourceUrl, extractedAt }) {
  const detail = {
    phone: cleanPhone(raw?.phone),
    email: raw?.email ? String(raw.email).trim() : null,
    url: absolutize(raw?.url, sourceUrl),
    photo_url: absolutize(raw?.photo_url, sourceUrl),
    social: normalizeSocial(raw?.social, sourceUrl),
    address: raw?.address ? String(raw.address).trim() : null,
    offices: normalizeOffices(raw?.offices),
    hours: raw?.hours ? String(raw.hours).trim() : null,
    bio: raw?.bio ? String(raw.bio).trim() : null,
  };
  const merged = mergeFieldsWithPrecedence(record, detail, false, EMPTY_SET);
  merged.bio_checked_at = extractedAt;
  return merged;
}
