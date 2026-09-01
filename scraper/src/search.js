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
//   SEARCH_PRESET       brave | google | tavily  (default: brave) — used for every search except
//                       news (jurisdiction/roster discovery in discover.js).
//   SEARCH_PRESET_NEWS  brave | google | tavily  (default: whatever SEARCH_PRESET resolves to) —
//                       used only for `topic: "news"` searches, i.e. rep-news.mjs's profile-page
//                       section. Lets one provider serve what it's actually good at without
//                       forcing the other path onto it: Brave indexes the general web and honors
//                       search operators (findRosterPage() issues `site:<domain> ...` queries),
//                       while Tavily has a first-class news topic and returns LLM-shaped
//                       title/content pairs. See "Two providers at once" below.
//   <PRESET>_API_KEY    per-provider key: BRAVE_API_KEY / TAVILY_API_KEY / GOOGLE_API_KEY. Needed
//                       only when running two providers at once, since SEARCH_API_KEY alone can't
//                       hold two keys.
//   SEARCH_API_KEY      provider key, used for any preset with no <PRESET>_API_KEY set. Still the
//                       whole configuration for a single-provider setup.
//   SEARCH_CX           Google's Programmable Search Engine id (the "cx" param) — brave/tavily
//                       don't need a second id, so this is ignored for those presets.
//
// Two providers at once: set SEARCH_PRESET=brave + SEARCH_PRESET_NEWS=tavily and give each its
// own BRAVE_API_KEY/TAVILY_API_KEY. Both keys must be set wherever a search actually runs — that
// is BOTH Netlify (rep-news.mjs does news; local-officials.mjs runs on-demand discovery) and the
// run-daily workflow (phase 3's batch discovery). Nothing here fails over between providers: a
// news search never silently falls back to Brave, since the whole point of routing is that the
// news path gets Tavily's news topic. Each caller already treats a throw as "search isn't
// available" and degrades to its non-search path.
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

// Which env var holds each preset's key when two providers run side by side. SEARCH_API_KEY stays
// the fallback for every preset, so a single-provider setup needs none of these.
const PRESET_KEY_ENV = { brave: "BRAVE_API_KEY", google: "GOOGLE_API_KEY", tavily: "TAVILY_API_KEY" };

// `topic` is the same option callers already pass to webSearch() ("news" from rep-news.mjs, unset
// everywhere else), so routing by purpose needs no call-site changes at all. SEARCH_PRESET_NEWS
// deliberately falls back to SEARCH_PRESET rather than defaulting to tavily on its own: an
// existing single-key deployment must keep behaving exactly as it did before routing existed,
// rather than suddenly sending news to a provider it has no key for.
export function resolveSearchConfig({ topic } = {}) {
  const newsOverride = topic === "news" ? process.env.SEARCH_PRESET_NEWS : "";
  const presetName = newsOverride || process.env.SEARCH_PRESET || "brave";
  const presetEnv = newsOverride ? "SEARCH_PRESET_NEWS" : "SEARCH_PRESET";
  const preset = SEARCH_PRESETS[presetName];
  if (!preset) {
    throw new Error(
      `Unknown ${presetEnv} "${presetName}". Options: ${Object.keys(SEARCH_PRESETS).join(", ")}`
    );
  }
  const keyEnv = PRESET_KEY_ENV[presetName];
  const apiKey = process.env[keyEnv] || process.env.SEARCH_API_KEY || "";
  return { presetName, presetEnv, preset, apiKey, keyEnv, cx: process.env.SEARCH_CX || "" };
}

