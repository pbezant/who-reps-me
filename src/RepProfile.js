import { Link, useLocation, useParams } from 'react-router-dom';

import {
  SocialPanel,
  OfficesList,
  CommitteesList,
  formatDate,
  hostname,
  LOW_CONFIDENCE_THRESHOLD,
  areaLabel,
} from './RepCard';
import RepNews from './RepNews';
import RepVotingRecord from './RepVotingRecord';

// Full detail page for one representative, reached via RepCard's "View full profile" link
// (`/rep/:id`, rep object handed through router `state` — see that Link in RepCard.js).
//
// v1 is deliberately same-session only: a cold visit (hard refresh, a bookmarked or shared
// link) has no `state.rep` to render, since federal/state reps have no static, id-addressable
// source to re-fetch from today (only local officials do, via the committed per-state shards).
// Building that lookup is out of scope for this iteration — see the plan's "Deep links" note —
// so a cold visit gets a small, honest fallback instead of a crash or an infinite spinner.
//
// LAYOUT: this used to be one flat <ul> holding every field a rep could have, which gave a
// phone number you might actually want to call exactly the same visual weight as a "Verified
// Aug 18, 2026" provenance footnote. It is now grouped into panels ordered act -> understand
// -> verify: Contact first (the app exists to help people contact their reps), then socials,
// then the explanatory material, with provenance demoted to a page footer.

const ICON_PHONE = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.7 2z" />
  </svg>
);

const ICON_MAIL = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M22 6l-10 7L2 6" />
  </svg>
);

const ICON_EXTERNAL = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <path d="M15 3h6v6M10 14L21 3" />
  </svg>
);

// One contact action: a label saying what it is, and the value in the size that says "this is
// the thing to press". The label matters — a bare "202-225-3864" never told anyone it was a
// phone number, it just looked like a line of underlined text identical to the URL beneath it.
function ContactAction({ href, icon, label, value, variant, external }) {
  const externalProps = external ? { target: '_blank', rel: 'noreferrer noopener' } : {};
  return (
    <a className={`rep-action rep-action--${variant}`} href={href} {...externalProps}>
      <span className="rep-action-icon">{icon}</span>
      <span className="rep-action-text">
        <span className="rep-action-label">{label}</span>
        <span className="rep-action-value">{value}</span>
      </span>
    </a>
  );
}

export default function RepProfile() {
  const { id } = useParams();
  const { state } = useLocation();
  const rep = state?.rep;

  if (!rep) {
    return (
      <section className="rep-profile-missing">
        <p>We don't have this representative's info handy right now.</p>
        <p>This page only works when you click through from a search result.</p>
        <Link to="/">Go back and search again</Link>
      </section>
    );
  }

  // Sanity check only, never authoritative — state.rep is what actually renders. Mismatches
  // here would mean a stale Link somewhere, not a real data problem worth surfacing to a user.
  if (decodeURIComponent(id) !== String(rep.id)) {
    console.warn('RepProfile: route id does not match the rep in router state', { id, repId: rep.id });
  }

  const hasContact = Boolean(rep.phone || rep.email || rep.url || rep.address);
  // Drives both whether the About panel renders at all and, on desktop, whether Contact widens
  // to take the space it would have occupied — most local officials have none of this.
  const hasAbout = Boolean(rep.bio || rep.term_end || rep.committees?.length || rep.offices?.length);
  // Drives the desktop grid only: with no socials to place, Contact widens to fill the top row
  // rather than leaving a hole beside the portrait. See App.css's .rep-profile--nosocial.
  const hasSocial = Boolean(rep.social && Object.values(rep.social).some(Boolean));
  const lowConfidence = rep.confidence != null && rep.confidence < LOW_CONFIDENCE_THRESHOLD;

  return (
    <section className={`rep-profile${hasSocial ? '' : ' rep-profile--nosocial'}`}>
      <Link to="/" className="rep-profile-back">← Back to search</Link>

      <div className={`rep-profile-hero ${rep.area.toLowerCase().replace(/ /g, "-")}`}>
        <img src={!rep.photoURL ? "../generic-profile.jpg" : rep.photoURL} alt={rep.name} />
        <div>
          <h1>{rep.name}</h1>
          <p className="rep-profile-office">
            {areaLabel(rep)}
            {rep.district && ` — ${rep.district}`}
          </p>
          {rep.party && <p className="rep-party">{rep.party}</p>}
          {rep.body && <p className="rep-body">{rep.body}</p>}
        </div>
      </div>

      {/* A safety signal, not provenance: this says "we may have got this wrong", so it stays up
          top where it's read before the contact details, rather than in the footer with the
          verified date. */}
      {lowConfidence && (
        <p className="rep-confidence-banner">⚠ Extracted with lower confidence — double-check before relying on this.</p>
      )}

      <section className="rep-panel rep-profile-contact">
        <h2 className="rep-panel-title">Contact</h2>
        {rep.phone && (
          <ContactAction href={`tel:${rep.phone}`} icon={ICON_PHONE} label="Call this office" value={rep.phone} variant="primary" />
        )}
        {rep.email && (
          <ContactAction href={`mailto:${rep.email}`} icon={ICON_MAIL} label="Email" value={rep.email} variant="secondary" />
        )}
        {rep.url && (
          <ContactAction href={rep.url} icon={ICON_EXTERNAL} label="Official website" value={hostname(rep.url)} variant="tertiary" external />
        )}
        {rep.address && (
          <div className="rep-field">
            <span className="rep-field-label">Office</span>
            <p className="rep-field-value">{rep.address}</p>
            {rep.hours && <p className="rep-field-note">{rep.hours}</p>}
          </div>
        )}
        {/* An honest answer beats an empty panel. Before this, a rep with no contact details on
            file rendered a large blank box holding nothing but a greyed-out "Verified" line. */}
        {!hasContact && (
          <p className="rep-empty">
            We don't have contact details for this office yet.
            {rep.sourceUrl && (
              <> <a href={rep.sourceUrl} target="_blank" rel="noreferrer noopener">Check the official page →</a></>
            )}
          </p>
        )}
      </section>

      <SocialPanel social={rep.social} />

      {hasAbout && (
        <section className="rep-panel rep-profile-about">
          <h2 className="rep-panel-title">About this office</h2>
          {rep.bio && <p className="rep-bio">{rep.bio}</p>}
          {rep.term_end && <p className="rep-term">Term ends {formatDate(rep.term_end)}</p>}
          <CommitteesList committees={rep.committees} />
          <OfficesList offices={rep.offices} topLevelPhone={rep.phone} topLevelAddress={rep.address} />
        </section>
      )}

      <RepNews rep={rep} />
      <RepVotingRecord rep={rep} />

      {rep.verifiedAt && (
        <p className="rep-provenance">
          Verified {formatDate(rep.verifiedAt)}
          {rep.sourceUrl && (
            <> · <a href={rep.sourceUrl} target="_blank" rel="noreferrer noopener">source</a></>
          )}
        </p>
      )}
    </section>
  );
}
