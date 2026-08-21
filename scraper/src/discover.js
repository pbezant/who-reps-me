// Find a jurisdiction's official government website without a hand-curated seed URL.
//
// The batch scraper (pipeline.js) only ever visits URLs a human already vetted in
// seeds.json. This module is what lets the on-demand path (netlify/functions/local-officials)
// cover a city nobody has seeded yet: ask the already-configured LLM to recall the official
// domain, then VERIFY by actually fetching it before trusting the answer — models confidently
// hallucinate plausible-looking .gov URLs for small towns, so recall alone is not enough.
//
// This is intentionally the cheap, keyless option (same LLM key the extractor already needs,
// no separate search API). It will miss towns the model has never seen; that's a soft failure
// (see local-officials.js), not a crash — the alternative (a real search API) is a documented
// upgrade path, not a requirement.

import { callLLM } from "./llm.js";
import { fetchPage } from "./fetch.js";
import { extractOfficials } from "./extract.js";
import { normalize } from "./normalize.js";
import { suggestLinks, NOISE_HREF_RE } from "./suggest.js";
import { findMediaCandidates, stripSharedMedia } from "./media.js";
import { webSearch } from "./search.js";

const SYSTEM_PROMPT = `You know the official government website for US cities and counties.
Respond with ONLY the homepage URL (e.g. "https://www.cityofelgin.us"), nothing else.
If you are not confident you know the real official site, respond with exactly: UNKNOWN`;

function extractUrl(text) {
  const trimmed = (text || "").trim();
  if (!trimmed || /^unknown$/i.test(trimmed)) return null;
  const match = trimmed.match(/https?:\/\/[^\s"'<>]+/);
  if (!match) return null;
  // Strip trailing punctuation a model sometimes appends ("...us." or "...us)").
  return match[0].replace(/[.,)\]]+$/, "");
}

// Loose signal that a fetched page is actually this jurisdiction's government site, not a
// wrong guess (a news article, a wiki page, a same-named city in another state). Government
// sites reliably say "official website" / ".gov" / the city name near "government".
function looksLikeGovSite(page, city) {
  if (!page?.ok || !page.text) return false;
  const text = page.text.toLowerCase();
  // Require every word of the city name to appear somewhere on the page — checking only the
  // first word lets a two-word city ("San Marcos") pass on "san" alone, which is common enough
  // in unrelated text to be nearly meaningless as a signal.
  const words = city.toLowerCase().replace(/\bcounty\b/g, "").trim().split(/\s+/).filter(Boolean);
  if (!words.length || !words.every((w) => text.includes(w))) return false;
  return /\.gov\b/i.test(page.url) || /government|city council|county|commissioners|municipal/i.test(text);
}

// Returns { url, page } for the verified homepage, or null if nothing could be confirmed.
// `page` is the already-fetched result so callers don't have to fetch it again.
export async function discoverJurisdictionSite({ city, state, level }) {
  const kind = level === "county" ? "county" : "city";
  const user = `Jurisdiction: ${city}, ${state} (${kind} government)
What is the official ${kind} government homepage URL?`;

  // Let a callLLM failure (bad key, retired preset, provider error) propagate rather than
  // swallowing it here — the caller distinguishes "couldn't confirm a site" (expected, happens
  // for towns the model doesn't know) from "the LLM call itself is broken" (a bug to surface),
  // which look identical if this just returned null for both.
  //
  // maxOutput needs real headroom even though the visible answer is just a URL: reasoning
  // models (Gemini 2.5 Flash's default "thinking" mode is the one that bit us) spend part of
  // max_tokens on an internal reasoning pass before the visible answer, so a tight budget can
  // get the response cut off mid-thought with nothing usable left ("https" and nothing else).
  const raw = await callLLM({ system: SYSTEM_PROMPT, user, maxOutput: 200, jsonMode: false });

  const recalled = extractUrl(raw);
  if (recalled) {
    const page = await fetchPage(recalled, { allowBrowser: false, timeoutMs: 8000 }).catch(() => null);
    // page.url, not recalled: fetchPage() follows redirects, and the model's recalled URL can
    // itself 30x to the real site's actual domain (see fetch.js's fetchStatic() for the
    // confirmed Wayne County, MI case) — callers need the address the page actually lives at.
    if (looksLikeGovSite(page, city)) return { url: page.url, page };
  }

  // Recall came up empty (UNKNOWN) or didn't verify — a real search grounds the answer in the
  // current web instead of the model's training data, which is the only fix for a city the model
  // has genuinely never seen, or whose domain changed since its training cutoff. See search.js's
  // own header comment for why this stays a fallback rather than the primary lookup: recall is
  // free and already resolves well-known cities, so only the tail that needs it spends a query.
  return searchForGovSite({ city, state, kind });
}

