import React, { useEffect, useRef, useState } from 'react';

// "Help us grow this map" — a floating button (bottom-right, always available — a gap can be
// noticed before a search ever completes) that opens a short form for reporting a missing or
// outdated official. Framed as contributing to the dataset, not "filing a bug": a visitor drops
// a link to where they saw the gap plus a quick note, we check it by hand, and it gets folded in
// when it's real. The backend (netlify/functions/report-bug.mjs) triages each submission on the
// spot: one LLM call checks it against currently-open `user-reported` GitHub issues to catch
// duplicates (commenting on the existing issue instead of filing a new one), then either opens a
// new issue or doesn't, and appends a row to BUG_REPORTS.md either way — see that function's own
// header comment for the full flow. No batching/threshold: every submission is triaged
// immediately, so a real gap doesn't sit unreported waiting for a quota of strangers to also
// notice it.

const STATUS_IDLE = 'idle';
const STATUS_SUBMITTING = 'submitting';
const STATUS_DONE = 'done';

const MAX_NOTE_LENGTH = 2000;
const MAX_URL_LENGTH = 500;

// Whatever the current search (if any) already tells us — passed along as context so a report
// like "no results showed up" carries the location that failed, without asking the visitor to
// retype it. Best-effort: a report made before any search still submits fine with this null.
function searchContext(repList) {
  if (!repList?.geo) return null;
  const { place, county, state } = repList.geo;
  return { place: place || null, county: county || null, state: state || null };
}

export default function ReportBug({ repList }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState(STATUS_IDLE);
  // { message, ok, issueUrl? } once a submission has resolved — null before then.
  const [result, setResult] = useState(null);
  const urlRef = useRef(null);

  const openDialog = () => {
    setUrl('');
    setNote('');
    setStatus(STATUS_IDLE);
    setResult(null);
    setOpen(true);
  };
  const closeDialog = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    urlRef.current?.focus();
    const onKeyDown = (e) => {
      if (e.key === 'Escape') closeDialog();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmedNote = note.trim();
    if (!trimmedNote || status === STATUS_SUBMITTING) return;
    setStatus(STATUS_SUBMITTING);
    setResult(null);
    try {
      const res = await fetch('/api/report-bug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          note: trimmedNote,
          url: url.trim(),
          context: {
            page: `${window.location.pathname}${window.location.search}`,
            userAgent: navigator.userAgent,
            search: searchContext(repList),
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.status === 'error') {
        setResult({ ok: false, message: data.error || data.message || `Something went wrong (HTTP ${res.status}).` });
      } else {
        setResult({ ok: true, message: data.message || 'Thanks for the help!', issueUrl: data.issueUrl || null });
      }
    } catch (error) {
      console.error('Contribution submission failed:', error);
      setResult({ ok: false, message: "Couldn't reach the server — check your connection and try again." });
    } finally {
      setStatus(STATUS_DONE);
    }
  };

  return (
    <>
      <button
        type="button"
        className="report-bug-fab"
        onClick={openDialog}
        aria-haspopup="dialog"
        aria-label="Help us grow this map"
        title="Help us grow this map"
      >
        <span aria-hidden="true">+</span>
      </button>

      {open && (
        <div className="report-bug-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeDialog(); }}>
          <div className="report-bug-dialog" role="dialog" aria-modal="true" aria-labelledby="report-bug-heading">
            <button type="button" className="report-bug-close" onClick={closeDialog} aria-label="Close">
              ×
            </button>
            <h2 id="report-bug-heading">See something we're missing?</h2>
            <p className="report-bug-intro">
              Found an official we don't have, or something that's out of date? Paste a link to
              where you saw it, and a quick note on what's off. We check every submission by
              hand, and anything real gets added to the map.
            </p>
            <form onSubmit={handleSubmit}>
              <label htmlFor="report-bug-url">Link to where you saw it (optional, but helps a lot)</label>
              <input
                id="report-bug-url"
                ref={urlRef}
                type="url"
                inputMode="url"
                placeholder="https://yourcity.gov/city-council"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                maxLength={MAX_URL_LENGTH}
                disabled={status === STATUS_SUBMITTING}
              />
              <label htmlFor="report-bug-note">What's missing or wrong?</label>
              <textarea
                id="report-bug-note"
                placeholder="e.g. Our two newest city council members aren't listed"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={MAX_NOTE_LENGTH}
                required
                disabled={status === STATUS_SUBMITTING}
              />
              <button type="submit" className="report-bug-submit" disabled={status === STATUS_SUBMITTING || !note.trim()}>
                {status === STATUS_SUBMITTING ? 'Sending…' : 'Send it in'}
              </button>
            </form>
            {result && (
              <p className={`report-bug-result ${result.ok ? 'ok' : 'error'}`} aria-live="polite">
                {result.message}
                {result.issueUrl && (
                  <>
                    {' '}
                    <a href={result.issueUrl} target="_blank" rel="noreferrer noopener">View the issue</a>
                  </>
                )}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
