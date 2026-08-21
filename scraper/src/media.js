// Cheap regex scan of a page's raw HTML for photo, social-media, mailto: email, and same-page
// profile-link candidates, run alongside (not instead of) the visible-text extraction in
// extract.js.
//
// fetch.js's htmlToText() strips every <img> and <a> tag before the page text ever reaches
// the LLM, so without this the model has no src/href to work with at all — which is exactly
// why extract.js's `photo_url`/`url` fields have stayed null in practice even though the
// prompt has always asked for them. This module surfaces the raw candidates; attributing
// "whose photo/page is this" is still the LLM's job, using each candidate's `context` snippet
// (and, for links, its own visible text) as its only proximity signal (same "AI extraction
// over hand-written per-site parsing" trade-off the rest of this scraper makes).
//
// The `links` list (a candidate for each official's own `url`) was the second addition to this
// module (after `images`/`socialLinks`) and exists specifically because of austintexas.gov/
// council: the roster page lists all 11 members by name and district, each name linking to that
// member's own subpage (phone/email/photo/bio live there, not on the roster) — but that link is
// a plain <a>, not a social link, so it was silently dropped before this existed. Without a
// `url`, pipeline.js's enrichFromBioPages() bio-page follow-up pass — the thing that actually
// visits that subpage — has nothing to fetch, so the roster-page-only extraction was the end of
// the line even though the rest of the data was one click away.
//
// The `emails` list exists for a related reason: the same-origin check in the `links` loop below
// (`absOrigin !== origin`) silently drops every mailto: href, because a mailto: URL's origin is
// the string "null" — so an official's email, when the page only exposes it via a "Send email"
// mailto: link and never as visible text, was completely invisible to the LLM. Confirmed on
// austintexas.gov/mayor: Kirk Watson's page has no visible email text, only a mailto: link, and
// with no mailto: candidate ever offered to it the model instead filled `email` with
// https://www.austintexas.gov/email/14286 — a contact-form URL it pulled from the `links`
// candidates meant for the `url` field, not an actual email address. `emails` is scanned
// separately, before the same-origin filter, so a real address always has a chance to win.

import { NOISE_HREF_RE } from "./suggest.js";

const IMG_RE = /<img\b[^>]*>/gi;
const SRC_RE = /\bsrc=["']([^"']+)["']/i;
const ALT_RE = /\balt=["']([^"']*)["']/i;

const ANCHOR_RE = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const MAILTO_RE = /^mailto:/i;

const SOCIAL_DOMAINS = [
  ["twitter", /(^|\.)(twitter\.com|x\.com)$/i],
  ["facebook", /(^|\.)facebook\.com$/i],
  ["instagram", /(^|\.)instagram\.com$/i],
  ["linkedin", /(^|\.)linkedin\.com$/i],
  ["youtube", /(^|\.)(youtube\.com|youtu\.be)$/i],
  ["threads", /(^|\.)threads\.net$/i],
  ["bluesky", /(^|\.)bsky\.app$/i],
];

function platformFor(url) {
  try {
    const host = new URL(url).hostname;
    for (const [platform, re] of SOCIAL_DOMAINS) {
      if (re.test(host)) return platform;
    }
  } catch {
    /* unparseable */
  }
  return null;
}

