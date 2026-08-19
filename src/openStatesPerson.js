// Shared "Open States v3 person → app card" helpers.
//
// Split out of stateLegislators.js because a second tier now consumes the same person/office/
// link shape from Open States: stateExecutives.js (Governor, Lt. Governor, Attorney General,
// Secretary of State, ... — see that file's header comment for which endpoint and why it's a
// separate query from `people.geo`). Both tiers render onto the same card shape, so the mapping
// from a raw Open States person to phone/email/social/offices only needs to exist once.

const SOCIAL_HOSTS = [
  [/(^|\.)(twitter|x)\.com$/, 'twitter'],
  [/(^|\.)facebook\.com$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
];

// Open States `links` is a generic list of "related URLs" — a personal site, a campaign page,
// and sometimes social profiles, all mixed together with no type field. Classify by hostname
// so the social row renders the same shape the scraper produces (see scraper/src/media.js).
export function classifySocial(links) {
  const social = { twitter: null, facebook: null, instagram: null, linkedin: null, youtube: null };
  for (const link of links || []) {
    const url = typeof link === 'string' ? link : link?.url;
    if (!url) continue;
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue; // not a usable absolute URL
    }
    for (const [pattern, platform] of SOCIAL_HOSTS) {
      // First match wins: an official account is listed before a campaign one often enough
      // that overwriting with a later link tends to make the result worse, not better.
      if (pattern.test(host) && !social[platform]) social[platform] = url;
    }
  }
  return social;
}

// Offices carry the phone. Prefer the capitol office (staffed year-round and the number these
// APIs keep most current) over a district one, but take whatever has a number rather than
// showing none. Older payloads used `contact_details` instead of `offices`, so read both.
export function phoneFrom(person) {
  const offices = person?.offices || [];
  const capitol = offices.find((o) => o?.classification === 'capitol' && o?.voice);
  if (capitol) return capitol.voice;
  const anyOffice = offices.find((o) => o?.voice);
  if (anyOffice) return anyOffice.voice;
  const legacy = (person?.contact_details || []).find((c) => c?.type === 'voice' && c?.value);
  return legacy ? legacy.value : '';
}

export function emailFrom(person) {
  if (person?.email) return person.email;
  const legacy = (person?.contact_details || []).find((c) => c?.type === 'email' && c?.value);
  return legacy ? legacy.value : '';
}

// Maps Open States' full `offices` array onto the shared cross-tier office shape (see
// scraper/src/normalize.js's normalizeOffices() for the same shape used by the scraper and
// federal enrichment) — purely additive alongside phoneFrom() above, which stays the single
// top-level `phone` convenience field (still prefers the capitol office). Confirmed against a
// real response (src/__fixtures__/openstates-people-geo.json): `classification` values include
// "capitol" and "district-mail" (not a fixed enum, passed through as-is); there is no `city` or
// `hours` field anywhere in this API's office schema, so those always come through null. An
// empty-string `voice` (seen on a real district-mail office with no phone) maps to null, not "".
export function officesFrom(person) {
  const offices = person?.offices || [];
  return offices
    .map((o) => ({
      classification: o?.classification || 'other',
      name: o?.name || null,
      city: null,
      address: o?.address || null,
      phone: o?.voice || null,
      fax: o?.fax || null,
      hours: null,
    }))
    // Drop an office row with nothing usable at all rather than rendering an empty entry.
    .filter((o) => o.address || o.phone || o.fax);
}

// Open States' `openstates_url` is the reliable per-person profile link; when it's absent, fall
// back to the first link that isn't one of the social platforms classifySocial() already
// claimed (a campaign/official site link, typically).
export function firstNonSocialLink(links) {
  return (links || []).find((l) => l?.url && !Object.values(classifySocial([l])).some(Boolean));
}
