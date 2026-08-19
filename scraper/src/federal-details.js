// Builds public/federal-details.json: free, zero-LLM enrichment for current members of
// Congress, sourced entirely from the public-domain unitedstates/congress-legislators project
// (the same project federal-social.js already pulls from) plus, for a short bio blurb,
// Wikipedia's keyless REST summary API. No scraping, no LLM calls — same cost/reliability
// profile as federal-social.js, so it can run on the same schedule.
//
// Per bioguide id:
//   term_start / term_end  - from legislators-current.yaml's current (most recent) term entry
//   dc_office               - that same term's Washington office (address/room/phone/fax)
//   committees               - joined from committee-membership-current.yaml + committees-current.yaml
//   district_offices          - from legislators-district-offices.yaml. Crowdsourced from
//                                members' own sites, so coverage/freshness varies (an office
//                                needs at least an address or phone to be listed at all) — see
//                                "District-office coverage" logged below and scraper/README.md.
//                                This is the free path described in the README's Phase 3;
//                                federal-offices-llm.js (if it exists) is a bounded fallback
//                                scraper for whatever gap this leaves, not the primary source.
//   bio / bio_source           - a one-paragraph Wikipedia extract, keyed off id.wikipedia
//
// Usage:
//   node src/federal-details.js
//   SKIP_BIO=1 node src/federal-details.js   — skip the ~535 Wikipedia lookups (faster locally)

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const OUT_PATH = join(REPO_ROOT, "public", "federal-details.json");

const RAW_BASE = "https://raw.githubusercontent.com/unitedstates/congress-legislators/main";
const SOURCES = {
  current: `${RAW_BASE}/legislators-current.yaml`,
  committeeMembership: `${RAW_BASE}/committee-membership-current.yaml`,
  committees: `${RAW_BASE}/committees-current.yaml`,
  districtOffices: `${RAW_BASE}/legislators-district-offices.yaml`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchYaml(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  return yaml.load(await res.text());
}

// One physical office, matching scraper/src/normalize.js's normalizeOffices() shape — the same
// convention reused across local/state/federal so the frontend renders every tier's "other
// offices" identically.
export function toOffice({ classification, name, city, address, phone, fax, hours }) {
  return {
    classification,
    name: name || null,
    city: city || null,
    address: address || null,
    phone: phone || null,
    fax: fax || null,
    hours: hours || null,
  };
}

// legislators-current.yaml only lists people currently serving, and each person's `terms[]` is
// chronological, so the last entry is always their active term — confirmed against a live fetch
// of the file (Maria Cantwell's most recent Senate term is the last of six terms listed).
function currentTerm(person) {
  const terms = person?.terms || [];
  return terms[terms.length - 1] || null;
}

export function termDatesFrom(person) {
  const term = currentTerm(person);
  return { term_start: term?.start || null, term_end: term?.end || null };
}

export function dcOfficeFrom(person) {
  const term = currentTerm(person);
  if (!term || (!term.address && !term.phone && !term.office)) return null;
  return toOffice({
    classification: "dc",
    name: term.office || "Washington DC Office",
    address: term.address,
    phone: term.phone,
    fax: term.fax,
  });
}

// Inverts committee-membership-current.yaml (committee id -> members) into per-bioguide, then
// joins committee id -> human-readable name via committees-current.yaml. A subcommittee's own
// membership key is its parent thomas_id plus its own thomas_id concatenated (e.g. "SSAF13" for
// Senate Agriculture's subcommittee "13") — confirmed against a live fetch — and it isn't in
// committees-current.yaml's top-level list, so its name is looked up on the parent's
// `subcommittees[]` instead.
export function buildCommitteesByBioguide(committeeMembership, committees) {
  const nameById = new Map();
  for (const c of committees || []) {
    if (c.thomas_id) nameById.set(c.thomas_id, c.name);
    for (const sub of c.subcommittees || []) {
      if (c.thomas_id && sub.thomas_id) {
        nameById.set(`${c.thomas_id}${sub.thomas_id}`, `${c.name} — ${sub.name}`);
      }
    }
  }
  const byBioguide = new Map();
  for (const [committeeId, members] of Object.entries(committeeMembership || {})) {
    for (const m of members || []) {
      if (!m?.bioguide) continue;
      const list = byBioguide.get(m.bioguide) || [];
      list.push({ id: committeeId, name: nameById.get(committeeId) || committeeId, role: m.title || null });
      byBioguide.set(m.bioguide, list);
    }
  }
  return byBioguide;
}

// legislators-district-offices.yaml is nested per member ({id: {bioguide, ...}, offices: [...]})
// rather than a flat per-office list — confirmed against a live fetch of the file (an earlier
// draft of this plan assumed a flat shape; the real one groups every office under its member).
export function districtOfficesByBioguide(districtOffices) {
  const byBioguide = new Map();
  for (const entry of districtOffices || []) {
    const bioguide = entry?.id?.bioguide;
    if (!bioguide) continue;
    const offices = (entry.offices || []).map((o) =>
      toOffice({
        classification: "district",
        name: [o.building, o.suite].filter(Boolean).join(", "),
        city: o.city,
        address: o.address,
        phone: o.phone,
        fax: o.fax,
        hours: o.hours,
      })
    );
    if (offices.length) byBioguide.set(bioguide, offices);
  }
  return byBioguide;
}

// Wikipedia's keyless REST summary endpoint — one plain fetch per member with a Wikipedia
// article, called with a polite delay between requests (same spirit as run.js's sleep(1000)
// between jurisdictions). A miss (no article, disambiguation page, network error, non-2xx) is
// treated as bio: null rather than retried every run. A common name pointing at the wrong
// person isn't a risk here since id.wikipedia already names the exact article — no search
// involved, so no ambiguity to resolve.
export async function fetchBio(title) {
  if (!title) return null;
  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.extract ? { bio: data.extract, bio_source: "wikipedia" } : null;
  } catch {
    return null;
  }
}

