// Cheap regex scan of a page's raw HTML for photo and social-media candidates, run
// alongside (not instead of) the visible-text extraction in extract.js.
//
// fetch.js's htmlToText() strips every <img> and <a> tag before the page text ever reaches
// the LLM, so without this the model has no src/href to work with at all — which is exactly
// why extract.js's `photo_url` field has stayed null in practice even though the prompt has
// always asked for it. This module surfaces the raw candidates; attributing "whose photo is
// this" is still the LLM's job, using each candidate's `context` snippet as its only
// proximity signal (same "AI extraction over hand-written per-site parsing" trade-off the
// rest of this scraper makes).

const IMG_RE = /<img\b[^>]*>/gi;
const SRC_RE = /\bsrc=["']([^"']+)["']/i;
const ALT_RE = /\balt=["']([^"']*)["']/i;

const ANCHOR_RE = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

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

export function findMediaCandidates(html, baseUrl, { limit = 40 } = {}) {
  const images = [];
  const socialLinks = [];
  const seenImages = new Set();
  const seenLinks = new Set();

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

  for (const m of html.matchAll(ANCHOR_RE)) {
    if (socialLinks.length >= limit) break;
    const href = m[1];
    let abs;
    try {
      abs = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    const platform = platformFor(abs);
    if (!platform) continue;
    if (seenLinks.has(abs)) continue;
    seenLinks.add(abs);
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    socialLinks.push({ platform, url: abs, text, context: contextAround(html, m.index) });
  }

  return { images, socialLinks };
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
