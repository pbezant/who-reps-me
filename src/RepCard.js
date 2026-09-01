import { Link } from 'react-router-dom';

import { slugFromId } from './officials';

// Shared pieces between the results-list summary card (RepCard, below) and the full profile
// page (src/RepProfile.js) — split out of App.js so the profile page can reuse them instead of
// duplicating rendering logic. See App.js's git history for why this split happened: the old
// RepCard rendered every field a rep could have, all at once, which had become a wall of text —
// this file now owns just the short, scannable summary; RepProfile.js owns the full detail.

// Minimal inline glyphs (not literal brand marks) so a social row needs no icon-library
// dependency, consistent with the rest of this dependency-free frontend.
const SOCIAL_ICONS = {
  // The real X wordmark, not two crossed strokes. The old glyph was `M4 4l16 16M20 4L4 20` —
  // a symmetric X, which at icon size in the corner of a translucent panel reads as a
  // close/dismiss control rather than a brand. This path is asymmetric and filled, and it now
  // sits beside a visible "X" text label, so there is nothing left to misread.
  twitter: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.53 3h3.2l-6.99 7.99L22 21h-6.44l-5.04-6.59L4.75 21H1.54l7.48-8.55L1.5 3h6.6l4.56 6.03L17.53 3zm-1.12 16.06h1.77L7.68 4.84H5.78l10.63 14.22z" />
    </svg>
  ),
  facebook: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.5 21v-7.5h2.5l.5-3h-3V8.5c0-.9.3-1.5 1.6-1.5h1.4V4.3C16 4.2 15 4 13.9 4 11.5 4 10 5.4 10 8.2v2.3H7.5v3H10V21h3.5z" />
    </svg>
  ),
  instagram: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="5" ry="5" />
      <circle cx="12" cy="12" r="4.2" />
      <circle cx="17.3" cy="6.7" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  ),
  linkedin: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <circle cx="6.9" cy="6.6" r="2" />
      <path d="M5 10.5h3.9V20H5zM12.5 10.5H16v1.3c.6-.9 1.7-1.5 3-1.5 2.5 0 3.5 1.6 3.5 4.1V20h-3.9v-4.6c0-1.1-.4-1.9-1.5-1.9-1 0-1.5.7-1.5 1.9V20h-3.1z" />
    </svg>
  ),
  youtube: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="6" width="20" height="12" rx="4" />
      <path d="M10 9.3l6 2.7-6 2.7z" fill="currentColor" stroke="none" />
    </svg>
  ),
};

const SOCIAL_LABELS = {
  twitter: 'X',
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
};

