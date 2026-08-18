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
import { fetchPage } from "../../scraper/src/fetch.js";
import { discoverJurisdictionSite } from "../../scraper/src/discover.js";
import { suggestLinks } from "../../scraper/src/suggest.js";
import { extractOfficials } from "../../scraper/src/extract.js";
import { normalize } from "../../scraper/src/normalize.js";

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

  // The discovered page is usually the homepage, not a roster page — look for a better link
  // on it (same heuristic the batch scraper uses to recover from a bad seed URL). suggestLinks
  // returns candidates in DOM order, not ranked by relevance, so the first one is frequently a
  // generic "Government" nav item rather than the actual roster page (confirmed for Boulder,
  // CO: the real "/government/city-council" link was 3rd). Try several — see the merge loop
  // below for why it doesn't just stop at the first one that returns anything.
  //
  // Same-origin only: suggestLinks' keyword match ("government", "council", ...) can catch a
  // jurisdiction's own social-media links too (confirmed for Ann Arbor, MI: its own Instagram
  // account matched and got offered as a candidate). A roster page is never on a third-party
  // domain, and fetching one just adds latency/risk for a page that was never going to work.
  const origin = new URL(discovery.url).origin;
  const candidateUrls = [discovery.url];
  for (const [link] of suggestLinks(discovery.page.html, discovery.url, 4)) {
    try {
      if (new URL(link).origin === origin) candidateUrls.push(link);
    } catch {
      /* skip unparseable */
    }
  }

  const now = new Date().toISOString();
  // Dedupe by id (pipeline.js's approach for the batch scraper, which visits every seed URL
  // for a jurisdiction rather than stopping at the first hit) — a person can legitimately turn
  // up on more than one candidate page. A single stray match doesn't necessarily mean the real
  // roster page: confirmed against Boulder, CO, where a NEWS ARTICLE mentioning the city
  // council got tried before the actual roster page and yielded one name (the city clerk),
  // which would have looked like a "successful" scrape if we'd stopped there. So keep visiting
  // candidates until either the list runs out or the count looks like an actual roster (3+),
  // not just any non-zero result.
  const byId = new Map();
  let extractError;
  for (const url of candidateUrls) {
    const page =
      url === discovery.url ? discovery.page : await fetchPage(url, { allowBrowser: false, timeoutMs: 8000 }).catch(() => null);
    if (!page?.ok) continue;

    let raw;
    try {
      raw = await extractOfficials({ text: page.text, url, jurisdiction });
    } catch (err) {
      extractError = err.message;
      continue;
    }
    for (const r of raw) {
      const rec = normalize(r, { jurisdiction, sourceUrl: url, extractedAt: now });
      if (rec) byId.set(rec.id, rec);
    }
    if (byId.size >= 3) break;
  }
  const results = [...byId.values()];

  const reason = results.length === 0 ? extractError : undefined;
  await store.setJSON(key, {
    ok: results.length > 0,
    officials: results,
    source_url: discovery.url,
    checked_at: now,
    ...(reason ? { error: reason } : {}),
  });

  return jsonResponse({ officials: results, source: "scraped-now", ...(reason ? { error: reason } : {}) });
};

export const config = { path: "/api/local-officials" };
