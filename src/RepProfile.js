import { Link, useLocation, useParams } from 'react-router-dom';

import { SocialLinks, OfficesList, CommitteesList, formatDate, LOW_CONFIDENCE_THRESHOLD, areaLabel } from './RepCard';
import RepNews from './RepNews';
import RepVotingRecord from './RepVotingRecord';

// Full detail page for one representative, reached via RepCard's "View full profile" link
// (`/rep/:id`, rep object handed through router `state` — see that Link in RepCard.js). This is
// everything the old monolithic RepCard used to render inline, still here, plus two new
// sections a dedicated page finally has room for: recent news (RepNews.js) and voting/
// legislative-activity record (RepVotingRecord.js).
//
// v1 is deliberately same-session only: a cold visit (hard refresh, a bookmarked or shared
// link) has no `state.rep` to render, since federal/state reps have no static, id-addressable
// source to re-fetch from today (only local officials do, via the committed per-state shards).
// Building that lookup is out of scope for this iteration — see the plan's "Deep links" note —
// so a cold visit gets a small, honest fallback instead of a crash or an infinite spinner.
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

  return (
    <section className="rep-profile">
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

      <ul className="rep-profile-details">
        {rep.phone && <li><a href={`tel:${rep.phone}`}>{rep.phone}</a></li>}
        {rep.email && <li><a href={`mailto:${rep.email}`}>{rep.email}</a></li>}
        {rep.address && <li className="rep-address">{rep.address}</li>}
        {rep.hours && <li className="rep-hours">{rep.hours}</li>}
        {rep.url && <li><a href={`${rep.url}`} target="_blank" rel="noreferrer noopener">{rep.url}</a></li>}
        <SocialLinks social={rep.social} />
        {rep.term_end && <li className="rep-term">Term ends {formatDate(rep.term_end)}</li>}
        {rep.bio && <li className="rep-bio">{rep.bio}</li>}
        <CommitteesList committees={rep.committees} />
        <OfficesList offices={rep.offices} topLevelPhone={rep.phone} />
        {rep.confidence != null && rep.confidence < LOW_CONFIDENCE_THRESHOLD && (
          <li className="rep-low-confidence">⚠ Extracted with lower confidence — double-check before relying on this.</li>
        )}
        {rep.verifiedAt && (
          <li className="rep-verified">
            Verified {formatDate(rep.verifiedAt)}
            {rep.sourceUrl && (
              <> · <a href={rep.sourceUrl} target="_blank" rel="noreferrer noopener">source</a></>
            )}
          </li>
        )}
      </ul>

      <RepNews rep={rep} />
      <RepVotingRecord rep={rep} />
    </section>
  );
}
