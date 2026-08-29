// Recent news for one representative, requested from src/RepNews.js when their profile page
// opens. Reuses scraper/src/search.js's provider-agnostic webSearch() server-side — whichever
// SEARCH_PRESET is configured (brave/google/tavily) already covers this, no new setup needed for
// this feature specifically — and scraper/src/newsQuery.js for the per-tier disambiguating query
// + result trimming. Requests `topic: "news"`, which the tavily preset uses to bias toward
// recent news coverage rather than general web results (a no-op for brave/google, which have no
// equivalent concept) — see search.js's own header comment.
//
// The client sends the rep's own fields as query params rather than this function looking the
// rep up itself — there is no id-addressable store for federal/state reps to look up against
// (see RepProfile.js's own header comment on the "same-session only" v1 scope), and the client
// already has the full rep object in hand.
//
// Setup: nothing extra — SEARCH_API_KEY (and, depending on preset, SEARCH_PRESET/SEARCH_CX) is
// already documented in scraper/README.md's "Setup: Netlify environment variables" section.
// Without it, this returns an empty article list at HTTP 200 rather than an error, same
// fail-soft contract as netlify/functions/state-legislators.mjs.

import { getStore } from "@netlify/blobs";
import { buildNewsQuery, parseNewsResults } from "../../scraper/src/newsQuery.js";
import { webSearch } from "../../scraper/src/search.js";

const STORE_NAME = "rep-news";
// Shorter than the 30/90-day caches used elsewhere in this app for slower-changing directory
// data (district boundaries, officeholders) — news genuinely changes daily, so a longer TTL
// would just show stale headlines. Trade-off: a shorter TTL means more search calls for a
// popular rep's profile getting reopened; acceptable at this project's current traffic, worth
// revisiting against Brave's ~1,000 free searches/month if that changes (see search.js).
const TTL_MS = 1000 * 60 * 60 * 12;

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
  const id = url.searchParams.get("id");
  const name = url.searchParams.get("name") || "";
  const area = url.searchParams.get("area") || "";
  const state = url.searchParams.get("state") || "";
  const body = url.searchParams.get("body") || "";

  if (!id || !name) {
    return jsonResponse({ error: "id and name are required" }, 400);
  }

  const store = openStore();
  if (store) {
    try {
      const cached = await store.get(id, { type: "json" });
      if (cached && Date.now() - cached.checked_at < TTL_MS) {
        return jsonResponse({ articles: cached.articles, source: "cache" });
      }
    } catch {
      /* fall through to a live search */
    }
  }

  const query = buildNewsQuery({ name, area, state, body });
  let articles;
  try {
    // topic: "news" only means anything to the tavily preset (biases results toward recent
    // news coverage rather than general web results) — a harmless no-op for brave/google, which
    // have no equivalent concept. See search.js's own header comment on webSearch()'s `topic`.
    // days: a "Recent news" section that surfaces a ten-month-old article isn't recent. Six
    // months rather than a tighter window because coverage of a local council member or a
    // back-bench legislator is genuinely sparse — too narrow a bound turns this section empty for
    // exactly the officials it's most useful for. Tavily-only; brave/google ignore it.
    const results = await webSearch(query, { topic: "news", media: true, days: 180 });
    articles = parseNewsResults(results);
  } catch (error) {
    // webSearch() throws when there's no key configured, same as every other caller in this
    // codebase treats that as "search isn't available" rather than a hard error — see
    // search.js's own header comment.
    return jsonResponse({ articles: [], reason: error.message });
  }

  if (store) {
    try {
      await store.setJSON(id, { articles, checked_at: Date.now() });
    } catch {
      /* a cache write failure must not fail the response */
    }
  }

  return jsonResponse({ articles, source: "search" });
};

export const config = { path: "/api/rep-news" };
