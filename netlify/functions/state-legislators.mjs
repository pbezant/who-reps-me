// State legislators for a coordinate, via Open States API v3 (`people.geo`).
//
// This function exists for two reasons, both of which rule out calling Open States straight
// from the browser:
//
//   1. THE KEY. Open States keys carry a per-account daily quota (the default tier is small).
//      A key shipped in the JS bundle is a key anyone can copy and exhaust, which would take
//      state results down for every visitor.
//   2. CORS. v3 does not serve browser preflights, so a direct fetch from the app fails
//      regardless of the key.
//
// Coordinates come from src/geocode.js (US Census), so this is a real point-in-polygon
// district lookup rather than the string-geocoding 5calls does internally — which is the
// whole reason state reps go missing on bare-ZIP searches. See src/stateLegislators.js.
//
// Setup: set OPENSTATES_API_KEY in the Netlify site's environment variables (free key from
// https://open.pluralpolicy.com/). Without it this returns an empty list and the app simply
// keeps whatever state reps 5calls gave it — no error surfaces to the user.

import { getStore } from "@netlify/blobs";

const OPENSTATES_URL = "https://v3.openstates.org/people.geo";
const STORE_NAME = "state-legislators";
const TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days: districts only move at redistricting

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ~11m of precision. Deliberately finer than it needs to be for a cache: rounding coarsely
// would eventually put an address on the wrong side of a district line, and being wrong about
// someone's representative is a worse failure than a lower cache hit rate. Repeat searches of
// the same address — the case that actually matters for the daily quota — still hit.
function cacheKey(lat, lon) {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
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
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return jsonResponse({ error: "lat and lon are required" }, 400);
  }

  const apiKey = process.env.OPENSTATES_API_KEY;
  if (!apiKey) {
    // Not an error: the app is fully usable without this, so respond 200 and let the client
    // fall back to 5calls' state reps silently instead of logging a failure on every search.
    return jsonResponse({ results: [], reason: "OPENSTATES_API_KEY not set" });
  }

  const store = openStore();
  const key = cacheKey(lat, lon);
  if (store) {
    try {
      const cached = await store.get(key, { type: "json" });
      if (cached && Date.now() - cached.checked_at < TTL_MS) {
        return jsonResponse({ results: cached.results, source: "cache" });
      }
    } catch {
      /* fall through to a live lookup */
    }
  }

  // `include` is repeatable; offices carry the phone and links carry the social profiles.
  const query =
    `${OPENSTATES_URL}?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lon)}` +
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
      await store.setJSON(key, { results, checked_at: Date.now() });
    } catch {
      /* a cache write failure must not fail the response */
    }
  }

  return jsonResponse({ results, source: "openstates" });
};

export const config = { path: "/api/state-legislators" };
