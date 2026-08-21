// Read-only view of the log netlify/functions/log-search.mjs writes — every search a visitor
// has run, newest first. Not linked from the app UI anywhere; visit it directly:
//
//   /.netlify/functions/search-log?key=YOUR_SEARCH_LOG_SECRET
//   /.netlify/functions/search-log?key=YOUR_SEARCH_LOG_SECRET&limit=50
//
// SEARCH_LOG_SECRET (Netlify env var) gates access. Unset = the endpoint is open to anyone who
// finds the URL — fine for local dev, but set this in production before relying on it as
// anything more than "not linked publicly."

import { getStore } from "@netlify/blobs";

const STORE_NAME = "search-log";
const LOG_KEY = "log.jsonl";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default async (req) => {
  if (req.method !== "GET") return jsonResponse({ error: "method not allowed" }, 405);

  const url = new URL(req.url);
  const secret = process.env.SEARCH_LOG_SECRET;
  if (secret && url.searchParams.get("key") !== secret) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  try {
    const store = getStore(STORE_NAME);
    const raw = (await store.get(LOG_KEY)) || "";
    const entries = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const searches = entries.slice(-limit).reverse();
    return jsonResponse({ total: entries.length, returned: searches.length, searches });
  } catch (err) {
    console.error("search-log: failed to read log:", err);
    return jsonResponse({ error: "failed to read log" }, 500);
  }
};
