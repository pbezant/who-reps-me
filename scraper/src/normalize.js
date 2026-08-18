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

export function normalize(raw, { jurisdiction, sourceUrl, extractedAt }) {
  const name = (raw.name || "").trim();
  if (!name) return null;
  return {
    // Stable-ish id for upsert: jurisdiction + office + name.
    id: `${jurisdiction.state}:${jurisdiction.city}:${raw.office || "?"}:${name}`
      .toLowerCase()
      .replace(/\s+/g, "-"),
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
    jurisdiction: { city: jurisdiction.city, state: jurisdiction.state },
    source_url: sourceUrl,
    extracted_at: extractedAt,
    confidence: typeof raw.confidence === "number" ? raw.confidence : null,
  };
}
