import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStateBills } from "./stateVotes.js";

const PERSON_ID = "ocd-person/1f9ed42e-27de-4cd1-b2bf-f890ee33cb49";

test("parseStateBills() maps identifier/title/url/action fields", () => {
  const results = [
    {
      identifier: "SB 113",
      title: "An act relating to public education funding",
      openstates_url: "https://openstates.org/tx/bills/89/SB113/",
      latest_action_date: "2026-03-14",
      latest_action_description: "Referred to committee",
      sponsorships: [{ person: { id: PERSON_ID }, primary: true }],
    },
  ];
  assert.deepEqual(parseStateBills(results, PERSON_ID), [
    {
      identifier: "SB 113",
      title: "An act relating to public education funding",
      url: "https://openstates.org/tx/bills/89/SB113/",
      latestActionDate: "2026-03-14",
      latestActionDescription: "Referred to committee",
      role: "Primary sponsor",
    },
  ]);
});

test("parseStateBills() labels a non-primary sponsorship as Cosponsor", () => {
  const results = [{ identifier: "HB 4", title: "x", sponsorships: [{ person: { id: PERSON_ID }, primary: false }] }];
  assert.equal(parseStateBills(results, PERSON_ID)[0].role, "Cosponsor");
});

test("parseStateBills() tolerates a flat person_id reference alongside the nested person object", () => {
  const results = [{ identifier: "HB 5", title: "x", sponsorships: [{ person_id: PERSON_ID, primary: true }] }];
  assert.equal(parseStateBills(results, PERSON_ID)[0].role, "Primary sponsor");
});

test("parseStateBills() leaves role empty when this person isn't in the sponsorships list", () => {
  const results = [{ identifier: "HB 6", title: "x", sponsorships: [{ person: { id: "someone-else" }, primary: true }] }];
  assert.equal(parseStateBills(results, PERSON_ID)[0].role, "");
});

test("parseStateBills() drops an entry with neither title nor identifier", () => {
  assert.deepEqual(parseStateBills([{ latest_action_date: "2026-01-01" }], PERSON_ID), []);
});

test("parseStateBills() caps the list at 10 and tolerates a missing/empty list", () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ identifier: `HB ${i}`, title: `Bill ${i}` }));
  assert.equal(parseStateBills(many, PERSON_ID).length, 10);
  assert.deepEqual(parseStateBills(undefined, PERSON_ID), []);
  assert.deepEqual(parseStateBills([], PERSON_ID), []);
});
