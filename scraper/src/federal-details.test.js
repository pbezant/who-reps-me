import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toOffice,
  termDatesFrom,
  dcOfficeFrom,
  buildCommitteesByBioguide,
  districtOfficesByBioguide,
} from "./federal-details.js";

// Shapes below are trimmed from real, live-fetched records (see federal-details.js's comments)
// rather than guessed — no network calls in this file itself.

test("toOffice() defaults every field to null except classification", () => {
  assert.deepEqual(toOffice({ classification: "dc" }), {
    classification: "dc",
    name: null,
    city: null,
    address: null,
    phone: null,
    fax: null,
    hours: null,
  });
});

test("termDatesFrom() reads the last (current) term, not the first", () => {
  const person = {
    terms: [
      { type: "rep", start: "1993-01-05", end: "1995-01-03" },
      { type: "sen", start: "2019-01-03", end: "2025-01-03" },
      { type: "sen", start: "2025-01-03", end: "2031-01-03" },
    ],
  };
  assert.deepEqual(termDatesFrom(person), { term_start: "2025-01-03", term_end: "2031-01-03" });
});

test("termDatesFrom() tolerates a person with no terms", () => {
  assert.deepEqual(termDatesFrom({}), { term_start: null, term_end: null });
  assert.deepEqual(termDatesFrom(undefined), { term_start: null, term_end: null });
});

test("dcOfficeFrom() maps the current term's Washington office", () => {
  const person = {
    terms: [
      {
        type: "sen",
        address: "511 Hart Senate Office Building Washington DC 20510",
        phone: "202-224-3441",
        fax: "202-228-0514",
        office: "511 Hart Senate Office Building",
      },
    ],
  };
  assert.deepEqual(dcOfficeFrom(person), {
    classification: "dc",
    name: "511 Hart Senate Office Building",
    city: null,
    address: "511 Hart Senate Office Building Washington DC 20510",
    phone: "202-224-3441",
    fax: "202-228-0514",
    hours: null,
  });
});

test("dcOfficeFrom() returns null when the current term has no office details at all", () => {
  assert.equal(dcOfficeFrom({ terms: [{ type: "rep" }] }), null);
  assert.equal(dcOfficeFrom({ terms: [] }), null);
});

test("buildCommitteesByBioguide() inverts membership onto bioguide and joins committee names", () => {
  const committeeMembership = {
    SSAF: [
      { name: "John Boozman", party: "majority", rank: 1, title: "Chairman", bioguide: "B001236" },
      { name: "Amy Klobuchar", party: "minority", rank: 1, title: "Ranking Member", bioguide: "K000367" },
    ],
  };
  const committees = [{ type: "senate", name: "Senate Committee on Agriculture, Nutrition, and Forestry", thomas_id: "SSAF" }];

  const byBioguide = buildCommitteesByBioguide(committeeMembership, committees);
  assert.deepEqual(byBioguide.get("B001236"), [
    { id: "SSAF", name: "Senate Committee on Agriculture, Nutrition, and Forestry", role: "Chairman" },
  ]);
  assert.deepEqual(byBioguide.get("K000367"), [
    { id: "SSAF", name: "Senate Committee on Agriculture, Nutrition, and Forestry", role: "Ranking Member" },
  ]);
});

test("buildCommitteesByBioguide() falls back to the raw committee id when no name joins", () => {
  const byBioguide = buildCommitteesByBioguide({ XXYY: [{ bioguide: "Z000001" }] }, []);
  assert.deepEqual(byBioguide.get("Z000001"), [{ id: "XXYY", name: "XXYY", role: null }]);
});

test("buildCommitteesByBioguide() joins a subcommittee membership key to its parent + sub name", () => {
  const committeeMembership = { SSAF13: [{ name: "Cindy Hyde-Smith", bioguide: "H001079", title: "Chairman" }] };
  const committees = [
    {
      thomas_id: "SSAF",
      name: "Senate Committee on Agriculture, Nutrition, and Forestry",
      subcommittees: [{ name: "Livestock, Marketing, and Agriculture Security", thomas_id: "13" }],
    },
  ];
  const byBioguide = buildCommitteesByBioguide(committeeMembership, committees);
  assert.deepEqual(byBioguide.get("H001079"), [
    {
      id: "SSAF13",
      name: "Senate Committee on Agriculture, Nutrition, and Forestry — Livestock, Marketing, and Agriculture Security",
      role: "Chairman",
    },
  ]);
});

test("buildCommitteesByBioguide() tolerates missing/empty inputs", () => {
  assert.deepEqual([...buildCommitteesByBioguide(undefined, undefined).entries()], []);
  assert.deepEqual([...buildCommitteesByBioguide({}, []).entries()], []);
});

test("districtOfficesByBioguide() maps the real nested {id, offices[]} shape, not a flat list", () => {
  const raw = [
    {
      id: { bioguide: "A000055", govtrack: 400004 },
      offices: [
        {
          id: "A000055-cullman",
          address: "205 4th Ave. NE",
          suite: "Suite 104",
          city: "Cullman",
          state: "AL",
          zip: "35055",
          fax: "202-225-5587",
          phone: "256-734-6043",
        },
        {
          id: "A000055-jasper",
          address: "1710 Alabama Ave.",
          suite: "247",
          building: "Carl Elliott Building",
          city: "Jasper",
          state: "AL",
          phone: "205-221-2310",
        },
      ],
    },
  ];
  const byBioguide = districtOfficesByBioguide(raw);
  const offices = byBioguide.get("A000055");
  assert.equal(offices.length, 2);
  assert.deepEqual(offices[0], {
    classification: "district",
    name: "Suite 104",
    city: "Cullman",
    address: "205 4th Ave. NE",
    phone: "256-734-6043",
    fax: "202-225-5587",
    hours: null,
  });
  assert.equal(offices[1].name, "Carl Elliott Building, 247");
});

test("districtOfficesByBioguide() carries a per-office hours field through when present", () => {
  const raw = [
    {
      id: { bioguide: "A000148" },
      offices: [{ id: "A000148-fall_river", address: "1 Government Center", city: "Fall River", hours: "Wednesday 10AM to 4PM" }],
    },
  ];
  const byBioguide = districtOfficesByBioguide(raw);
  assert.equal(byBioguide.get("A000148")[0].hours, "Wednesday 10AM to 4PM");
});

test("districtOfficesByBioguide() skips a member entry with no offices and tolerates missing input", () => {
  assert.equal(districtOfficesByBioguide([{ id: { bioguide: "X" }, offices: [] }]).get("X"), undefined);
  assert.deepEqual([...districtOfficesByBioguide(undefined).entries()], []);
});
