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

// Trims webSearch()'s {title, url, snippet}[] down to what the client actually renders, adding
// the derived source label and capping the count — a rep's profile page is a summary, not a
// full search-results page.
export function parseNewsResults(results) {
  return (results || [])
    .filter((r) => r?.url)
    .slice(0, MAX_ARTICLES)
    .map((r) => ({
      title: r.title || r.url,
      url: r.url,
      source: hostnameFrom(r.url),
      snippet: r.snippet || '',
    }));
}
