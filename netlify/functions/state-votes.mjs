// Recent legislative activity (bill sponsorship/cosponsorship) for a state legislator, via Open
// States API v3's /bills endpoint — requested from src/RepVotingRecord.js when a state
// legislator's profile page opens. Same key-must-stay-server-side and CORS reasoning as
// state-legislators.mjs (see that file's own header comment) applies here.
//
// `personId` is `rep.id` for a state legislator card (see src/stateLegislators.js's toCard()) —
// Open States v3's own OCD person id, exactly what /bills' `sponsor` param filters on (confirmed
// against v3.openstates.org/openapi.json on 2026-08-24: "Filter to only include bills sponsored
// by a given name or person ID").
//
// `sponsor` alone isn't enough, though — confirmed directly against a live call: Open States
// returns a 400 ("either 'jurisdiction' or 'q' required") without a `jurisdiction` filter too, a
// requirement the OpenAPI spec's per-param docs don't mention. `jurisdiction` accepts a name
// ("Texas") or an OCD jurisdiction id, not a two-letter postal code, so this builds the id from
// `rep.state` — `ocd-jurisdiction/country:us/state:tx/government` — rather than maintaining a
// 50-state abbreviation→name table just for this one call.
//
// Setup: reuses OPENSTATES_API_KEY, already documented in scraper/README.md's "Setup: Netlify
// environment variables" section for state-legislators.mjs/state-executives.mjs — nothing new to
// configure. Without it, this returns an empty item list at HTTP 200, same fail-soft contract as
// those two functions.

import { getStore } from "@netlify/blobs";
import { parseStateBills } from "../../scraper/src/stateVotes.js";

const OPENSTATES_URL = "https://v3.openstates.org/bills";
const STORE_NAME = "state-votes";
// Legislative activity is time-sensitive — session bill actions happen weekly, not monthly — so
// this deliberately does not reuse state-legislators.mjs's 30-day TTL (districts, which that
// caches, only move at redistricting; bill status does not sit still anywhere near that long).
const TTL_MS = 1000 * 60 * 60 * 24;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Blobs is unavailable outside Netlify's runtime (plain `npm start`, some CI). Treat any
// failure as a cache miss rather than failing the request.
function openStore() {
  try {
    return getStore(STORE_NAME);
  } catch {
    return null;
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const personId = url.searchParams.get("personId");
  const state = url.searchParams.get("state");

  if (!personId || !state) {
    return jsonResponse({ error: "personId and state are required" }, 400);
  }

  const apiKey = process.env.OPENSTATES_API_KEY;
  if (!apiKey) {
    // Not an error: the profile page is fully usable without this section — respond 200 with a
    // reason so the client can show "not set up" rather than a spinner or a scary error.
    return jsonResponse({ items: [], reason: "OPENSTATES_API_KEY not set" });
  }

  const store = openStore();
  if (store) {
    try {
      const cached = await store.get(personId, { type: "json" });
      if (cached && Date.now() - cached.checked_at < TTL_MS) {
        return jsonResponse({ items: cached.items, source: "cache" });
      }
    } catch {
      /* fall through to a live lookup */
    }
  }

  const jurisdiction = `ocd-jurisdiction/country:us/state:${state.toLowerCase()}/government`;
  const query =
    `${OPENSTATES_URL}?sponsor=${encodeURIComponent(personId)}&jurisdiction=${encodeURIComponent(jurisdiction)}` +
    `&sort=latest_action_desc&per_page=10&include=sponsorships`;

  let payload;
  try {
    const res = await fetch(query, {
      headers: { "X-API-KEY": apiKey, accept: "application/json" },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return jsonResponse(
        { error: `Open States returned ${res.status}`, detail: detail.slice(0, 200) },
        res.status === 429 ? 429 : 502
      );
    }
    payload = await res.json();
  } catch (error) {
    return jsonResponse({ error: `Open States request failed: ${error.message}` }, 502);
  }

  const results = Array.isArray(payload?.results) ? payload.results : [];
  const items = parseStateBills(results, personId);

  if (store) {
    try {
      await store.setJSON(personId, { items, checked_at: Date.now() });
    } catch {
      /* a cache write failure must not fail the response */
    }
  }

  return jsonResponse({ items, source: "openstates" });
};

export const config = { path: "/api/state-votes" };
