import { Link } from 'react-router-dom';

// Shared pieces between the results-list summary card (RepCard, below) and the full profile
// page (src/RepProfile.js) — split out of App.js so the profile page can reuse them instead of
// duplicating rendering logic. See App.js's git history for why this split happened: the old
// RepCard rendered every field a rep could have, all at once, which had become a wall of text —
// this file now owns just the short, scannable summary; RepProfile.js owns the full detail.

// Minimal inline glyphs (not literal brand marks) so a social row needs no icon-library
// dependency, consistent with the rest of this dependency-free frontend.
const SOCIAL_ICONS = {
  twitter: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M4 4l16 16M20 4L4 20" />
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
  twitter: 'Twitter/X',
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
};

export function SocialLinks({ social }) {
  const entries = Object.entries(social || {}).filter(([, url]) => url);
  if (!entries.length) return null;
  return (
    <li className="social-links">
      {entries.map(([platform, url]) => (
        <a
          key={platform}
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="social-icon"
          aria-label={SOCIAL_LABELS[platform] || platform}
        >
          {SOCIAL_ICONS[platform] || platform}
        </a>
      ))}
    </li>
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
export function OfficesList({ offices, topLevelPhone }) {
  const extra = (offices || []).filter((o) => {
    const addsNothingNew = !o.address && !o.hours && !o.fax;
    const sameAsTopLevel = topLevelPhone && o.phone === topLevelPhone;
    return !(addsNothingNew && sameAsTopLevel);
  });
  if (!extra.length) return null;
  return (
    <li className="offices-list">
      <span className="offices-label">Other offices</span>
      <ul>
        {extra.map((o, i) => (
          <li key={i} className="office-entry">
            <strong>{o.name || o.city || labelForClassification(o.classification)}</strong>
            {o.address && <span className="office-address">{o.address}</span>}
            {o.phone && <a href={`tel:${o.phone}`}>{o.phone}</a>}
            {o.hours && <span className="office-hours">{o.hours}</span>}
          </li>
        ))}
      </ul>
    </li>
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
    <li className="rep-committees">
      <span className="offices-label">Committees</span>
      <ul>
        {committees.map((c) => (
          <li key={c.id}>{c.name}{c.role && ` — ${c.role}`}</li>
        ))}
      </ul>
    </li>
  );
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
  return (
    <section className={`rep-card ${rep.area.toLowerCase().replace(/ /g, "-")}`}>
      <img src={!rep.photoURL ? "../generic-profile.jpg" : rep.photoURL} alt={rep.name} />
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
            <Link to={`/rep/${encodeURIComponent(rep.id)}`} state={{ rep }}>View full profile →</Link>
          </li>
        </ul>
      </div>
    </section>
  );
}
