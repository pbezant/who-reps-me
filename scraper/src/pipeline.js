// Orchestrates one jurisdiction: fetch each seed URL -> extract -> normalize -> dedupe.
// At nationwide scale this same function is called per-jurisdiction by a queue worker;
// here run.js just loops the seed file.

import { fetchPage } from "./fetch.js";
import { extractOfficials } from "./extract.js";
import { normalize } from "./normalize.js";
import { suggestLinks } from "./suggest.js";
import { findMediaCandidates, stripSharedMedia } from "./media.js";

// Look at the site's homepage for a better candidate URL. Best-effort: never throws.
async function findSuggestions(url, allowBrowser) {
  try {
    const origin = new URL(url).origin;
    const home = await fetchPage(origin, { allowBrowser });
    return home.ok ? suggestLinks(home.html, origin) : [];
  } catch {
    return [];
  }
}

export async function scrapeJurisdiction(jurisdiction, { now, allowBrowser = false }) {
  const results = [];
  const problems = [];

  for (const url of jurisdiction.urls) {
    const page = await fetchPage(url, { allowBrowser });
    if (!page.ok) {
      // browserError explains why the Playwright fallback couldn't rescue a blocked/empty page.
      const detail = page.browserError ? `${page.error}; ${page.browserError}` : page.error;
      problems.push({ url, error: detail, suggestions: await findSuggestions(url, allowBrowser) });
      continue;
    }
    if (page.needsBrowser) {
      // Almost no text and no browser fallback available — flag rather than silently returning
      // nothing, so probe/problems output shows this page needs Playwright installed.
      problems.push({
        url,
        error: page.browserError
          ? `needs-browser (empty static render); ${page.browserError}`
          : "needs-browser (empty static render)",
        suggestions: await findSuggestions(url, allowBrowser),
      });
      continue;
    }

    // Regex-scanned from the raw HTML (fetch.js already stripped tags out of page.text for
    // the LLM) — see media.js for why this is what makes photo_url/social reachable at all.
    const media = findMediaCandidates(page.html, url);

    let raw;
    try {
      raw = await extractOfficials({ text: page.text, url, jurisdiction, media });
    } catch (err) {
      if (err?.fatal) {
        err.jurisdiction = `${jurisdiction.city}, ${jurisdiction.state}`;
        throw err;
      }
      problems.push({ url, error: `extract failed: ${err.message}` });
      continue;
    }

    for (const r of raw) {
      const rec = normalize(r, { jurisdiction, sourceUrl: url, extractedAt: now });
      if (rec) results.push(rec);
    }
  }

  // Dedupe by id (same person can appear on multiple seed pages), keep highest confidence.
  const byId = new Map();
  for (const rec of results) {
    const prev = byId.get(rec.id);
    if (!prev || (rec.confidence ?? 0) > (prev.confidence ?? 0)) byId.set(rec.id, rec);
  }

  return { officials: stripSharedMedia([...byId.values()]), problems };
}