async function main() {
  const skipBio = process.env.SKIP_BIO === "1";
  console.log("Fetching congress-legislators data...");
  const [current, committeeMembership, committees, districtOfficesRaw] = await Promise.all([
    fetchYaml(SOURCES.current),
    fetchYaml(SOURCES.committeeMembership),
    fetchYaml(SOURCES.committees),
    fetchYaml(SOURCES.districtOffices),
  ]);

  const committeesByBioguide = buildCommitteesByBioguide(committeeMembership, committees);
  const districtOfficesMap = districtOfficesByBioguide(districtOfficesRaw);

  const legislators = {};
  let bioCount = 0;
  let withDistrictOffices = 0;
  for (const [i, person] of (current || []).entries()) {
    const bioguide = person?.id?.bioguide;
    if (!bioguide) continue;

    let bio = null;
    let bio_source = null;
    if (!skipBio) {
      // Be polite: this is up to ~535 sequential requests to a free, keyless public API.
      if (i > 0) await sleep(150);
      const result = await fetchBio(person?.id?.wikipedia).catch(() => null);
      if (result) {
        bio = result.bio;
        bio_source = result.bio_source;
        bioCount++;
      }
    }

    const district_offices = districtOfficesMap.get(bioguide) || [];
    if (district_offices.length) withDistrictOffices++;

    legislators[bioguide] = {
      ...termDatesFrom(person),
      dc_office: dcOfficeFrom(person),
      committees: committeesByBioguide.get(bioguide) || [],
      district_offices,
      bio,
      bio_source,
    };
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  const generated_at = new Date().toISOString();
  const count = Object.keys(legislators).length;
  await writeFile(
    OUT_PATH,
    JSON.stringify(
      { generated_at, sources: Object.values(SOURCES), count, legislators },
      null,
      2
    )
  );
  console.log(
    `Wrote details for ${count} legislators to ${OUT_PATH}` +
      (skipBio ? " (bio lookups skipped)" : ` (${bioCount} bios found)`)
  );
  // Coverage measurement per the plan: decides whether a bounded LLM-scraper fallback for
  // district offices is worth building at all, or whether this free source already covers it.
  console.log(`District-office coverage: ${withDistrictOffices}/${count} members have >=1 crowdsourced district office.`);
}

// Only run the live fetch when this file is executed directly (npm run federal-details), not
// when it's imported for its exported pure functions — federal-details.test.js does exactly
// that, and without this guard importing it for tests would trigger a real ~535-member scrape
// (including live Wikipedia lookups) as a side effect of running the test suite.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