// Pure response -> {title, url, snippet}[] mappers, split out from the fetch calls below so they
// stay unit-testable against a fixture without a network call — matching how the rest of this
// project deliberately leaves the actual HTTP call untested (see scraper/README.md's "Tests"
// section) but still tests the decision/parsing logic around it.
export function parseBraveResults(data) {
  return (data?.web?.results || [])
    .map((r) => ({
      title: r.title || "",
      url: r.url,
      snippet: r.description || "",
      // Brave serves a real per-result thumbnail rather than a scrape of every image on the page,
      // so it needs none of pickResultImage()'s filtering. Keeps the news UI working unchanged if
      // SEARCH_PRESET_NEWS is ever pointed back at brave.
      image: typeof r.thumbnail?.src === "string" ? r.thumbnail.src : "",
      favicon: typeof r.profile?.img === "string" ? r.profile.img : "",
      // Brave exposes no relevance score. null (not 0) so a score filter can tell "this provider
      // doesn't score results" apart from "this result scored badly" and keep the result.
      score: null,
      publishedAt: typeof r.page_age === "string" ? r.page_age : "",
    }))
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
// Tavily's per-result `images` is whatever was scraped off the page, not an editorial lead image:
// a real article photo sometimes comes first, but the list is just as often SVG chrome — nav
// icons, share buttons, app-store badges, author thumbnails. Verified against a live response for
// a Texas House member: Business Insider's first entry was a genuine hero image, while every one
// of Bloomberg Law's fifteen was interface furniture. So this picks the first entry that survives
// a conservative filter and otherwise yields nothing, because no image reads far better on a news
// list than a "Download on the App Store" badge does.
const NON_EDITORIAL_RE = /logo|icon|badge|placeholder|sprite|favicon|app-store|google-play|avatar|button/i;
const SVG_RE = /\.svg(\?|$)/i;
// A dimension pair baked into the URL (".../80x80/...", "?w=64") that's too small to be a story
// image — usually an author headshot or a UI glyph that dodged the name filter above.
const SMALL_DIMENSIONS_RE = /(?:^|[^\d])(\d{2,4})\s*[x×]\s*(\d{2,4})(?:[^\d]|$)/;

export function pickResultImage(images) {
  for (const url of images || []) {
    if (typeof url !== "string" || !url) continue;
    if (SVG_RE.test(url) || NON_EDITORIAL_RE.test(url)) continue;
    const dims = url.match(SMALL_DIMENSIONS_RE);
    if (dims && Number(dims[1]) < 200 && Number(dims[2]) < 200) continue;
    return url;
  }
  return "";
}

export function parseTavilyResults(data) {
  return (data?.results || [])
    .map((r) => ({
      title: r.title || "",
      url: r.url,
      snippet: r.content || "",
      // Both optional and provider-specific: absent for brave/google, and absent from tavily too
      // unless the caller asked for them (see webSearch()'s `media` option). Every consumer
      // treats them as nice-to-have, never required.
      image: pickResultImage(r.images),
      favicon: typeof r.favicon === "string" ? r.favicon : "",
      // Tavily's own relevance score (0-1) and publish timestamp. Both matter for the news path:
      // Tavily strips quotes from a phrase query, so `"Jane Doe" ...` degrades to loose token
      // matching and a common first name pulls in articles about a different person entirely —
      // the score is the only signal that separates them. See newsQuery.js's MIN_SCORE.
      score: typeof r.score === "number" ? r.score : null,
      publishedAt: typeof r.published_date === "string" ? r.published_date : "",
    }))
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
// `media` asks for the per-result image/favicon fields the news UI renders. Off by default: the
// image arrays are large (fifteen-plus URLs per result is normal) and discovery has no use for
// them, so only the caller that renders them pays for them.
async function searchTavily(query, { count, apiKey, topic, media, days }) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      max_results: count,
      ...(topic ? { topic } : {}),
      ...(media ? { include_images: true, include_favicon: true } : {}),
      // Tavily bounds the news topic by age when asked; without it a "recent news" section
      // happily returns something from last year. Only meaningful alongside topic: "news".
      ...(days ? { days } : {}),
    }),
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
// `topic` does double duty. It selects the provider (topic "news" resolves SEARCH_PRESET_NEWS —
// see resolveSearchConfig()), and it's passed through to Tavily, where "news" biases results
// toward recent news coverage. Brave/Google have no equivalent concept and silently ignore it, so
// a caller never has to branch on which preset is active just to ask for news-flavored results.
export async function webSearch(query, { count = 5, topic, media = false, days } = {}) {
  const cfg = resolveSearchConfig({ topic });
  if (!cfg.apiKey) {
    throw new Error(
      `No search API key for ${cfg.presetEnv}=${cfg.presetName}. Set ${cfg.keyEnv} or ` +
        "SEARCH_API_KEY (and SEARCH_CX for the google preset) to enable this search, or leave " +
        "unset to skip it entirely — see scraper/README.md."
    );
  }
  await throttle(cfg.preset.rps);
  callCount++;
  if (cfg.presetName === "brave") return searchBrave(query, { count, apiKey: cfg.apiKey });
  if (cfg.presetName === "google") return searchGoogle(query, { count, apiKey: cfg.apiKey, cx: cfg.cx });
  if (cfg.presetName === "tavily") return searchTavily(query, { count, apiKey: cfg.apiKey, topic, media, days });
  throw new Error(`Unknown SEARCH_PRESET "${cfg.presetName}".`);
}
