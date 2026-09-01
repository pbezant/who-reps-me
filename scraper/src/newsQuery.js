// Query-building and result-trimming for the "recent news" profile section
// (netlify/functions/rep-news.mjs). Pure logic only — no network, no LLM — split out so it's
// unit-testable without a real search call, same reasoning as search.js's own parseBraveResults/
// parseGoogleResults split (see that file's header comment).
//
// The query needs to disambiguate a common name ("John Smith") from every other John Smith on
// the web, which is why it's built per-tier rather than as a bare name search: a federal rep's
// office+state, a state legislator's chamber+state, or a local official's governing body are all
// already on the card and cheap to fold in.

const FEDERAL_TITLE = { 'US House': 'U.S. Representative', 'US Senate': 'U.S. Senator' };

export function buildNewsQuery({ name, area, state, body } = {}) {
  if (!name) return '';
  if (FEDERAL_TITLE[area]) {
    return normalize(`"${name}" ${FEDERAL_TITLE[area]} ${state || ''} news`);
  }
  if (area === 'StateUpper' || area === 'StateLower') {
    const chamber = area === 'StateUpper' ? `${state} Senate` : `${state} House`;
    return normalize(`"${name}" ${chamber} news`);
  }
  // Local officials and state executives: `body` (e.g. "Austin City Council") is the most
  // disambiguating local signal when present; the office title itself (e.g. "Mayor",
  // "Governor") is the next best thing.
  return normalize(`"${name}" ${body || area || ''} ${state || ''} news`);
}

function normalize(query) {
  return query.replace(/\s+/g, ' ').trim();
}

// Best-effort readable source label ("nytimes.com" from a full article URL) — search results
// don't carry a publisher name field, and a bare domain reads better in a list than the full URL.
export function hostnameFrom(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const MAX_ARTICLES = 5;

// Tavily strips the quotes from buildNewsQuery()'s `"Name" office state news`, so an exact-phrase
// match is not actually on offer and a common first name drags in articles about a different
// person: a live query for a Texas House member returned a stay-at-home mom and a judicial
// nominee, both merely named "Erin", scoring 0.26 and 0.13. Anything this weak is worse than an
// empty section — it attributes a stranger's story to the official on the page — so it's dropped.
// Providers that don't score results (brave, google) report null and are never filtered out.
const MIN_SCORE = 0.4;

// Tavily's published_date is RFC 1123 ("Thu, 30 Oct 2025 09:00:02 GMT"); brave's page_age is
// already ISO. Normalized here so the client gets one format to render and an unparseable value
// degrades to "no date shown" rather than "Invalid Date".
export function toIsoDate(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

// Tavily's `content` is an extractive digest, not a headline blurb: several passages lifted from
// the article and joined with a literal " [...] ", routinely 800+ characters. Rendered raw, one
// result filled the whole panel and buried the next headline — the profile page wants a taste of
// each story, not the story. Trimmed here rather than only clamped in CSS so the response payload
// stays small too, and so the cut lands on a word boundary instead of mid-syllable.
const MAX_SNIPPET_CHARS = 240;

export function trimSnippet(text) {
  const cleaned = String(text || "")
    .replace(/\s+/g, " ")
    // The joiner reads as noise mid-sentence; an ellipsis says the same thing in one character.
    .replace(/\[\.\.\.\]/g, "…")
    .replace(/^[…\s]+|[…\s]+$/g, "")
    .trim();
  if (cleaned.length <= MAX_SNIPPET_CHARS) return cleaned;
  const cut = cleaned.slice(0, MAX_SNIPPET_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  // Drop trailing punctuation so the result never reads as ",…" or ".…".
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.—-]+$/, "")}…`;
}

// Trims webSearch()'s {title, url, snippet}[] down to what the client actually renders, adding
// the derived source label and capping the count — a rep's profile page is a summary, not a
// full search-results page.
export function parseNewsResults(results) {
  return (results || [])
    .filter((r) => r?.url)
    // Before the cap, not after — otherwise five weak results would fill the list and hide the
    // strong ones sitting behind them.
    .filter((r) => r.score == null || r.score >= MIN_SCORE)
    .slice(0, MAX_ARTICLES)
    .map((r) => ({
      title: r.title || r.url,
      url: r.url,
      source: hostnameFrom(r.url),
      snippet: trimSnippet(r.snippet),
      // Only ever one image per article, chosen upstream — the raw per-result list can run to
      // fifteen URLs, and all of that would otherwise land in the 12h blob cache for every rep.
      // Both fields are optional: whether they arrive at all depends on the provider.
      image: r.image || '',
      favicon: r.favicon || '',
      publishedAt: toIsoDate(r.publishedAt),
    }));
}
