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
import { suggestLinks } from "./suggest.js";
import { findMediaCandidates, stripSharedMedia } from "./media.js";

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

  const url = extractUrl(raw);
  if (!url) return null;

  const page = await fetchPage(url, { allowBrowser: false, timeoutMs: 8000 }).catch(() => null);
  if (!looksLikeGovSite(page, city)) return null;

  return { url, page };
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
// Returns { officials, sourceUrl, error }. `sourceUrl` is the specific page officials were
// actually found on (which may be several hops past `startUrl`) — not just the homepage — since
// the batch discovery script needs the real roster URL to seed future weekly scrapes with,
// not a homepage the plain (non-crawling) batch pipeline would find nothing on.
// `allowBrowser` defaults false to match the on-demand path's existing behavior exactly
// (Playwright doesn't fit a synchronous Netlify request/response function — see
// netlify/functions/local-officials.mjs's own header comment). The batch discovery script
// isn't under that constraint and can opt in.
export async function findRosterPage({ startUrl, startPage, jurisdiction, fetchBudget = 6, minOfficials = 3, allowBrowser = false }) {
  const origin = new URL(startUrl).origin;
  const visited = new Set([startUrl]);
  const queue = [startUrl];

  const now = new Date().toISOString();
  const byId = new Map();
  let extractError;
  let sourceUrl = null;
  let fetched = 0;
  while (queue.length && fetched < fetchBudget && byId.size < minOfficials) {
    const url = queue.shift();
    const page =
      url === startUrl && startPage ? startPage : await fetchPage(url, { allowBrowser, timeoutMs: 8000 }).catch(() => null);
    fetched += 1;
    if (!page?.ok) continue;

    // Regex-only, no extra fetch or LLM call — safe to run even under a tight time budget. See
    // media.js for why this is what makes photo_url/social reachable at all (fetch.js strips
    // <img>/<a> out of page.text).
    const media = findMediaCandidates(page.html, url);

    let raw;
    try {
      raw = await extractOfficials({ text: page.text, url, jurisdiction, media });
    } catch (err) {
      // A misconfigured/retired provider fails identically on every subsequent call — let the
      // caller decide whether to abort (the batch script does; a single live request has
      // nothing further to abort).
      if (err?.fatal) throw err;
      extractError = err.message;
      continue;
    }
    for (const r of raw) {
      const rec = normalize(r, { jurisdiction, sourceUrl: url, extractedAt: now });
      if (rec) byId.set(rec.id, rec);
    }
    if (byId.size) sourceUrl = url;
    if (byId.size >= minOfficials) break;

    // This page wasn't the roster — queue its own same-origin candidate links for the next
    // round, so a hub-of-hubs structure gets followed rather than giving up after one hop.
    for (const link of sameOriginNewLinks(suggestLinks(page.html, url, 4), origin, visited)) {
      visited.add(link);
      queue.push(link);
    }
  }

  const officials = stripSharedMedia([...byId.values()]);
  return { officials, sourceUrl, error: officials.length === 0 ? extractError : undefined };
}
