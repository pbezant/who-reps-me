// State legislators via Open States (v3 `people.geo`).
//
// WHY THIS EXISTS: 5calls does return state legislators, but it geocodes the raw location
// STRING we hand it, so a bare ZIP frequently resolves to a congressional district and no
// state ones — their docs call this out, since state districts are far smaller than a ZIP.
// Open States instead takes a lat/lng and does a real point-in-polygon lookup, and
// src/geocode.js already produces exactly those coordinates from the US Census geocoder.
//
// `people.geo` returns EVERY legislator at a point, federal included — a US Senator and US
// Representative come back alongside the statehouse ones. They are only distinguishable by
// `jurisdiction.classification` ("country" vs "state"); `current_role.org_classification` says
// "upper"/"lower" for both, so a US Senator reads as an upper-chamber member exactly like a
// state senator does. Everything federal is discarded here (see isStateJurisdiction) and still
// comes from 5calls, which is authoritative for Congress and supplies the field offices and
// bioguide ids the rest of the app keys on.
//
// The API key never reaches the browser — netlify/functions/state-legislators.mjs injects it
// server-side. This module is pure so it can be unit-tested without network or Netlify.
//
// The person→card mapping shared with the state-executive tier (phone/email/offices/social)
// lives in openStatesPerson.js — see that file's header comment.

import { classifySocial, phoneFrom, emailFrom, officesFrom, firstNonSocialLink } from './openStatesPerson';

// Re-exported for existing importers/tests — this module used to own classifySocial itself.
export { classifySocial };

// The one reliable federal/state discriminator in the payload. Confirmed against a live
// response: US members carry jurisdiction.classification "country" with a non-numeric district
// ("Texas" for a Senator, "TX-37" for a Representative) and a `cd:`/bare-state division_id,
// while state legislators carry "state" and an `sldl:`/`sldu:` division. Requiring an explicit
// "state" — rather than merely excluding "country" — is the safe direction: if this field ever
// goes missing, the caller keeps 5calls' state reps instead of promoting a US Senator into the
// statehouse.
function isStateJurisdiction(person) {
  return person?.jurisdiction?.classification === 'state';
}

// Nebraska's unicameral legislature classifies as "legislature" rather than upper/lower; it is
// a senate in everything but name, so render it on the upper-chamber card instead of dropping
// the state's only legislator.
function areaForChamber(orgClassification) {
  if (orgClassification === 'upper' || orgClassification === 'legislature') return 'StateUpper';
  if (orgClassification === 'lower') return 'StateLower';
  return null;
}

// Map one Open States person onto the same card shape 5calls' reps use, so Results renders
// every level uniformly and needs no branch for where a record came from.
function toCard(person, state) {
  if (!isStateJurisdiction(person)) return null;
  const role = person?.current_role || {};
  const area = areaForChamber(role.org_classification);
  if (!area) return null;

  const district = role.district === 0 || role.district ? String(role.district) : '';
  const links = person?.links || [];
  const firstNonSocial = firstNonSocialLink(links);

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
    offices: officesFrom(person),
    isStateLegislator: true,
  };
}

// Keeps only the state legislators: federal members share the endpoint (see
// isStateJurisdiction) and a person without a current_role we can place on a chamber has
// nothing renderable.
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
