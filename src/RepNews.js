import { useEffect, useState } from 'react';

// Recent news for one representative, fetched lazily when their profile page is opened (never
// prefetched for the whole results list — most reps' profiles are never opened, so eagerly
// searching for all of them would burn through the search API's free-tier quota for nothing).
// Backed by netlify/functions/rep-news.mjs, which reuses scraper/src/search.js's webSearch()
// server-side. That call is routed by SEARCH_PRESET_NEWS (tavily, for its news topic) rather
// than the SEARCH_PRESET the scraper's discovery fallback uses (brave) — see search.js's header
// comment. With no key configured, the "isn't set up yet" branch below renders.
// Absolute date rather than "3 days ago": a relative label silently goes stale against the 12h
// blob cache (rep-news.mjs), and for news that's months rather than minutes old a real date is
// what a reader actually wants to judge freshness by.
function formatPublished(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function RepNews({ rep }) {
  const [state, setState] = useState({ status: 'loading', articles: [], reason: null });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', articles: [], reason: null });

    const params = new URLSearchParams({
      id: rep.id,
      name: rep.name || '',
      area: rep.area || '',
      state: rep.state || '',
      district: rep.district || '',
      body: rep.body || '',
    });

    fetch(`/api/rep-news?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        if (cancelled) return;
        setState({ status: 'done', articles: data.articles || [], reason: data.reason || null });
      })
      .catch((error) => {
        console.error('Fetching rep news failed:', error);
        if (!cancelled) setState({ status: 'error', articles: [], reason: null });
      });

    return () => { cancelled = true; };
    // rep.id is enough to key this on — the other fields only refine the search query and don't
    // change independently of the rep the page is showing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rep.id]);

  return (
    <section className="rep-news">
      <h2>Recent news</h2>
      {state.status === 'loading' && (
        <p className="rep-news-status" aria-live="polite">
          <span className="scrape-status-dot" aria-hidden="true" />
          Loading recent news…
        </p>
      )}
      {state.status === 'error' && (
        <p className="rep-news-status rep-news-status-muted">Couldn't load recent news right now.</p>
      )}
      {/* A `reason` on an otherwise-successful response means search isn't configured/available
          (see rep-news.mjs) — distinct from "configured, and genuinely found nothing" below, the
          same distinction RepVotingRecord.js draws for its own "not set up" state. */}
      {state.status === 'done' && state.reason && (
        <p className="rep-news-status rep-news-status-muted">News search isn't set up yet for this deployment.</p>
      )}
      {state.status === 'done' && !state.reason && state.articles.length === 0 && (
        <p className="rep-news-status rep-news-status-muted">No recent news found.</p>
      )}
      {state.status === 'done' && !state.reason && state.articles.length > 0 && (
        <ul className="rep-news-list">
          {state.articles.map((a, i) => (
            <li key={i}>
              {/* Both media fields are optional and provider-dependent (see
                  scraper/src/search.js) — an article with neither renders as text alone, which is
                  why the thumbnail is a sibling of the text block rather than wrapping it.
                  referrerPolicy keeps the reader's profile URL from leaking to the publisher's CDN
                  on a hotlinked image, and onError hides anything that 404s or is hotlink-blocked
                  rather than leaving a broken-image glyph in the list. */}
              {(a.image || a.favicon) && (
                <img
                  className={a.image ? 'rep-news-thumb' : 'rep-news-favicon'}
                  src={a.image || a.favicon}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
              <div className="rep-news-text">
                <a href={a.url} target="_blank" rel="noreferrer noopener">{a.title}</a>
                {(a.source || a.publishedAt) && (
                  <span className="rep-news-source">
                    {a.source}
                    {a.source && a.publishedAt && ' · '}
                    {a.publishedAt && <time dateTime={a.publishedAt}>{formatPublished(a.publishedAt)}</time>}
                  </span>
                )}
                {a.snippet && <p className="rep-news-snippet">{a.snippet}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
