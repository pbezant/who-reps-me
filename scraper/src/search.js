// Provider-agnostic web search: a small, swappable layer over general search APIs, mirroring
// llm.js's preset pattern (same reasoning: a provider's free tier can vanish or change terms —
// this project has already been burned twice, GitHub Models' retirement and Groq cutting its
// daily limits — so nothing here hard-codes one vendor).
//
// This is PURELY ADDITIVE. Every caller in discover.js treats a missing SEARCH_API_KEY, or the
// provider erroring, as "search isn't available" and falls back to exactly what it already did
// without this module: LLM-recall-only site discovery, and the plain breadth-first roster crawl.
// Nothing regresses for a user who never sets SEARCH_API_KEY.
//
// Why this exists: discoverJurisdictionSite() (discover.js) resolves a jurisdiction's homepage by
// asking the LLM to recall it from memory — that file's own header comment already names the
// weakness ("It will miss towns the model has never seen"). A real search grounds the answer in
// the actual current web instead of the model's training data, which also fixes the case recall
// can never fix on its own: a city whose domain changed since the model's cutoff.
//
// Config:
//   SEARCH_PRESET   brave | google | tavily      (default: brave)
//   SEARCH_API_KEY  provider key
//   SEARCH_CX       Google's Programmable Search Engine id (the "cx" param) — brave/tavily don't
//                   need a second id, so this is ignored for those presets.
//
// Bing isn't an option here at all: Microsoft fully retired every Bing Search API (Web, News,
// Custom, ...) on 2025-08-11 — confirmed against learn.microsoft.com/en-us/lifecycle/
// announcements/bing-search-api-retirement — new resource creation had already been disabled
// since February 2025.

export const SEARCH_PRESETS = {
  brave: {
    // Free tier, confirmed against brave.com/search/api on 2026-08-21: $5/month in free credits
    // applied automatically, at $5/1,000 requests — i.e. 1,000 free searches/month, not the
    // 2,000 this comment originally (wrongly) said. Rate limit is 50 queries/second (also
    // corrected here — this used to throttle to 1/sec, ~50x more conservative than the actual
    // cap). Signing up requires a credit card even for free-tier-only usage (Brave's own
    // anti-fraud measure; the card is never charged while usage stays under the monthly credit).
    // Throttled well under the real cap since this path's call volume is always small anyway
    // (a fallback, not a bulk search workload).
    rps: 10,
  },
  google: {
    // NOT RECOMMENDED for a new setup, kept only for anyone with an existing key: the Custom
    // Search JSON API is closed to new customers as of 2026-08-21 (confirmed against
    // developers.google.com/custom-search/v1/overview) and is being sunset entirely on
    // 2027-01-01 in favor of Vertex AI Search. Free quota for an existing key is 100 queries/day.
    rps: 5,
  },
  tavily: {
    // Free "Researcher" tier, confirmed against docs.tavily.com/documentation/rate-limits and
    // help.tavily.com/articles/3240802908-rate-limits on 2026-08-24: 1,000 free credits/month, NO
    // credit card required (unlike Brave above) — a real practical advantage for a low-traffic
    // project. A free-tier ("Development") key is capped at 100 requests/minute (~1.67 rps);
    // production keys (1,000 rps) need a paid plan or PAYGO, so this throttles well under the
    // free-key ceiling rather than assuming the higher tier. Purpose-built for LLM/agent
    // consumption rather than a general SERP scrape, and its `topic: "news"` mode (see
    // searchTavily() below) is a closer semantic fit for "recent news about this person" than
    // Brave's or Google's plain web search — see rep-news.mjs's use of webSearch()'s `topic`
    // option.
    rps: 1.5,
  },
};

