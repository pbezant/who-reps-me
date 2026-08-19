// State executive officials via Open States (v3 `/people`, filtered to `org_classification=
// executive`) — Governor, Lieutenant Governor, Attorney General, Secretary of State, and
// whatever else a given state has curated (see below).
//
// WHY THIS IS A SEPARATE QUERY FROM `people.geo`: `people.geo` — what stateLegislators.js
// uses — is a lat/lng point-in-polygon lookup, and a statewide office has no district geometry
// to intersect. Confirmed straight from the endpoint's own implementation
// (github.com/openstates/api-v3, api/people.py): its docstring reads "Currently limited to
// state legislators and US Congress. Governors & mayors are not included." So this hits `/people`
// instead, filtered by `jurisdiction` (a plain two-letter state abbreviation works — see that
// same repo's `jurisdiction_filter()`) and `org_classification=executive` — one result per
// state, not per coordinate, since every address in a state has the same Governor.
//
// COVERAGE IS CURATED, NOT COMPREHENSIVE, AND VARIES BY STATE. Open States' underlying schema
// (github.com/openstates/openstates-core, openstates/models/people.py's EXECUTIVE_ROLES) covers
// governor, lt_governor, mayor, secretary of state, chief election officer, treasurer, auditor,
// comptroller, attorney general, commissioner, assessor, and district attorney — but a given
// state only has an entry for an office if someone has actually curated it. Texas, checked
// directly against github.com/openstates/people's data/tx/executive/, has exactly four: Governor,
// Lieutenant Governor, Attorney General, Secretary of State — no Comptroller, no Land/Agriculture
// Commissioner, and notably no Railroad Commissioner (an elected regulatory body that, as far as
// this schema goes, isn't a modeled office at all — "commissioner" alone would map to it, but no
// state currently has one curated under that role). Most states have 3-4 executive records;
// a few (Massachusetts, Alabama) have as many as 6-7. This module surfaces whatever a state has,
// rather than trying to guess at a fixed set of offices every state must have.
//
// The API key never reaches the browser — netlify/functions/state-executives.mjs injects it
// server-side, same as the legislator lookup. This module is pure so it can be unit-tested
// without network or Netlify. The person→card mapping (phone/email/offices/social) is shared
// with stateLegislators.js — see openStatesPerson.js.

import { classifySocial, phoneFrom, emailFrom, officesFrom, firstNonSocialLink } from './openStatesPerson';

// Same discriminator stateLegislators.js uses, for the same reason: requiring an explicit
// "state" (rather than merely not-"country") is the safe direction if this field ever goes
// missing — the person just doesn't render, instead of a guess landing them on the wrong tier.
function isStateJurisdiction(person) {
  return person?.jurisdiction?.classification === 'state';
}

function isExecutiveRole(person) {
  return person?.current_role?.org_classification === 'executive';
}

// "lt_governor" is the one RoleType value with an underscore instead of a space (see this
// module's header comment), so upstream's title-casing leaves it as "Lt_Governor" rather than
// splitting into words like every other executive title does. Fix that one case up; everything
// else (e.g. "Attorney General", "Secretary Of State") already reads fine, if imperfectly
// capitalized on short words — not worth a general re-title-casing pass for that alone.
function titleFrom(person) {
  const raw = person?.current_role?.title || '';
  return raw.replace(/^Lt_Governor$/, 'Lieutenant Governor').replace(/_/g, ' ');
}

// Map one Open States executive onto the same card shape state legislators/5calls reps use, so
// Results renders every level uniformly. `area` is the office title itself (e.g. "Governor",
// "Attorney General") rather than a fixed enum — Results just displays `rep.area` verbatim for
// anything that isn't StateUpper/StateLower/US House/US Senate, the same way a local official's
// `area` is whatever office title the scraper found.
function toCard(person, state) {
  if (!isStateJurisdiction(person) || !isExecutiveRole(person)) return null;
  const area = titleFrom(person);
  if (!area) return null;

  const links = person?.links || [];
  const firstNonSocial = firstNonSocialLink(links);

  return {
    id: person.id,
    name: person.name,
    area,
    state,
    party: person.party || '',
    district: '', // statewide office — never district-scoped
    phone: phoneFrom(person),
    email: emailFrom(person),
    url: person.openstates_url || firstNonSocial?.url || '',
    photoURL: person.image || '',
    social: classifySocial(links),
    offices: officesFrom(person),
    isStateExecutive: true,
  };
}

// Drops anyone the executive-branch filter shouldn't have returned (defensive — the
// org_classification=executive query param already does this filtering server-side) and anyone
// with no title to render.
export function toStateExecutiveCards(results, state) {
  return (results || []).map((p) => toCard(p, state)).filter(Boolean);
}

// Unlike mergeStateLegislators, this is pure addition, not a replace: 5calls never returns
// state executives at all (it's federal-only), so there is nothing here to swap out — only
// state reps have a same-tier 5calls entry to drop in favor of the Open States one. Fails soft
// the same way: a missing key or an uncovered state just means no executive cards to add, never
// fewer reps than before this feature existed.
export function mergeStateExecutives(representatives, executiveCards) {
  return [...(representatives || []), ...(executiveCards || [])];
}
