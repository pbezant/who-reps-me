// Shared helper: scan a site's homepage for links that look like a council/commissioners
// roster page. Used to recover from a wrong seed URL — both the probe and a real scrape
// report these so a bad URL can be replaced without guessing.

const LINK_RE = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

export function suggestLinks(html, baseUrl, limit = 6) {
  const out = new Map();
  for (const m of html.matchAll(LINK_RE)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!/council|commissioner|elected|mayor|government/i.test(`${href} ${text}`)) continue;
    // Skip agendas/minutes/video/news coverage — they mention the council but aren't roster
    // pages (confirmed against Boulder, CO: a "City Council Voices Support For..." news post
    // matched on "council" and got offered as a candidate ahead of the real roster page).
    if (/agenda|minute|video|calendar|meeting|archive|news|press|blog|event|\.pdf$/i.test(href)) continue;
    try {
      const abs = new URL(href, baseUrl).href;
      if (!out.has(abs)) out.set(abs, text || "(no text)");
    } catch {
      /* ignore unparseable href */
    }
  }
  return [...out.entries()].slice(0, limit);
}
