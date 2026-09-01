// Parses Congress.gov API v3 member sponsored/cosponsored-legislation responses into the "recent
// legislative activity" shape the profile page renders — see netlify/functions/federal-votes.mjs
// for the fetch itself and src/RepVotingRecord.js for the client. Scoped to bill sponsorship/
// cosponsorship, not true roll-call yes/no vote history: Congress.gov's v3 API has no clean
// per-member vote-history endpoint (ProPublica's Congress API, which historically covered this,
// was discontinued) — see the plan this shipped from.
//
// Field names confirmed against LibraryOfCongress/api.congress.gov's own Documentation/
// BillEndpoint.md on 2026-08-24: a bill item carries `congress`, `type` (HR/S/HJRES/SJRES/
// HCONRES/SCONRES/HRES/SRES), `number`, `title`, and `latestAction: {actionDate, text}`. The
// item's own `url` field is an api.congress.gov JSON endpoint, not a page a person can read —
// congressBillUrl() below builds the public congress.gov page instead.

const CHAMBER_BILL_PATH = {
  HR: 'house-bill',
  S: 'senate-bill',
  HJRES: 'house-joint-resolution',
  SJRES: 'senate-joint-resolution',
  HCONRES: 'house-concurrent-resolution',
  SCONRES: 'senate-concurrent-resolution',
  HRES: 'house-resolution',
  SRES: 'senate-resolution',
};

// congress.gov's own URLs use a real English ordinal suffix (101st, 102nd, 103rd, 111th, 118th,
// ...), not a flat "th" — the 11/12/13 exception applies regardless of the trailing digit.
function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export function congressBillUrl({ congress, type, number } = {}) {
  const path = CHAMBER_BILL_PATH[String(type || '').toUpperCase()];
  if (!path || !congress || !number) return '';
  return `https://www.congress.gov/bill/${ordinal(Number(congress))}-congress/${path}/${number}`;
}

const MAX_ITEMS = 10;

function toItem(bill, role) {
  const identifier = bill?.type && bill?.number ? `${String(bill.type).toUpperCase()} ${bill.number}` : '';
  return {
    identifier,
    title: bill?.title || '',
    url: congressBillUrl(bill),
    latestActionDate: bill?.latestAction?.actionDate || null,
    latestActionDescription: bill?.latestAction?.text || '',
    role,
  };
}

export function parseCongressLegislation(items, role) {
  return (items || []).map((bill) => toItem(bill, role)).filter((item) => item.title || item.identifier);
}

// Combines sponsored + cosponsored legislation into one list, most recent action first, capped
// to what the profile page actually shows — a rep's history can run into the hundreds of bills
// over a career, and this section is a summary, not a full record.
export function mergeCongressActivity(sponsored, cosponsored) {
  const merged = [...parseCongressLegislation(sponsored, 'Sponsor'), ...parseCongressLegislation(cosponsored, 'Cosponsor')];
  merged.sort((a, b) => (b.latestActionDate || '').localeCompare(a.latestActionDate || ''));
  return merged.slice(0, MAX_ITEMS);
}
