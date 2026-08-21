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

const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

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
  const [turnstileToken, setTurnstileToken] = useState('');
  const urlRef = useRef(null);
  const turnstileContainerRef = useRef(null);
  const turnstileWidgetIdRef = useRef(null);

  // Read at render time (not hoisted to a module-level const) so a test can set/clear
  // process.env.REACT_APP_TURNSTILE_SITE_KEY per-test — Create React App still inlines this via
  // webpack at build time either way, since that's a straight text substitution wherever the
  // reference appears, so production behavior is identical.
  const siteKey = process.env.REACT_APP_TURNSTILE_SITE_KEY;

  // Cloudflare Turnstile (a lightweight, mostly-invisible bot check) in front of a form that
  // creates real public GitHub content from anonymous input — see report-bug.mjs's own header
  // comment for why. Resetting the widget on a failed submit gets a fresh token for the retry,
  // since a token is single-use and the failed attempt likely already spent it against
  // Cloudflare's siteverify.
  const resetTurnstile = () => {
    setTurnstileToken('');
    if (turnstileWidgetIdRef.current != null && window.turnstile) {
      window.turnstile.reset(turnstileWidgetIdRef.current);
    }
  };

  const openDialog = () => {
    setUrl('');
    setNote('');
    setStatus(STATUS_IDLE);
    setResult(null);
    setTurnstileToken('');
    setOpen(true);
  };
  const closeDialog = () => {
    if (turnstileWidgetIdRef.current != null && window.turnstile) {
      window.turnstile.remove(turnstileWidgetIdRef.current);
      turnstileWidgetIdRef.current = null;
    }
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    urlRef.current?.focus();
    const onKeyDown = (e) => {
      if (e.key === 'Escape') closeDialog();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Loaded lazily (only once the dialog actually opens, not on every page view of the app) and
  // only when a site key is configured — with none set, this does nothing at all, and the
  // server-side check skips verification too (see report-bug.mjs), so local dev and this repo's
  // own CI never need Cloudflare credentials. Deliberately does NOT gate the submit button on
  // having a token: if the script is slow, blocked by an ad-blocker, or Cloudflare has an
  // outage, a hard client-side gate would lock out a genuine visitor with no way to know why.
  // The server is the real enforcement point — an empty/invalid token there just surfaces as a
  // normal "verification failed, try again" result, same as any other submit error.
  useEffect(() => {
    if (!open || !siteKey) return;
    const renderWidget = () => {
      if (!turnstileContainerRef.current || !window.turnstile || turnstileWidgetIdRef.current != null) return;
      turnstileWidgetIdRef.current = window.turnstile.render(turnstileContainerRef.current, {
        sitekey: siteKey,
        callback: (token) => setTurnstileToken(token),
        'expired-callback': () => setTurnstileToken(''),
        // Cloudflare's own errorCode covers things like a domain/hostname mismatch (the widget's
        // Cloudflare-side config doesn't list the hostname it's actually running on) — logged so
        // a failure here is diagnosable from the browser console instead of just "nothing shows
        // up and I don't know why" (see who-reps-me issue #28's own debugging thread for exactly
        // that experience). Never surfaced to the visitor beyond this — the submit flow still
        // works, it'll just get the server's normal "verification failed" rejection.
        'error-callback': (errorCode) => {
          console.error(`Turnstile widget error (code ${errorCode}) — see https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/ for what it means. A common cause: the sitekey's configured domain list in the Cloudflare dashboard doesn't include this exact hostname (${window.location.hostname}).`);
          setTurnstileToken('');
        },
      });
    };
    if (window.turnstile) {
      renderWidget();
      return;
    }
    const existing = document.querySelector(`script[src="${TURNSTILE_SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener('load', renderWidget, { once: true });
      return () => existing.removeEventListener('load', renderWidget);
    }
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.addEventListener('load', renderWidget, { once: true });
    document.head.appendChild(script);
    return () => script.removeEventListener('load', renderWidget);
  }, [open, siteKey]);

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
          turnstileToken,
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
        resetTurnstile();
      } else {
        setResult({ ok: true, message: data.message || 'Thanks for the help!', issueUrl: data.issueUrl || null });
      }
    } catch (error) {
      console.error('Contribution submission failed:', error);
      setResult({ ok: false, message: "Couldn't reach the server — check your connection and try again." });
      resetTurnstile();
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
              {siteKey && <div className="report-bug-turnstile" ref={turnstileContainerRef} />}
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