async function searchForGovSite({ city, state, kind }) {
  let results;
  try {
    results = await webSearch(`${city} ${state} official ${kind} government website`, { count: 5 });
  } catch {
    // No SEARCH_API_KEY configured, an unknown SEARCH_PRESET, or the provider itself erroring —
    // all degrade to today's behavior (a soft miss), never a crash. See webSearch()'s own doc.
    return null;
  }
  const triedOrigins = new Set();
  for (const r of results) {
    // Prefer the bare origin over whatever specific page the search ranked first — this
    // function's whole job is finding the homepage (see its own doc comment above), and a
    // search hit is often a deep subpage that still passes looksLikeGovSite() (same real
    // domain, still government-sounding text) without actually being the homepage callers
    // expect back. Confirmed against Miami-Dade County, FL: the top result was a specific
    // service page (.../global/service.page?Mduid_service=...), not miamidade.gov itself.
    let origin;
    try {
      origin = new URL(r.url).origin;
    } catch {
      origin = null;
    }
    if (origin && !triedOrigins.has(origin)) {
      triedOrigins.add(origin);
      const homePage = await fetchPage(origin, { allowBrowser: false, timeoutMs: 8000 }).catch(() => null);
      // homePage.url, not origin: this same origin can itself redirect on to a different domain
      // (the same fetchStatic() behavior this whole file works around elsewhere).
      if (looksLikeGovSite(homePage, city)) return { url: homePage.url, page: homePage };
    }
    // The homepage itself didn't verify (thin/JS-rendered, or something odd about that
    // domain's root) — fall back to the specific result page rather than losing the hit
    // entirely.
    const page = await fetchPage(r.url, { allowBrowser: false, timeoutMs: 8000 }).catch(() => null);
    if (looksLikeGovSite(page, city)) return { url: page.url, page };
  }
  return null;
}

// Filters suggestLinks() candidates down to ones worth queuing: same-origin (never a
// jurisdiction's own social-media account — confirmed for Ann Arbor, MI, whose own Instagram
// link matched suggestLinks()'s keyword scan and got offered as a roster-page candidate) and not
// already visited. Pure/no I/O so it's unit-testable on its own — see discover.test.js.
export function sameOriginNewLinks(links, origin, visited) {
  const fresh = [];
  for (const [link] of links || []) {
    if (visited.has(link)) continue;
    try {
      if (new URL(link).origin === origin) fresh.push(link);
    } catch {
      /* skip unparseable */
    }
  }
  return fresh;
}

