import { useEffect, useState } from 'react';
import { formatDate } from './RepCard';

const FEDERAL_AREAS = new Set(['US House', 'US Senate']);

// Which backend (if any) can answer for this rep's tier, and what id it needs. Local officials
// and state executives have no viable source — city council votes generally aren't digitized
// anywhere generically scrapable, and governors/AGs don't sponsor bills the way legislators do —
// so those get a static "not available" message with no network request at all, rather than a
// call that would only ever come back empty.
function votingSource(rep) {
  if (rep.isLocal || rep.isStateExecutive) return null;
  if (rep.isStateLegislator) {
    // state-votes.mjs also needs `state` — Open States' /bills requires a `jurisdiction` filter
    // alongside `sponsor` (confirmed against a live call: it 400s without one), and jurisdiction
    // is built server-side from this two-letter code — see that function's own header comment.
    return { path: '/api/state-votes', params: { personId: rep.id, state: rep.state } };
  }
  if (FEDERAL_AREAS.has(rep.area)) return { path: '/api/federal-votes', params: { bioguideId: rep.id } };
  return null;
}

// Recent legislative activity (bills sponsored/cosponsored) for federal and state-legislator
// reps — see netlify/functions/state-votes.mjs and federal-votes.mjs. Deliberately scoped to
// bill sponsorship, not true roll-call yes/no vote history: neither Open States nor Congress.gov
// exposes a clean per-member vote history endpoint, and Open States' vote-event coverage varies
// too much by state to promise consistently for v1.
export default function RepVotingRecord({ rep }) {
  const source = votingSource(rep);
  const [state, setState] = useState({ status: 'loading', items: [], reason: null });

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    setState({ status: 'loading', items: [], reason: null });

    const query = new URLSearchParams(source.params).toString();
    fetch(`${source.path}?${query}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        if (cancelled) return;
        setState({ status: 'done', items: data.items || [], reason: data.reason || null });
      })
      .catch((error) => {
        console.error('Fetching voting record failed:', error);
        if (!cancelled) setState({ status: 'error', items: [], reason: null });
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.path, source?.params && Object.values(source.params).join('|')]);

  return (
    <section className="rep-voting-record">
      <h2>Voting &amp; legislative activity</h2>
      {!source && (
        <p className="rep-voting-status rep-voting-status-muted">
          Not available for this office — {rep.isLocal ? 'local officials\' votes generally aren\'t published anywhere we can pull from' : 'this office doesn\'t sponsor legislation the way lawmakers do'}.
        </p>
      )}
      {source && state.status === 'loading' && (
        <p className="rep-voting-status" aria-live="polite">
          <span className="scrape-status-dot" aria-hidden="true" />
          Loading recent legislative activity…
        </p>
      )}
      {source && state.status === 'error' && (
        <p className="rep-voting-status rep-voting-status-muted">Couldn't load voting record right now.</p>
      )}
      {source && state.status === 'done' && state.reason && (
        <p className="rep-voting-status rep-voting-status-muted">Voting record isn't set up yet for this deployment.</p>
      )}
      {source && state.status === 'done' && !state.reason && state.items.length === 0 && (
        <p className="rep-voting-status rep-voting-status-muted">No recent bill activity found.</p>
      )}
      {source && state.status === 'done' && !state.reason && state.items.length > 0 && (
        <ul className="rep-voting-list">
          {state.items.map((item, i) => (
            <li key={item.identifier || i}>
              {/* url can be empty (e.g. an unrecognized Congress.gov legislation type) — a
                  bare label still beats a broken/empty-href link. */}
              {item.url ? (
                <a href={item.url} target="_blank" rel="noreferrer noopener">
                  {item.identifier ? `${item.identifier} — ` : ''}{item.title}
                </a>
              ) : (
                <span>{item.identifier ? `${item.identifier} — ` : ''}{item.title}</span>
              )}
              {item.role && <span className="rep-voting-role"> ({item.role})</span>}
              {item.latestActionDate && (
                <p className="rep-voting-action">
                  {/* formatDate() (RepCard.js) — not a bespoke formatter here — deliberately:
                      confirmed live against real Congress.gov data that a bare "YYYY-MM-DD"
                      parsed without pinning the timezone renders a day early in any timezone
                      behind UTC, exactly the bug formatDate()'s own comment already guards
                      against for term_end/verifiedAt. */}
                  {formatDate(item.latestActionDate)}
                  {item.latestActionDescription && ` — ${item.latestActionDescription}`}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
