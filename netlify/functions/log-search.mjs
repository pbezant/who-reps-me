// Logs every search a visitor runs — the address/ZIP/place text actually searched, plus whatever
// geocode() resolved it to (state/county/place/districts), and — when an autocomplete suggestion
// changed what was typed — the original raw text too (see `typed` below) — so the searches
// themselves can be reviewed later (see search-log.mjs). Deliberately logs the raw query text: unlike the bug-report
// form (netlify/functions/report-bug.mjs), nothing here is published or tied to an individual —
// it's a private operational log, and any address is fair game to search in the first place.
//
// Fire-and-forget by design: the frontend calls this without awaiting/blocking the search UI,
// and this function itself never lets a storage hiccup surface as an error to the caller — a
// search that can't be logged should still work exactly like one that could.
//
// Storage: one append-only newline-delimited-JSON blob (Netlify Blobs, same mechanism
// report-bug.mjs already uses for its rate-limit counters). Read-modify-write, not atomic —
// fine at this project's traffic level (same tradeoff already accepted for that rate limiter).
// Trimmed to the most recent MAX_LINES entries so the blob can't grow unbounded.
//
// Requires nothing to be configured — works out of the box on any Netlify site with Blobs
// enabled (on by default for sites created after Netlify Blobs' GA).

import { getStore } from "@netlify/blobs";

const STORE_NAME = "search-log";
const LOG_KEY = "log.jsonl";
const MAX_QUERY_LENGTH = 300;
const MAX_LINES = 5000;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default async (req) => {
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const query = String(body.query || "").trim().slice(0, MAX_QUERY_LENGTH);
  if (!query) return jsonResponse({ error: "missing query" }, 400);

  // What the visitor actually typed, before an autocomplete suggestion corrected it to `query`.
  // Only present on searches where that happened (see logSearch() in src/App.js) — absent means
  // `query` already is what was typed, so there's nothing extra to show.
  const typed = String(body.typed || "").trim().slice(0, MAX_QUERY_LENGTH) || null;

  const geo = body.geo && typeof body.geo === "object" ? body.geo : null;
  const entry = {
    t: new Date().toISOString(),
    query,
    typed,
    // Just the resolved-location fields, not the full geo object (which also carries raw lat/lon
    // and district internals not needed for "what did people search").
    resolved: geo
      ? {
          state: geo.state ?? null,
          county: geo.county ?? null,
          place: geo.place ?? null,
        }
      : null,
  };

  try {
    const store = getStore(STORE_NAME);
    const existing = (await store.get(LOG_KEY)) || "";
    const lines = existing ? existing.split("\n").filter(Boolean) : [];
    lines.push(JSON.stringify(entry));
    const trimmed = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
    await store.set(LOG_KEY, trimmed.join("\n") + "\n");
  } catch (err) {
    // Best-effort only — never fail the caller's search over a logging hiccup.
    console.error("log-search: failed to write log:", err);
  }

  return jsonResponse({ status: "ok" });
};
