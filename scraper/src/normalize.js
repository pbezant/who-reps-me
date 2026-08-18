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
    address: raw.address ? String(raw.address).trim() : null,
    jurisdiction: { city: jurisdiction.city, state: jurisdiction.state },
    source_url: sourceUrl,
    extracted_at: extractedAt,
    confidence: typeof raw.confidence === "number" ? raw.confidence : null,
  };
}
