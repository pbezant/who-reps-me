import { useEffect, useState } from 'react';

// Recent news for one representative, fetched lazily when their profile page is opened (never
// prefetched for the whole results list — most reps' profiles are never opened, so eagerly
// searching for all of them would burn through the search API's free-tier quota for nothing).
// Backed by netlify/functions/rep-news.mjs, which reuses scraper/src/search.js's webSearch()
// server-side — the same Brave-search key already configured for the scraper's own discovery
// fallback, no new setup required for this feature.
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
              <a href={a.url} target="_blank" rel="noreferrer noopener">{a.title}</a>
              {a.source && <span className="rep-news-source"> — {a.source}</span>}
              {a.snippet && <p className="rep-news-snippet">{a.snippet}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
