import React, { useEffect, useRef, useState } from 'react';

// "Report a bug" — a floating button (bottom-right, always available — unlike the "suggest an
// official" feature this replaced, a bug can happen before a search ever completes) that opens a
// short form for reporting a problem. The backend (netlify/functions/report-bug.mjs) triages
// each submission on the spot: one LLM call checks it against currently-open `user-reported`
// GitHub issues to catch duplicates (commenting on the existing issue instead of filing a new
// one), then either opens a new issue or doesn't, and appends a row to BUG_REPORTS.md either way
// — see that function's own header comment for the full flow. No batching/threshold: every
// submission is triaged immediately, so a genuinely broken site doesn't sit unreported waiting
// for a quota of strangers to also notice.

const STATUS_IDLE = 'idle';
const STATUS_SUBMITTING = 'submitting';
const STATUS_DONE = 'done';

const MAX_DESCRIPTION_LENGTH = 2000;

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
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState(STATUS_IDLE);
  // { message, ok, issueUrl? } once a submission has resolved — null before then.
  const [result, setResult] = useState(null);
  const descriptionRef = useRef(null);

  const openDialog = () => {
    setDescription('');
    setStatus(STATUS_IDLE);
    setResult(null);
    setOpen(true);
  };
  const closeDialog = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    descriptionRef.current?.focus();
    const onKeyDown = (e) => {
      if (e.key === 'Escape') closeDialog();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = description.trim();
    if (!trimmed || status === STATUS_SUBMITTING) return;
    setStatus(STATUS_SUBMITTING);
    setResult(null);
    try {
      const res = await fetch('/api/report-bug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: trimmed,
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
        setResult({ ok: true, message: data.message || 'Thanks for the report!', issueUrl: data.issueUrl || null });
      }
    } catch (error) {
      console.error('Bug report submission failed:', error);
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
        aria-label="Report a bug"
        title="Report a bug"
      >
        <span aria-hidden="true">!</span>
      </button>

      {open && (
        <div className="report-bug-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeDialog(); }}>
          <div className="report-bug-dialog" role="dialog" aria-modal="true" aria-labelledby="report-bug-heading">
            <button type="button" className="report-bug-close" onClick={closeDialog} aria-label="Close">
              ×
            </button>
            <h2 id="report-bug-heading">Something not working?</h2>
            <p className="report-bug-intro">
              Tell us what happened — a bad result, something broken, anything. We'll check it
              right away.
            </p>
            <form onSubmit={handleSubmit}>
              <label htmlFor="report-bug-description">What went wrong?</label>
              <textarea
                id="report-bug-description"
                ref={descriptionRef}
                placeholder="e.g. Searching my address showed the wrong mayor"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={MAX_DESCRIPTION_LENGTH}
                required
                disabled={status === STATUS_SUBMITTING}
              />
              <button type="submit" className="report-bug-submit" disabled={status === STATUS_SUBMITTING || !description.trim()}>
                {status === STATUS_SUBMITTING ? 'Checking…' : 'Submit'}
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
