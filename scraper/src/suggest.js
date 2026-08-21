// Shared helper: scan a site's homepage for links that look like a council/commissioners
// roster page. Used to recover from a wrong seed URL — both the probe and a real scrape
// report these so a bad URL can be replaced without guessing.

const LINK_RE = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

// Agendas/minutes/video/news coverage mention "council" but aren't roster (or profile) pages —
// confirmed against Boulder, CO: a "City Council Voices Support For..." news post matched on
// "council" and got offered as a candidate ahead of the real roster page. `article`/`story`
// added after Wayne County, MI: a search for "commissioners" there returned nothing but
// /articles/... press-release URLs (e.g. "Commissioners honor pioneering former Chair..."),
// which "news"/"press" alone didn't catch — see discover.js's findRosterPage() for where a
// search result goes through this same filter. Exported so media.js's same-origin link scan and
// discover.js's search-result seeding can both drop the same noise the original crawl already
// guards against, instead of each maintaining its own copy of this list.
export const NOISE_HREF_RE = /agenda|minute|video|calendar|meeting|archive|news|press|blog|article|story|stories|event|\.pdf$/i;

export function suggestLinks(html, baseUrl, limit = 6) {
  const out = new Map();
  for (const m of html.matchAll(LINK_RE)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!/council|commissioner|elected|mayor|government/i.test(`${href} ${text}`)) continue;
    // Skip agendas/minutes/video/news coverage — they mention the council but aren't roster
    // pages (confirmed against Boulder, CO: a "City Council Voices Support For..." news post
    // matched on "council" and got offered as a candidate ahead of the real roster page).
    if (NOISE_HREF_RE.test(href)) continue;
    try {
      const abs = new URL(href, baseUrl).href;
      if (!out.has(abs)) out.set(abs, text || "(no text)");
    } catch {
      /* ignore unparseable href */
    }
  }
  return [...out.entries()].slice(0, limit);
}
