// State executive officials for a state, via Open States API v3 (`/people`, filtered to
// `org_classification=executive`) — Governor, Lieutenant Governor, Attorney General, Secretary
// of State, and whatever else that state has curated. See src/stateExecutives.js's header
// comment for why this is a separate query from state-legislators.mjs's `people.geo` (that
// endpoint explicitly excludes governors) and for what coverage to expect.
//
// Cached per STATE, not per coordinate: every address in a state has the same Governor, so
// there's no reason to round-trip a fresh Open States call — or spend a fresh cache entry — per
// searched location the way the per-point legislator lookup does.
//
// Setup: same OPENSTATES_API_KEY as state-legislators.mjs (see that file's header comment for
// where to get one). Without it this returns an empty list and the app simply shows no state
// executives — no error surfaces to the user.

import { getStore } from "@netlify/blobs";

const OPENSTATES_URL = "https://v3.openstates.org/people";
const STORE_NAME = "state-executives";
// Governors/AGs/etc. turn over at elections, not redistricting — a much slower cadence than the
// legislator lookup's district boundaries — so a longer cache window than that one's 30 days is
// safe. 90 days comfortably outlasts any mid-term resignation/appointment without needing a
// manual cache-bust, while still catching a new term within a season of it starting.
const TTL_MS = 1000 * 60 * 60 * 24 * 90;

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
  const state = (url.searchParams.get("state") || "").toUpperCase();

  // Open States' own jurisdiction filter only takes the abbr-lookup path for exactly two
  // characters (github.com/openstates/api-v3, api/utils.py) — anything else falls through to a
  // full-name-equality match that would just silently return nothing for "TX", so reject early
  // with a clear error rather than making a request that's quietly guaranteed to be empty.
  if (!/^[A-Z]{2}$/.test(state)) {
    return jsonResponse({ error: "state must be a two-letter state abbreviation" }, 400);
  }

  const apiKey = process.env.OPENSTATES_API_KEY;
  if (!apiKey) {
    return jsonResponse({ results: [], reason: "OPENSTATES_API_KEY not set" });
  }

  const store = openStore();
  if (store) {
    try {
      const cached = await store.get(state, { type: "json" });
      if (cached && Date.now() - cached.checked_at < TTL_MS) {
        return jsonResponse({ results: cached.results, source: "cache" });
      }
    } catch {
      /* fall through to a live lookup */
    }
  }

  const query =
    `${OPENSTATES_URL}?jurisdiction=${encodeURIComponent(state)}&org_classification=executive` +
    `&include=offices&include=links`;

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

  if (store) {
    try {
      await store.setJSON(state, { results, checked_at: Date.now() });
    } catch {
      /* a cache write failure must not fail the response */
    }
  }

  return jsonResponse({ results, source: "openstates" });
};

export const config = { path: "/api/state-executives" };
