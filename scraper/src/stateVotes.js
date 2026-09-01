// Parses Open States v3 /bills responses into the "recent legislative activity" shape the
// profile page renders — see netlify/functions/state-votes.mjs for the fetch itself and
// src/RepVotingRecord.js for the client. Deliberately scoped to bill sponsorship/cosponsorship,
// not true roll-call yes/no vote history: Open States' vote-event coverage is inconsistent
// enough by state (some states publish it, many don't) to not promise consistently for v1 — see
// the plan this shipped from.
//
// Confirmed against Open States v3's live OpenAPI spec (v3.openstates.org/openapi.json) on
// 2026-08-24: /bills' `sponsor` param "filters to only include bills sponsored by a given name
// or person ID" — exactly the person id already carried as `rep.id` for a state legislator card
// (see src/stateLegislators.js's toCard()). A sponsorship entry's classification/primary flag is
// what distinguishes "Primary sponsor" from "Cosponsor" below.

const MAX_ITEMS = 10;

export function parseStateBills(results, personId) {
  return (results || [])
    .slice(0, MAX_ITEMS)
    .map((bill) => ({
      identifier: bill.identifier || '',
      title: bill.title || '',
      url: bill.openstates_url || '',
      latestActionDate: bill.latest_action_date || null,
      latestActionDescription: bill.latest_action_description || '',
      role: roleFor(bill, personId),
    }))
    .filter((item) => item.title || item.identifier);
}

// Sponsorship entries reference the person two different ways depending on whether `include=
// sponsorships` expanded the nested person object — tolerate both rather than assuming one.
function roleFor(bill, personId) {
  const sponsorship = (bill.sponsorships || []).find(
    (s) => s?.person?.id === personId || s?.person_id === personId
  );
  if (!sponsorship) return '';
  return sponsorship.primary ? 'Primary sponsor' : 'Cosponsor';
}
