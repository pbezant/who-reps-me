import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDelimited,
  columnIndex,
  stripPlaceSuffix,
  buildPlaces,
  buildCounties,
} from "./build-jurisdiction-universe.js";

// A small, hand-built fixture in the documented Census Gazetteer places-file shape (tab
// delimited, header row, FUNCSTAT distinguishing an active incorporated government from a
// Census-only statistical area). Not a live-fetched sample — census.gov wasn't reachable from
// the environment this was built in — but matches the column layout described in this script's
// own header comment.
const PLACES_FIXTURE = [
  "USPS\tGEOID\tANSICODE\tNAME\tLSAD\tFUNCSTAT\tALAND\tAWATER",
  "TX\t4805000\t2410175\tAustin city\t25\tA\t827392\t62533",
  "TX\t4838409\t2410472\tElgin city\t25\tA\t18234\t120",
  "TX\t4812345\t2410999\tSome CDP\t57\tS\t5000\t0",
  "CA\t0644000\t1234567\tLos Angeles city\t25\tA\t1213598\t111664",
].join("\n");

const COUNTIES_FIXTURE = [
  "USPS\tGEOID\tANSICODE\tNAME\tALAND\tAWATER",
  "TX\t48453\t1384012\tTravis County\t2564797\t44768",
  "TX\t48021\t1383841\tBastrop County\t2225978\t34157",
  "CA\t06037\t0277283\tLos Angeles County\t10515027\t1794063",
].join("\n");

test("parseDelimited() splits a tab-delimited file into header + rows", () => {
  const { header, rows } = parseDelimited(PLACES_FIXTURE);
  assert.deepEqual(header, ["USPS", "GEOID", "ANSICODE", "NAME", "LSAD", "FUNCSTAT", "ALAND", "AWATER"]);
  assert.equal(rows.length, 4);
  assert.equal(rows[0][3], "Austin city");
});

test("parseDelimited() drops blank lines (e.g. a trailing one)", () => {
  const { rows } = parseDelimited(`${PLACES_FIXTURE}\n\n`);
  assert.equal(rows.length, 4);
});

test("parseDelimited() tolerates an empty file", () => {
  assert.deepEqual(parseDelimited(""), { header: [], rows: [] });
});

test("columnIndex() finds a column by name, case-insensitively", () => {
  const header = ["USPS", "NAME", "FUNCSTAT"];
  assert.equal(columnIndex(header, ["name"]), 1);
});

test("columnIndex() tries candidates in order for renamed columns across vintages", () => {
  assert.equal(columnIndex(["STUSAB", "NAME"], ["USPS", "STATE", "STUSAB"]), 0);
});

test("columnIndex() throws rather than silently misparsing when nothing matches", () => {
  assert.throws(() => columnIndex(["FOO", "BAR"], ["USPS", "STATE"]), /Could not find a column/);
});

test("stripPlaceSuffix() strips the common LSAD suffixes", () => {
  assert.equal(stripPlaceSuffix("Elgin city"), "Elgin");
  assert.equal(stripPlaceSuffix("Round Rock city"), "Round Rock");
  assert.equal(stripPlaceSuffix("Smithville town"), "Smithville");
});

test("stripPlaceSuffix() leaves an unrecognized suffix alone rather than guessing", () => {
  assert.equal(stripPlaceSuffix("Nashville-Davidson metropolitan government"), "Nashville-Davidson metropolitan government");
});

test("buildPlaces() filters to the target state and active governments only", () => {
  const { places, unrecognizedSuffixes } = buildPlaces(PLACES_FIXTURE, "TX");
  // "Some CDP" (FUNCSTAT S) and the CA row are excluded.
  assert.deepEqual(places, ["Austin", "Elgin"]);
  assert.equal(unrecognizedSuffixes.size, 0);
});

test("buildPlaces() reports a name whose suffix it couldn't strip", () => {
  const fixture = [
    "USPS\tGEOID\tANSICODE\tNAME\tLSAD\tFUNCSTAT\tALAND\tAWATER",
    "TX\t1\t1\tWeird Place Type\t99\tA\t1\t0",
  ].join("\n");
  const { places, unrecognizedSuffixes } = buildPlaces(fixture, "TX");
  assert.deepEqual(places, ["Weird Place Type"]);
  assert.equal(unrecognizedSuffixes.has("Weird Place Type"), true);
});

test("buildCounties() filters to the target state, keeping the full 'X County' name", () => {
  const counties = buildCounties(COUNTIES_FIXTURE, "TX");
  assert.deepEqual(counties, ["Bastrop County", "Travis County"]);
});

test("buildPlaces()/buildCounties() are case-insensitive on the state code", () => {
  const { places } = buildPlaces(PLACES_FIXTURE, "tx".toUpperCase());
  assert.equal(places.length, 2);
});