export function resolveSearchConfig() {
  const presetName = process.env.SEARCH_PRESET || "brave";
  const preset = SEARCH_PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown SEARCH_PRESET "${presetName}". Options: ${Object.keys(SEARCH_PRESETS).join(", ")}`);
  }
  return { presetName, preset, apiKey: process.env.SEARCH_API_KEY || "", cx: process.env.SEARCH_CX || "" };
}

// Pure response -> {title, url, snippet}[] mappers, split out from the fetch calls below so they
// stay unit-testable against a fixture without a network call — matching how the rest of this
// project deliberately leaves the actual HTTP call untested (see scraper/README.md's "Tests"
// section) but still tests the decision/parsing logic around it.
export function parseBraveResults(data) {
  return (data?.web?.results || [])
    .map((r) => ({ title: r.title || "", url: r.url, snippet: r.description || "" }))
    .filter((r) => r.url);
}

export function parseGoogleResults(data) {
  return (data?.items || [])
    .map((r) => ({ title: r.title || "", url: r.link, snippet: r.snippet || "" }))
    .filter((r) => r.url);
}

// Tavily's `content` field is the description/snippet (confirmed against docs.tavily.com/
// documentation/api-reference/endpoint/search on 2026-08-24) — everything else maps 1:1 with
// the other two parsers' output shape, so every caller of webSearch() stays provider-agnostic.
export function parseTavilyResults(data) {
  return (data?.results || [])
    .map((r) => ({ title: r.title || "", url: r.url, snippet: r.content || "" }))
    .filter((r) => r.url);
}

let lastCallAt = 0;
async function throttle(rps) {
  if (!rps) return;
  const minGap = 1000 / rps;
  const wait = lastCallAt + minGap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function searchBrave(query, { count, apiKey }) {
  const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(endpoint, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } });
  if (!res.ok) throw new Error(`brave search HTTP ${res.status}`);
  return parseBraveResults(await res.json());
}

async function searchGoogle(query, { count, apiKey, cx }) {
  if (!cx) throw new Error("SEARCH_CX is required for SEARCH_PRESET=google (Programmable Search Engine id).");
  const endpoint =
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}` +
    `&q=${encodeURIComponent(query)}&num=${Math.min(count, 10)}`;
  const res = await fetch(endpoint);
  if (!res.ok) throw new Error(`google search HTTP ${res.status}`);
  return parseGoogleResults(await res.json());
}

// POST + bearer auth (confirmed against docs.tavily.com/documentation/quickstart on 2026-08-24:
// `Authorization: Bearer <key>`, JSON body), unlike Brave/Google's GET+query-string shape — kept
// behind the same webSearch() interface so callers never see the difference. `topic` is passed
// through as-is when given (webSearch()'s callers only ever pass "news" today, but this doesn't
// validate against Tavily's enum — an invalid value is Tavily's 400 to raise, not this file's to
// pre-guess) and otherwise omitted, letting Tavily's own "general" default apply.
async function searchTavily(query, { count, apiKey, topic }) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: count, ...(topic ? { topic } : {}) }),
  });
  if (!res.ok) throw new Error(`tavily search HTTP ${res.status}`);
  return parseTavilyResults(await res.json());
}

// Process-lifetime call count, same purpose/shape as llm.js's getCallCount(): lets a CLI entry
// point report how much search budget a run actually spent. Not yet wired into usage-ledger.js
// (that ledger is scoped to LLM calls specifically, and search call volume here is inherently
// bounded — it only ever fires as a fallback for jurisdictions the cheaper LLM-recall path
// couldn't resolve) — a dedicated ledger can be added later if usage in practice justifies it.
let callCount = 0;
export function getSearchCallCount() {
  return callCount;
}
export function resetSearchCallCount() {
  callCount = 0;
}

// Throws when search isn't usable (no key, unknown preset, provider error) rather than returning
// an empty list — deliberately different from callLLM()'s fatal/non-fatal split, since there's no
// "every call fails identically" abort case to distinguish here. Every caller of webSearch() in
// this codebase wraps it in try/catch and treats any throw as "fall back to the non-search path",
// so the distinction wouldn't be actionable anyway.
//
// `topic` is Tavily-specific ("news" biases results toward recent news coverage — see
// netlify/functions/rep-news.mjs) and silently ignored by Brave/Google, which have no equivalent
// concept — passing it with SEARCH_PRESET=brave/google is a no-op, not an error, so a caller
// doesn't need to branch on which preset is active just to ask for news-flavored results.
export async function webSearch(query, { count = 5, topic } = {}) {
  const cfg = resolveSearchConfig();
  if (!cfg.apiKey) {
    throw new Error(
      "No search API key. Set SEARCH_API_KEY (and SEARCH_CX for SEARCH_PRESET=google) to enable " +
        "the search fallback, or leave unset to skip it entirely — see scraper/README.md."
    );
  }
  await throttle(cfg.preset.rps);
  callCount++;
  if (cfg.presetName === "brave") return searchBrave(query, { count, apiKey: cfg.apiKey });
  if (cfg.presetName === "google") return searchGoogle(query, { count, apiKey: cfg.apiKey, cx: cfg.cx });
  if (cfg.presetName === "tavily") return searchTavily(query, { count, apiKey: cfg.apiKey, topic });
  throw new Error(`Unknown SEARCH_PRESET "${cfg.presetName}".`);
}