// Socials as their own labelled panel of icon+text pills, rather than the bare icon row this
// replaced. That row was genuinely undiscoverable: 25px unlabelled targets at 85% opacity,
// buried mid-list between a website URL and a term-end date, with no heading to say what they
// were. Three things fix it — a heading, visible platform names, and 44px tap targets.
//
// A heading also makes ABSENCE read correctly. Social links are a mostly-empty field (of 160
// Texas local officials only 9 have any at all, though nearly every member of Congress does),
// so this returns null rather than leaving a labelled hole on the majority of pages.
export function SocialPanel({ social }) {
  const entries = Object.entries(social || {}).filter(([, url]) => url);
  if (!entries.length) return null;
  return (
    <section className="rep-panel rep-social-panel-wrap">
      <h2 className="rep-panel-title">Find them online</h2>
      <div className="rep-social-panel">
        {entries.map(([platform, url]) => (
          <a key={platform} href={url} target="_blank" rel="noreferrer noopener" className="rep-social-link">
            {SOCIAL_ICONS[platform] || null}
            <span>{SOCIAL_LABELS[platform] || platform}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

// Human label for an office's classification string. Sources disagree on the exact wording
//("capitol", "district-mail", "dc", ...) so normalize.js/stateLegislators.js pass it through
// as-is rather than validating against a fixed enum — this is where that gets turned into
// something readable, falling back to a title-cased version of whatever string showed up.
const OFFICE_LABELS = {
  capitol: 'Capitol Office',
  dc: 'DC Office',
  district: 'District Office',
  'district-mail': 'District Office',
  primary: 'Main Office',
  other: 'Office',
};

function labelForClassification(classification) {
  if (OFFICE_LABELS[classification]) return OFFICE_LABELS[classification];
  return String(classification || 'Office')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Renders a rep's `offices[]` (district/field/capitol offices beyond the single top-level
// phone already shown above it) — see scraper/src/normalize.js's normalizeOffices() for the
// shared shape. Skips an entry that would just repeat the top-level phone with nothing else
// to add (address/fax/hours), so a federal rep's DC office doesn't show up twice.
export function OfficesList({ offices, topLevelPhone, topLevelAddress }) {
  const extra = (offices || []).filter((o) => {
    const addsNothingNew = !o.address && !o.hours && !o.fax;
    const samePhone = topLevelPhone && o.phone === topLevelPhone;
    // Drop the office outright only when it is a pure duplicate: same phone and nothing else to
    // offer. An office that repeats the phone but carries an address it alone knows still earns
    // its place — the redundant phone LINE is suppressed below instead of the whole entry.
    const duplicatesTopLevel = samePhone && (addsNothingNew || (topLevelAddress && o.address === topLevelAddress));
    return !duplicatesTopLevel;
  });
  if (!extra.length) return null;
  return (
    <div className="offices-list">
      <span className="offices-label">Other offices</span>
      <ul>
        {extra.map((o, i) => (
          <li key={i} className="office-entry">
            <strong>{o.name || o.city || labelForClassification(o.classification)}</strong>
            {o.address && <span className="office-address">{o.address}</span>}
            {/* Observed on Gina Hinojosa: her Capitol Office restated her only phone number a
                few lines under the Call button that already showed it. The address here is
                genuinely new, the phone is not. */}
            {o.phone && o.phone !== topLevelPhone && <a href={`tel:${o.phone}`}>{o.phone}</a>}
            {o.hours && <span className="office-hours">{o.hours}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// term_end/committees/bio only ever come from public/federal-details.json (federal reps), so
// these are always empty/absent for state and local reps — every render below is conditional.
// Handles both a bare date (term_end, "2029-01-03" — normalized to UTC midnight so it doesn't
// shift a day depending on the viewer's timezone) and a full timestamp (verifiedAt, already
// carrying its own time/zone, e.g. "2026-08-18T18:11:02.875Z") without double-appending one.
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : `${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Below this, a local-officials record (see scraper/src/extract.js's "confidence" prompt field)
// is flagged as worth double-checking rather than shown as a bare, potentially misleading
// number — most extractions land at 1 (or close to it); this only catches real outliers.
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

export function CommitteesList({ committees }) {
  if (!committees?.length) return null;
  return (
    <div className="rep-committees">
      <span className="offices-label">Committees</span>
      <ul>
        {committees.map((c) => (
          <li key={c.id}>{c.name}{c.role && ` — ${c.role}`}</li>
        ))}
      </ul>
    </div>
  );
}

// Displaying a raw href is how Gina Hinojosa's page ended up with a 62-character OpenStates
// database URL as its single most visually dominant element, out-shouting her phone number.
// Callers show this instead, under an "Official website" label.
export function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// Same "StateUpper"/"StateLower" -> readable chamber name substitution RepProfile.js uses for
// its hero heading — kept here too since the short card's one-line area/district row needs it.
export function areaLabel(rep) {
  return rep.area.replace('StateUpper', `${rep.state} Senate`).replace('StateLower', `${rep.state} House`);
}

// Short, scannable results-list card. Everything else (email, address, hours, website, socials,
// term, bio, committees, other offices, verification/source) lives on the full profile page —
// see RepProfile.js — reachable via the "View full profile" link below. `rep` is passed through
// router state (see that Link's `state` prop) rather than looked up again: this app has no
// id-addressable store for federal/state reps, only the results already in memory from this
// search (a deliberate v1 scope decision — see the plan's "same-session only" note).
export default function RepCard({ rep }) {
  // Local officials get a readable, crawlable slug URL (/rep/tx/austin/mayor/jane-doe) that a
  // cold visit can resolve back to the record and the build prerenders (see src/officials.js and
  // scripts/prerender-officials.js). Federal/state reps have no id-addressable store, so their
  // ids don't slugify — those keep the opaque, same-session-only encoded-id URL.
  const slug = slugFromId(rep.id);
  const profilePath = slug ? `/rep/${slug}` : `/rep/${encodeURIComponent(rep.id)}`;
  return (
    <section className={`rep-card ${rep.area.toLowerCase().replace(/ /g, "-")}`}>
      {/* The photo is a second route into the same profile — clicking a person's face is the
          obvious gesture, and a card-sized image is a far bigger target than the text link.
          aria-hidden + tabIndex={-1} because it is purely redundant with the "View full profile"
          link below: without this, every card would announce twice and cost keyboard users an
          extra tab stop to reach the same destination. Nothing is lost by hiding it — the alt
          text only repeats the <h2> directly beneath it. */}
      <Link to={profilePath} state={{ rep }} className="rep-card-photo" aria-hidden="true" tabIndex={-1}>
        <img src={!rep.photoURL ? "../generic-profile.jpg" : rep.photoURL} alt={rep.name} />
      </Link>
      <div>
        <h2>{rep.name}</h2>
        <ul>
          <li>
            {areaLabel(rep)}
            {rep.district && ` — ${rep.district}`}
          </li>
          {rep.party && <li className="rep-party">{rep.party}</li>}
          {rep.body && <li className="rep-body">{rep.body}</li>}
          {rep.phone && <li><a href={`tel:${rep.phone}`}>{rep.phone}</a></li>}
          {rep.confidence != null && rep.confidence < LOW_CONFIDENCE_THRESHOLD && (
            <li className="rep-low-confidence">⚠ Extracted with lower confidence — double-check before relying on this.</li>
          )}
          <li className="rep-profile-link">
            <Link to={profilePath} state={{ rep }}>View full profile →</Link>
          </li>
        </ul>
      </div>
    </section>
  );
}
