// Orchestrates one jurisdiction: fetch each seed URL -> extract -> normalize -> dedupe.
// At nationwide scale this same function is called per-jurisdiction by a queue worker;
// here run.js just loops the seed file.

import { fetchPage } from "./fetch.js";
import { extractOfficials } from "./extract.js";
import { normalize } from "./normalize.js";

export async function scrapeJurisdiction(jurisdiction, { now }) {
  const results = [];
  const problems = [];

  for (const url of jurisdiction.urls) {
    const page = await fetchPage(url);
    if (!page.ok) {
      problems.push({ url, error: page.error });
      continue;
    }
    if (page.needsBrowser) {
      // Static fetch got almost no text — likely a JS-rendered SPA. Flag for the
      // Playwright fallback (phase 2) instead of silently returning nothing.
      problems.push({ url, error: "needs-browser (empty static render)" });
      continue;
    }

    let raw;
    try {
      raw = await extractOfficials({ text: page.text, url, jurisdiction });
    } catch (err) {
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

  return { officials: [...byId.values()], problems };
}