// Small breadth-first crawl from a jurisdiction's already-confirmed homepage, looking for the
// roster page and extracting officials from it. Shared by the on-demand path
// (netlify/functions/local-officials.mjs, one jurisdiction per live request) and the batch
// discovery script (discover-jurisdictions.js, many jurisdictions per scheduled run), so a fix
// to this crawl logic never has to happen in two places.
//
// The discovered page is usually a homepage or a general "Government" hub, not the roster
// itself, and how far the real roster sits from there varies by site — sometimes one hop
// (Boulder, CO: homepage -> /government/city-council), sometimes two (Asheville, NC: homepage ->
// /government/ -> /government/meet-city-council/, which never showed up as a candidate when
// only one level deep was checked). So this is a small breadth-first crawl, not a fixed list:
// each page that doesn't already look like a roster contributes its own same-origin
// "council"-ish links as further candidates, bounded by `fetchBudget` so a site that never
// converges can't run past a caller's own time budget (Netlify's own function ceiling for the
// on-demand path; a per-jurisdiction slice of a scheduled run's budget for the batch path).
//
// Same-origin only: suggestLinks()'s keyword match ("government", "council", ...) can catch a
// jurisdiction's own social-media links too (confirmed for Ann Arbor, MI: its own Instagram
// account matched and got offered as a candidate). A roster page is never on a third-party
// domain, and fetching one just adds latency/risk for a page that was never going to work.
//
// Dedupe by id (a person can legitimately turn up on more than one candidate page). A single
// stray match doesn't necessarily mean the real roster page: confirmed against Boulder, CO,
// where a NEWS ARTICLE mentioning the city council got tried before the actual roster page and
// yielded one name (the city clerk), which would have looked like a "successful" scrape if the
// crawl had stopped there. So keep crawling until either the budget runs out or the count looks
// like an actual roster (>= minOfficials), not just any non-zero result.
//
// minOfficials=3 (the original default) was too low in practice: a nationwide discovery run
// logged plenty of "hits" that were really just an early, partial page — Cook County, IL (a
// 17-member Board of Commissioners) stopped at 1; Philadelphia (17-member City Council) stopped
// at 1; Davidson County/Nashville (40-member Metro Council) stopped at 1 — because the crawl
// accepted the very first page that cleared the bar instead of continuing toward the actual
// full roster. Raised to 7 so a small city council (5-9 members, common) still converges quickly
// while a page that's obviously just an office/department listing no longer passes as "done".
// byId accumulates across every hop rather than resetting, so a higher bar only ever costs a
// few extra fetches on a jurisdiction that's genuinely small — it never discards what an earlier
// hop already found. fetchBudget raised alongside it (6 -> 8) so there's room for those extra
// hops on a real multi-level site instead of exhausting the budget with nothing to show for it.
//
// Returns { officials, sourceUrl, error }. `sourceUrl` is the specific page officials were
// actually found on (which may be several hops past `startUrl`) — not just the homepage — since
// the batch discovery script needs the real roster URL to seed future weekly scrapes with,
// not a homepage the plain (non-crawling) batch pipeline would find nothing on.
// `allowBrowser` defaults false to match the on-demand path's existing behavior exactly
// (Playwright doesn't fit a synchronous Netlify request/response function — see
// netlify/functions/local-officials.mjs's own header comment). The batch discovery script
// isn't under that constraint and can opt in.
export async function findRosterPage({ startUrl, startPage, jurisdiction, fetchBudget = 8, minOfficials = 7, allowBrowser = false }) {
  // Resolve startUrl to where it actually lives before trusting it for anything origin-related:
  // a seed/discovered/recalled URL can itself redirect to a different domain entirely (confirmed
  // for Wayne County, MI: waynecounty.com -> waynecountymi.gov, live via fetchPage()). Computing
  // `origin` from the requested startUrl instead of the fetched page's real url made
  // sameOriginNewLinks() below reject every genuinely-same-origin link on the real site as
  // "off-site" — the confirmed root cause of Wayne County staying unfound even with the
  // search-fallback seeding this function also does. startPage, when the caller already has one
  // (discoverJurisdictionSite() hands its own fetch straight through), avoids a redundant second
  // fetch here — and after that function's own fix, discovery.url/discovery.page already agree,
  // so effectiveStartUrl below just confirms what startUrl already says in that case.
  const firstPage = startPage || (await fetchPage(startUrl, { allowBrowser, timeoutMs: 8000 }).catch(() => null));
  const effectiveStartUrl = firstPage?.ok ? firstPage.url : startUrl;
  const origin = new URL(effectiveStartUrl).origin;
  const visited = new Set([startUrl, effectiveStartUrl]);
  const queue = [effectiveStartUrl];

  // Search-assisted seeding: ask a real search engine for this site's roster page and queue any
  // same-origin hits AHEAD of startUrl itself — the homepage "is usually a homepage or a general
  // 'Government' hub, not the roster itself" (see this function's own comment above), so a direct
  // hit here can save most of fetchBudget's hops. Reuses sameOriginNewLinks() so a search result
  // is filtered exactly like any other candidate link this crawl considers. Purely additive: no
  // SEARCH_API_KEY configured, or the provider erroring, leaves the queue exactly as it already
  // was — see search.js's own header comment.
  //
  // Also drops NOISE_HREF_RE matches (agenda/minutes/news/press/...) — confirmed necessary
  // against Wayne County, MI: a "city council OR commissioners" query returned nothing but press
  // releases ("Commissioners honor pioneering former Chair...", "Commissioners Killeen, Haidous
  // appointed to..."), which would otherwise have gone straight to the FRONT of the queue and
  // burned most of fetchBudget on dead ends before startUrl's own real navigation links were ever
  // tried — the exact same failure mode this crawl already guards against for suggestLinks()
  // candidates (see the Boulder, CO case in this function's own comment above), just reached via
  // a different route.
  try {
    const results = await webSearch(`site:${origin.replace(/^https?:\/\//, "")} city council OR commissioners OR "board of" members`, {
      count: 5,
    });
    const clean = results.filter((r) => !NOISE_HREF_RE.test(r.url));
    const seeded = sameOriginNewLinks(
      clean.map((r) => [r.url, r.title]),
      origin,
      visited
    );
    queue.unshift(...seeded);
    for (const link of seeded) visited.add(link);
  } catch {
    /* no search configured, or the provider errored — crawl exactly as before */
  }

  const now = new Date().toISOString();
  const byId = new Map();
  let extractError;
  let sourceUrl = null;
  let fetched = 0;
  while (queue.length && fetched < fetchBudget && byId.size < minOfficials) {
    const url = queue.shift();
    const page = url === effectiveStartUrl ? firstPage : await fetchPage(url, { allowBrowser, timeoutMs: 8000 }).catch(() => null);
    fetched += 1;
    if (!page?.ok) continue;

    // page.url, not the queued url, from here down: a link discovered mid-crawl can itself
    // redirect elsewhere by the time it's fetched (same root cause as startUrl above), and using
    // the pre-fetch url would resolve this page's relative links against the wrong base and
    // misattribute its officials' sourceUrl to a page they weren't actually found on.
    const pageUrl = page.url;

    // Regex-only, no extra fetch or LLM call — safe to run even under a tight time budget. See
    // media.js for why this is what makes photo_url/social reachable at all (fetch.js strips
    // <img>/<a> out of page.text).
    const media = findMediaCandidates(page.html, pageUrl);

    let raw;
    try {
      raw = await extractOfficials({ text: page.text, url: pageUrl, jurisdiction, media });
    } catch (err) {
      // A misconfigured/retired provider fails identically on every subsequent call — let the
      // caller decide whether to abort (the batch script does; a single live request has
      // nothing further to abort).
      if (err?.fatal) throw err;
      extractError = err.message;
      continue;
    }
    for (const r of raw) {
      const rec = normalize(r, { jurisdiction, sourceUrl: pageUrl, extractedAt: now });
      if (rec) byId.set(rec.id, rec);
    }
    if (byId.size) sourceUrl = pageUrl;
    if (byId.size >= minOfficials) break;

    // This page wasn't the roster — queue its own same-origin candidate links for the next
    // round, so a hub-of-hubs structure gets followed rather than giving up after one hop.
    for (const link of sameOriginNewLinks(suggestLinks(page.html, pageUrl, 4), origin, visited)) {
      visited.add(link);
      queue.push(link);
    }
  }

  const officials = stripSharedMedia([...byId.values()]);
  return { officials, sourceUrl, error: officials.length === 0 ? extractError : undefined };
}
