import React, { useEffect, useRef, useState } from 'react';

// "Suggest an official" — a floating button (bottom-right, per the design brief: appears after
// a search, once there's something on screen to suggest a correction/addition to) that opens a
// small form for pasting a URL to an elected official's page. The backend (netlify/functions/
// submit-official.mjs) validates the URL, scrapes it with the same fetch → extract → normalize
// pipeline the batch scraper uses, and stores the result in Netlify Blobs for
// scraper/scripts/promote-url-submissions.js to fold into the public dataset once it's confident
// enough — see that function's own header comment for the full pipeline and why this doesn't
// write to the shard directly from an unauthenticated form.
//
// Only rendered once a search has actually produced results (see App.js) — there's nothing to
// "add to" before that, and it would otherwise compete with the hero search box for attention.

const STATUS_IDLE = 'idle';
const STATUS_SUBMITTING = 'submitting';
const STATUS_DONE = 'done';

export default function SubmitOfficial() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState(STATUS_IDLE);
  // { message, ok } once a submission has resolved (success or error) — null before then.
  const [result, setResult] = useState(null);
  const urlInputRef = useRef(null);

  // Reset to a blank form every time the dialog is (re)opened, so a second suggestion after a
  // successful one doesn't reopen showing the previous URL/result.
  const openDialog = () => {
    setUrl('');
    setNote('');
    setStatus(STATUS_IDLE);
    setResult(null);
    setOpen(true);
  };
  const closeDialog = () => setOpen(false);

  // Focus the URL field on open, and let Escape close the dialog — same lightweight pattern the
  // address-suggestions dropdown in App.js uses, not a full focus-trap.
  useEffect(() => {
    if (!open) return;
    urlInputRef.current?.focus();
    const onKeyDown = (e) => {
      if (e.key === 'Escape') closeDialog();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl || status === STATUS_SUBMITTING) return;
    setStatus(STATUS_SUBMITTING);
    setResult(null);
    try {
      const res = await fetch('/api/submit-official', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmedUrl, note: note.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ ok: false, message: data.error || `Something went wrong (HTTP ${res.status}).` });
      } else if (data.status === 'error') {
        setResult({ ok: false, message: data.message || 'Something went wrong.' });
      } else {
        setResult({ ok: true, message: data.message || 'Thanks for the suggestion!' });
      }
    } catch (error) {
      console.error('Official-URL submission failed:', error);
      setResult({ ok: false, message: "Couldn't reach the server — check your connection and try again." });
    } finally {
      setStatus(STATUS_DONE);
    }
  };

  return (
    <>
      <button
        type="button"
        className="suggest-official-fab"
        onClick={openDialog}
        aria-haspopup="dialog"
        aria-label="Suggest an official we're missing"
        title="Suggest an official we're missing"
      >
        <span aria-hidden="true">+</span>
      </button>

      {open && (
        <div className="suggest-official-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeDialog(); }}>
          <div
            className="suggest-official-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="suggest-official-heading"
          >
            <button type="button" className="suggest-official-close" onClick={closeDialog} aria-label="Close">
              ×
            </button>
            <h2 id="suggest-official-heading">Know an official we're missing?</h2>
            <p className="suggest-official-intro">
              Paste a link to their city/county government page — a roster page or their own bio
              page both work. We'll check it and add them once it's confirmed.
            </p>
            <form onSubmit={handleSubmit}>
              <label htmlFor="suggest-official-url">Official's page URL</label>
              <input
                id="suggest-official-url"
                ref={urlInputRef}
                type="url"
                inputMode="url"
                placeholder="https://www.yourcity.gov/city-council"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                disabled={status === STATUS_SUBMITTING}
              />
              <label htmlFor="suggest-official-note">Anything else worth knowing? (optional)</label>
              <input
                id="suggest-official-note"
                type="text"
                placeholder="e.g. their name, or the city if it's not obvious from the link"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                disabled={status === STATUS_SUBMITTING}
              />
              <button type="submit" className="suggest-official-submit" disabled={status === STATUS_SUBMITTING || !url.trim()}>
                {status === STATUS_SUBMITTING ? 'Checking…' : 'Submit'}
              </button>
            </form>
            {result && (
              <p className={`suggest-official-result ${result.ok ? 'ok' : 'error'}`} aria-live="polite">
                {result.message}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
