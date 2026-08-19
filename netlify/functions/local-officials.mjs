// On-demand local officials: the self-building half of the "database".
//
// The frontend (src/App.js) already checks the committed static shard
// (public/officials/<STATE>.json) first — that's free, instant, and covers every jurisdiction
// the weekly batch scraper has already visited. This function only runs when that check comes
// up empty. It then:
//
//   1. Checks a Netlify Blobs cache — a city scraped on-demand once should never be re-scraped
//      just because a second person searches it.
//   2. If still uncovered: discovers the jurisdiction's site (discover.js), scrapes it
//      (fetch.js + extract.js, same pipeline the batch scraper uses), and SAVES the result to
//      the cache before responding — so the next request for this city is a cache hit, not
//      another scrape. This is what makes the dataset grow on its own instead of requiring a
//      pre-scraped seed list.
//
// Requires an LLM_API_KEY (or ANTHROPIC_API_KEY) + LLM_PRESET set in the Netlify site's
// environment variables — see scraper/README.md. Pick a FAST preset (groq/gemini/mistral),
// not the scraper's ovh default: this path runs synchronously inside a user's search, and
// OVH's 2-requests/minute anonymous tier will blow past Netlify's function timeout.
//
// No headless-browser fallback here (Playwright doesn't fit a request/response function) — a
// jurisdiction whose site is client-rendered or WAF-blocked will fail softly and stay eligible
// for the batch scraper (which does have the browser fallback) to pick up later.

import { getStore } from "@netlify/blobs";
import { discoverJurisdictionSite, findRosterPage } from "../../scraper/src/discover.js";

const STORE_NAME = "local-officials-ondemand";
const HIT_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 days: officials rarely change
const MISS_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days: worth retrying — discovery may improve

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cacheKey(state, city) {
  const slug = city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${state.toUpperCase()}/${slug}`;
}

export default async (req) => {
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const state = String(body.state || "").trim().toUpperCase();
  const city = String(body.city || "").trim();
  const level = body.level === "county" ? "county" : "local";

  // Keep this endpoint scoped to what it's for (a geocoded place name), not an arbitrary
  // free-text scraper trigger.
  if (!/^[A-Z]{2}$/.test(state) || !city || city.length > 80 || !/^[A-Za-z0-9 .'-]+$/.test(city)) {
    return jsonResponse({ error: "invalid state/city" }, 400);
  }

  const store = getStore(STORE_NAME);
  const key = cacheKey(state, city);

  const cached = await store.get(key, { type: "json" }).catch(() => null);
  if (cached) {
    const age = Date.now() - Date.parse(cached.checked_at || 0);
    const ttl = cached.ok ? HIT_TTL_MS : MISS_TTL_MS;
    if (Number.isFinite(age) && age < ttl) {
      return jsonResponse({ officials: cached.officials, source: cached.ok ? "cache" : "cache-miss" });
    }
  }

  const jurisdiction = {
    city,
    state,
    level,
    body: level === "county" ? `${city} Commissioners Court` : `${city} City Council`,
  };

  let discovery, discoveryError;
  try {
    discovery = await discoverJurisdictionSite({ city, state, level });
  } catch (err) {
    discoveryError = err.message; // surfaced below so a broken key/preset is diagnosable from
    // the response itself, not just server logs — distinct from a legitimate "no site found".
  }
  if (!discovery) {
    await store.setJSON(key, {
      ok: false,
      officials: [],
      checked_at: new Date().toISOString(),
      ...(discoveryError ? { error: discoveryError } : {}),
    });
    return jsonResponse({ officials: [], source: "scraped-now", ...(discoveryError ? { error: discoveryError } : {}) });
  }

  // The discovered page is usually a homepage or a general "Government" hub, not the roster
  // itself — findRosterPage() (discover.js) does the actual breadth-first crawl looking for it,
  // bounded so it can't run the request past Netlify's own function ceiling (confirmed
  // directly: ~30s, via a plain request that timed out server-side rather than in our code).
  // Shared with the batch discovery script (discover-jurisdictions.js) so this crawl logic and
  // its edge-case fixes (Boulder, Ann Arbor — see findRosterPage()'s own comment) only live once.
  const now = new Date().toISOString();
  let officials = [];
  let sourceUrl = null;
  let error;
  try {
    ({ officials, sourceUrl, error } = await findRosterPage({
      startUrl: discovery.url,
      startPage: discovery.page,
      jurisdiction,
    }));
  } catch (err) {
    // findRosterPage() rethrows a fatal (misconfigured/retired provider) error rather than
    // swallowing it, so a batch caller can stop early — but this is a live user-facing request,
    // not a batch, so there is nothing further to stop; degrade to the same graceful empty
    // response every other failure mode here already returns, same as the discovery step above.
    error = err.message;
  }

  await store.setJSON(key, {
    ok: officials.length > 0,
    officials,
    source_url: sourceUrl || discovery.url,
    checked_at: now,
    ...(error ? { error } : {}),
  });

  return jsonResponse({ officials, source: "scraped-now", ...(error ? { error } : {}) });
};

export const config = { path: "/api/local-officials" };
