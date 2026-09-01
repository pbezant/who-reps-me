// Recent legislative activity (sponsored + cosponsored bills) for a member of Congress, via
// Congress.gov API v3 — requested from src/RepVotingRecord.js when a federal rep's profile page
// opens. Same key-must-stay-server-side reasoning as every other Netlify function in this app:
// a key shipped in the JS bundle is a key anyone can copy and exhaust.
//
// `bioguideId` is `rep.id` for a federal rep card — 5calls' own `id` for House/Senate members
// already IS the bioguide id (see scraper/src/federal-social.js's header comment), exactly what
// Congress.gov's member endpoints key on.
//
// True roll-call yes/no vote history is explicitly out of scope for v1: Congress.gov's v3 API
// has no clean per-member vote-history endpoint, and ProPublica's Congress API — which
// historically covered this — was discontinued. Bill sponsorship/cosponsorship is the reliable
// primitive available today.
//
// Setup: set CONGRESS_API_KEY in the Netlify site's environment variables (free key from
// https://api.congress.gov/sign-up/). Without it this returns an empty item list at HTTP 200,
// same fail-soft contract as every other key-gated function in this app — the profile page and
// this section ship fine before sign-up finishes, they just show "not set up yet" until then.

import { getStore } from "@netlify/blobs";
import { mergeCongressActivity } from "../../scraper/src/congressVotes.js";

const CONGRESS_API_BASE = "https://api.congress.gov/v3/member";
const STORE_NAME = "federal-votes";
// Same reasoning as state-votes.mjs: legislative activity is time-sensitive, so this
// deliberately uses a much shorter TTL than the 30/90-day caches used for slower-changing
// directory data elsewhere in this app.
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

async function fetchLegislation(kind, bioguideId, apiKey) {
  const url = `${CONGRESS_API_BASE}/${encodeURIComponent(bioguideId)}/${kind}-legislation` +
    `?api_key=${encodeURIComponent(apiKey)}&format=json&limit=15`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Congress.gov returned ${res.status} for ${kind}-legislation`);
  const payload = await res.json();
  return Array.isArray(payload?.[`${kind}Legislation`]) ? payload[`${kind}Legislation`] : [];
}

export default async (req) => {
  const url = new URL(req.url);
  const bioguideId = url.searchParams.get("bioguideId");

  if (!bioguideId) {
    return jsonResponse({ error: "bioguideId is required" }, 400);
  }

  const apiKey = process.env.CONGRESS_API_KEY;
  if (!apiKey) {
    // Not an error: the profile page is fully usable without this section — respond 200 with a
    // reason so the client can show "not set up" rather than a spinner or a scary error.
    return jsonResponse({ items: [], reason: "CONGRESS_API_KEY not set" });
  }

  const store = openStore();
  if (store) {
    try {
      const cached = await store.get(bioguideId, { type: "json" });
      if (cached && Date.now() - cached.checked_at < TTL_MS) {
        return jsonResponse({ items: cached.items, source: "cache" });
      }
    } catch {
      /* fall through to a live lookup */
    }
  }

  let sponsored;
  let cosponsored;
  try {
    [sponsored, cosponsored] = await Promise.all([
      fetchLegislation("sponsored", bioguideId, apiKey),
      fetchLegislation("cosponsored", bioguideId, apiKey),
    ]);
  } catch (error) {
    return jsonResponse({ error: `Congress.gov request failed: ${error.message}` }, 502);
  }

  const items = mergeCongressActivity(sponsored, cosponsored);

  if (store) {
    try {
      await store.setJSON(bioguideId, { items, checked_at: Date.now() });
    } catch {
      /* a cache write failure must not fail the response */
    }
  }

  return jsonResponse({ items, source: "congress.gov" });
};

export const config = { path: "/api/federal-votes" };
