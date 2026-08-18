// State legislators via Open States (v3 `people.geo`).
//
// WHY THIS EXISTS: 5calls does return state legislators, but it geocodes the raw location
// STRING we hand it, so a bare ZIP frequently resolves to a congressional district and no
// state ones — their docs call this out, since state districts are far smaller than a ZIP.
// Open States instead takes a lat/lng and does a real point-in-polygon lookup, and
// src/geocode.js already produces exactly those coordinates from the US Census geocoder.
//
// Open States is STATE-ONLY (no Congress), so this supplements 5calls rather than replacing
// it: federal reps still come from 5calls, and 5calls' own state entries are only dropped
// when Open States actually returned something better (see mergeStateLegislators).
//
// The API key never reaches the browser — netlify/functions/state-legislators.mjs injects it
// server-side. This module is pure so it can be unit-tested without network or Netlify.

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

// Nebraska's unicameral legislature classifies as "legislature" rather than upper/lower; it is
// a senate in everything but name, so render it on the upper-chamber card instead of dropping
// the state's only legislator.
function areaForChamber(orgClassification) {
  if (orgClassification === 'upper' || orgClassification === 'legislature') return 'StateUpper';
  if (orgClassification === 'lower') return 'StateLower';
  return null;
}

// Offices carry the phone. Prefer the capitol office (staffed year-round and the number these
// APIs keep most current) over a district one, but take whatever has a number rather than
// showing none. Older payloads used `contact_details` instead of `offices`, so read both.
function phoneFrom(person) {
  const offices = person?.offices || [];
  const capitol = offices.find((o) => o?.classification === 'capitol' && o?.voice);
  if (capitol) return capitol.voice;
  const anyOffice = offices.find((o) => o?.voice);
  if (anyOffice) return anyOffice.voice;
  const legacy = (person?.contact_details || []).find((c) => c?.type === 'voice' && c?.value);
  return legacy ? legacy.value : '';
}

function emailFrom(person) {
  if (person?.email) return person.email;
  const legacy = (person?.contact_details || []).find((c) => c?.type === 'email' && c?.value);
  return legacy ? legacy.value : '';
}

// Map one Open States person onto the same card shape 5calls' reps use, so Results renders
// every level uniformly and needs no branch for where a record came from.
function toCard(person, state) {
  const role = person?.current_role || {};
  const area = areaForChamber(role.org_classification);
  if (!area) return null;

  const district = role.district === 0 || role.district ? String(role.district) : '';
  const links = person?.links || [];
  const firstNonSocial = links.find((l) => l?.url && !Object.values(classifySocial([l])).some(Boolean));

  return {
    id: person.id,
    name: person.name,
    area,
    state,
    party: person.party || '',
    district: district ? `District ${district}` : '',
    phone: phoneFrom(person),
    email: emailFrom(person),
    url: person.openstates_url || firstNonSocial?.url || '',
    photoURL: person.image || '',
    social: classifySocial(links),
    isStateLegislator: true,
  };
}

// Open States returns members whose term has ended alongside current ones in some payloads;
// only a person with a current_role we can place on a chamber is renderable.
export function toStateRepCards(results, state) {
  return (results || []).map((p) => toCard(p, state)).filter(Boolean);
}

const STATE_AREAS = new Set(['StateUpper', 'StateLower']);

// Swap 5calls' state legislators for the Open States ones, which came from a precise
// coordinate lookup rather than a geocoded string. Fails soft in the direction that keeps the
// most data: if Open States returned nothing (no key configured, upstream down, a state it
// doesn't cover), 5calls' own state entries are left exactly as they were.
export function mergeStateLegislators(representatives, stateCards) {
  const reps = representatives || [];
  if (!stateCards || stateCards.length === 0) return reps;
  // Federal first, then the replacement state cards — same top-to-bottom order 5calls itself
  // returned, so this doesn't reshuffle the page for an existing user.
  return [...reps.filter((r) => !STATE_AREAS.has(r.area)), ...stateCards];
}