// A short plain-text window around a raw-HTML match, tags stripped — the only "where on the
// page was this" signal we hand the LLM. Cheap and approximate on purpose: a real DOM/layout
// analysis is more than this project's per-page LLM-call budget justifies.
function contextAround(html, index, radius = 200) {
  const start = Math.max(0, index - radius);
  const end = Math.min(html.length, index + radius);
  return html
    .slice(start, end)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// linkLimit defaults much higher than `limit` (images/social) because plain profile links tend
// to sit deep in document order behind a full site nav — confirmed against austintexas.gov/council:
// 79 unique same-origin links on the page, but the first council-member link (district-1) is the
// 57th, buried behind the site's mega-menu (Housing, Utility and waste, Public Safety, ...). A cap
// anywhere near the images/social default of 40 would silently truncate before ever reaching a
// single council member. 80 comfortably covers that page with room to spare; each entry is a
// short one-line candidate, so the added token cost stays modest relative to the page-text budget
// (LLM_MAX_CHARS, default 24000 chars) this project already spends per page.
export function findMediaCandidates(html, baseUrl, { limit = 40, linkLimit = 80 } = {}) {
  const images = [];
  const socialLinks = [];
  const links = [];
  const emails = [];
  const seenImages = new Set();
  const seenLinks = new Set();
  const seenEmails = new Set();
  // abs url -> index into `links`, so a later occurrence of the same href with real visible
  // text can upgrade an earlier empty-text one. Common markup pattern (confirmed against
  // austintexas.gov/council): a card's outer <a> wraps just a headshot photo with no text, then
  // a second, sibling <a> with the same href wraps the person's name. Regex matching can't tell
  // these come from "the same card", but it can prefer whichever occurrence actually has text.
  const linkIndexByUrl = new Map();

  for (const m of html.matchAll(IMG_RE)) {
    if (images.length >= limit) break;
    const tag = m[0];
    const srcMatch = SRC_RE.exec(tag);
    if (!srcMatch) continue;
    const src = srcMatch[1];
    // Skip inline pixels and obvious shared chrome (nav/footer logos, favicons) — never a
    // per-person headshot, and just noise for the LLM to wade through.
    if (/^data:/i.test(src)) continue;
    if (/logo|icon|sprite|favicon/i.test(src)) continue;
    let abs;
    try {
      abs = new URL(src, baseUrl).href;
    } catch {
      continue;
    }
    if (seenImages.has(abs)) continue;
    seenImages.add(abs);
    const altMatch = ALT_RE.exec(tag);
    images.push({ src: abs, alt: altMatch ? altMatch[1].trim() : "", context: contextAround(html, m.index) });
  }

  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    origin = null;
  }
  // Pathname+search of the page itself (hash stripped) — lets the same-page-anchor check below
  // ignore a "skip to content" link or the nav linking back to the page it's already on.
  const baseNoHash = baseUrl.split("#")[0];

  for (const m of html.matchAll(ANCHOR_RE)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    // mailto: links never have a real origin (`new URL(...).origin` is the string "null" for
    // them), so they must be pulled out here, before the same-origin check below that would
    // otherwise silently drop them — see this file's header comment for the real-world case
    // (austintexas.gov/mayor) that motivated splitting these into their own candidate list.
    if (MAILTO_RE.test(href)) {
      if (emails.length >= limit) continue;
      // Strip the "mailto:" prefix and any "?subject=..."/"#..." suffix — only the address
      // itself is a useful candidate for the `email` field.
      const address = href.replace(MAILTO_RE, "").split(/[?#]/)[0].trim();
      if (!address || seenEmails.has(address)) continue;
      seenEmails.add(address);
      emails.push({ email: address, text, context: contextAround(html, m.index) });
      continue;
    }

    let abs;
    try {
      abs = new URL(href, baseUrl).href;
    } catch {
      continue;
    }

    const platform = platformFor(abs);
    if (platform) {
      if (socialLinks.length >= limit || seenLinks.has(abs)) continue;
      seenLinks.add(abs);
      socialLinks.push({ platform, url: abs, text, context: contextAround(html, m.index) });
      continue;
    }

    // Everything else is a candidate for an official's own page (the `url` field). Same-origin
    // only — a council member's bio page is never on a third-party domain, so an off-site link
    // is never a real candidate, just noise. Also drop the page linking to itself and the same
    // agenda/minutes/news/etc. categories suggestLinks() already treats as non-roster noise.
    if (abs.split("#")[0] === baseNoHash) continue;
    if (NOISE_HREF_RE.test(href)) continue;
    let absOrigin;
    try {
      absOrigin = new URL(abs).origin;
    } catch {
      continue;
    }
    if (!origin || absOrigin !== origin) continue;

    const existingIdx = linkIndexByUrl.get(abs);
    if (existingIdx != null) {
      if (!links[existingIdx].text && text) {
        links[existingIdx].text = text;
        links[existingIdx].context = contextAround(html, m.index);
      }
      continue;
    }
    if (links.length >= linkLimit) continue;
    linkIndexByUrl.set(abs, links.length);
    links.push({ url: abs, text, context: contextAround(html, m.index) });
  }

  return { images, socialLinks, emails, links };
}

// Defensive net for the "jurisdiction-wide account mistaken for a personal one" failure mode
// (confirmed for Ann Arbor, MI: its own Instagram matched as a candidate during site
// discovery in local-officials.mjs — same shape of mistake can happen per-official here). If
// the exact same photo or social URL is attached to several different officials from one
// scrape, it's shared branding, not a personal photo/account — strip it from all of them.
// Threshold of 3 matches the "looks like an actual roster" signal local-officials.mjs already
// uses (byId.size >= 3) elsewhere in this codebase.
export function stripSharedMedia(officials, { threshold = 3 } = {}) {
  const photoCounts = new Map();
  const socialCounts = new Map();
  for (const o of officials) {
    if (o.photo_url) photoCounts.set(o.photo_url, (photoCounts.get(o.photo_url) || 0) + 1);
    for (const [platform, url] of Object.entries(o.social || {})) {
      if (!url) continue;
      const key = `${platform}:${url}`;
      socialCounts.set(key, (socialCounts.get(key) || 0) + 1);
    }
  }
  return officials.map((o) => {
    const rec = { ...o };
    if (rec.photo_url && photoCounts.get(rec.photo_url) >= threshold) rec.photo_url = null;
    if (rec.social) {
      const social = { ...rec.social };
      for (const [platform, url] of Object.entries(social)) {
        if (url && socialCounts.get(`${platform}:${url}`) >= threshold) social[platform] = null;
      }
      rec.social = social;
    }
    return rec;
  });
}
