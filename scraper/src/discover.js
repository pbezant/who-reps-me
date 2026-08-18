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

  let raw;
  try {
    raw = await callLLM({ system: SYSTEM_PROMPT, user, maxOutput: 60 });
  } catch {
    return null; // fatal (bad key/retired preset) or transient — either way, no site found
  }

  const url = extractUrl(raw);
  if (!url) return null;

  const page = await fetchPage(url, { allowBrowser: false, timeoutMs: 8000 }).catch(() => null);
  if (!looksLikeGovSite(page, city)) return null;

  return { url, page };
}
