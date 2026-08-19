import React, { useState } from 'react';
import axios from 'axios';

import { geocode, normalizePlace } from './geocode';
import { toStateRepCards, mergeStateLegislators } from './stateLegislators';
// import logo from './logo.svg';
import './App.css';

const apiKey = "16d983f13d34f95039958108";

function App() {
  const [repList, setRepList] = useState(null);

  return (
    <div className="App">
      <main>
        <h1 className='hero-title'>Who Reps Me?</h1>
        <h2 className='hero-subtitle'>An application to find your representatives</h2>
        <SearchBar apiKey={apiKey} setRepList={setRepList} />
        <Results repList={repList} />
      </main>
    </div>
  );
}
export default App;

// 'idle' -> 'searching' (normal fetch, usually well under a second) -> possibly 'scraping'
// (this search fell through to a live on-demand scrape that's taking a while — see
// scrapeLocalOfficials()'s SLOW_THRESHOLD_MS) -> back to 'idle'.
function SearchBar({ apiKey, setRepList }) {
  const [location, setLocation] = useState('');
  const [status, setStatus] = useState('idle');
  // What the on-demand scrape actually concluded, once a search that used it finishes — null
  // means either no on-demand scrape happened (shard hit) or it found officials (self-evident
  // from the rendered cards, no note needed). Cleared at the start of every new search so a
  // note from a previous city never lingers onto this one.
  const [scrapeNote, setScrapeNote] = useState(null);
  const loading = status !== 'idle';

  const handleChange = (event) => {
    setLocation(event.target.value);
  };

  const executeSearch = async () => {
    if (!location.trim() || loading) return;
    setStatus('searching');
    setScrapeNote(null);
    try {
      // Geocode first (authoritative city/county/state + the coordinates the state-legislator
      // lookup needs), then fetch federal reps (5calls), our per-state officials shard, the
      // federal social-links shard, and the state legislators in parallel.
      const geo = await geocode(location);
      const [fedState, shard, federalSocial, federalDetails, stateCards] = await Promise.all([
        getRepList(apiKey, location),
        getOfficialsShard(geo?.state),
        getFederalSocial(),
        getFederalDetails(),
        getStateLegislators(geo),
      ]);
      // A shard miss falls through to a live on-demand scrape (netlify/functions/
      // local-officials.mjs) — onSlowScrape flips the status once that's taking noticeably
      // longer than a normal search, so the UI can say why instead of leaving the user staring
      // at a generic "Searching…" for up to 30 seconds.
      const locals = await getLocalOfficials(geo, shard, {
        onSlowScrape: () => setStatus('scraping'),
        onScrapeResult: (result) => setScrapeNote(localScrapeNote(result)),
      });

      // Merge into one list so Results renders every level uniformly. Local officials go
      // first so city-level reps are visible without scrolling past federal/state.
      //
      // mergeStateLegislators runs LAST so it can drop 5calls' state entries in favour of the
      // Open States ones — but only when Open States actually returned some, so a missing key
      // or an uncovered state leaves the previous behaviour untouched.
      const withSocial = mergeFederalSocial(fedState?.representatives || [], { federalSocial, federalDetails });
      const representatives = [...locals, ...mergeStateLegislators(withSocial, stateCards)];
      setRepList({ ...(fedState || {}), representatives, geo });
    } catch (error) {
      console.error('Search failed:', error);
      setRepList(null);
    } finally {
      setStatus('idle');
    }
  }

  return (
    <div className='search-bar'>
      <input
        type="text"
        className="search"
        value={location}
        onChange={handleChange}
        onKeyDown={(e) => e.key === 'Enter' && executeSearch()}
        placeholder="Enter your address or zip code"
      />
      <button
        className='button-cta'
        onClick={executeSearch}
        disabled={loading}
      >
        <span className="text">{status === 'scraping' ? 'Gathering local data…' : loading ? 'Searching…' : 'Search'}</span>
      </button>
      {status === 'scraping' && (
        <p className="scrape-status" aria-live="polite">
          <span className="scrape-status-dot" aria-hidden="true" />
          You're the first to search this area — actively gathering local officials data.
          This can take up to 30 seconds.
        </p>
      )}
      {status === 'idle' && scrapeNote && (
        <p className="scrape-note" aria-live="polite">{scrapeNote}</p>
      )}
    </div>
  );
}

// Turns an on-demand scrape's outcome into a message worth showing the user — or null when
// there's nothing worth saying (officials were found; the rendered cards already say so).
// Exported so it's independently testable (see App.test.js) rather than only covered by
// rendering the whole SearchBar.
export function localScrapeNote({ city, found, error, source }) {
  if (found) return null;
  if (error) return `Couldn't check ${city} for local officials right now (${error}). Try again in a bit.`;
  if (source === 'cache-miss') {
    return `No local officials found for ${city} in our last check — this is retried automatically within the week.`;
  }
  return `No local officials found for ${city} yet.`;
}

async function getRepList(apiKey, location) {
  try {
    // add in package.json -> "proxy": "https://api.5calls.org",
    // encodeURIComponent, not raw interpolation: an address containing '&' or '#' would
    // otherwise truncate the query string and silently geocode the wrong place.
    const response = await axios.get(`/v1/representatives?location=${encodeURIComponent(location)}`, {
      headers: {
        'X-5Calls-Token': apiKey,
        'Content-Type': 'application/json',
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching data:', error);
  }
}

// Map a scraped official record (static shard or on-demand response — same shape, see
// scraper/src/normalize.js) into the card shape the 5calls reps use.
function toRepCard(o, state) {
  return {
    id: o.id,
    name: o.name,
    area: o.office || o.body || 'Local',
    state,
    phone: o.phone || '',
    url: o.url || '',
    photoURL: o.photo_url || '',
    email: o.email || '',
    district: o.district || '',
    address: o.address || '',
    social: o.social || {},
    offices: o.offices || [],
    isLocal: true,
  };
}

// Maps 5calls' field_offices (phone + city, no street address) onto the shared cross-tier
// office shape (see scraper/src/normalize.js's normalizeOffices() for the same shape used by
// the scraper and state legislators). Still worth surfacing phone+city even without an
// address — strictly better than not rendering field_offices at all, which is what happened
// before this (5calls already returns it on every federal rep, see src/response.json).
export function officesFromFieldOffices(fieldOffices) {
  return (fieldOffices || []).map((fo) => ({
    classification: 'district',
    name: null,
    city: fo.city || null,
    address: null,
    phone: fo.phone || null,
    fax: null,
    hours: null,
  }));
}

// Combines offices from multiple sources for the same rep (5calls' field_offices-derived list
// + public/federal-details.json's dc_office/district_offices) into one list, deduping an office
// that's clearly the same physical one reported by two sources — matched on city+phone, per the
// plan's "same office shouldn't render twice across sources" rule — by keeping whichever
// occurrence has an address (5calls never has one; the crowdsourced federal-details shard
// usually does), so a district office named by both sources shows once, with the fuller data.
export function mergeOffices(...lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const office of list || []) {
      const key = `${(office.city || '').toLowerCase()}|${office.phone || ''}`;
      const existing = byKey.get(key);
      if (!existing || (!existing.address && office.address)) byKey.set(key, office);
    }
  }
  return [...byKey.values()];
}

// Fetch the per-state officials shard once so it can be passed to local-officials matching
// without getLocalOfficials re-fetching the same file.
async function getOfficialsShard(state) {
  if (!state) return null;
  try {
    const res = await fetch(`${process.env.PUBLIC_URL}/officials/${state}.json`);
    if (res.ok) return await res.json();
  } catch (error) {
    console.error('Error fetching officials shard:', error);
  }
  return null;
}

// public/federal-social.json is built by scraper/src/federal-social.js from the public
// unitedstates/congress-legislators project, keyed by bioguide id — which is exactly what
// 5calls uses as `id` for House/Senate members, so this is a direct lookup, no fuzzy
// matching. Missing/unreachable file just means no social links get merged in.
async function getFederalSocial() {
  try {
    const res = await fetch(`${process.env.PUBLIC_URL}/federal-social.json`);
    if (res.ok) {
      const data = await res.json();
      return data.legislators || {};
    }
  } catch (error) {
    console.error('Error fetching federal social links:', error);
  }
  return {};
}

// public/federal-details.json is built by scraper/src/federal-details.js from the public
// unitedstates/congress-legislators project (term dates, committees, DC office, crowdsourced
// district offices) plus a Wikipedia bio blurb — keyed by bioguide id, same key
// federal-social.json and 5calls both use. Missing/unreachable file just means these fields
// stay empty, same fail-soft posture as getFederalSocial().
async function getFederalDetails() {
  try {
    const res = await fetch(`${process.env.PUBLIC_URL}/federal-details.json`);
    if (res.ok) {
      const data = await res.json();
      return data.legislators || {};
    }
  } catch (error) {
    console.error('Error fetching federal details:', error);
  }
  return {};
}

// Merge social links, term/committee/bio details, and offices onto 5calls' own representative
// records (they're used as-is elsewhere, not passed through toRepCard), matched by bioguide id
// against federalSocial/federalDetails. Only Congress needs this: state legislators come from
// Open States, which supplies their links/offices directly — see src/stateLegislators.js.
export function mergeFederalSocial(representatives, { federalSocial, federalDetails }) {
  return representatives.map((rep) => {
    if (rep.area !== 'US House' && rep.area !== 'US Senate') return rep;
    const social = federalSocial?.[rep.id];
    const details = federalDetails?.[rep.id];
    const offices = mergeOffices(
      officesFromFieldOffices(rep.field_offices),
      details?.district_offices,
      details?.dc_office ? [details.dc_office] : []
    );
    return {
      ...rep,
      ...(social ? { social } : {}),
      offices,
      term_end: details?.term_end || null,
      committees: details?.committees || [],
      bio: details?.bio || null,
    };
  });
}

// Ask our Netlify function for the state legislators at these coordinates (Open States v3,
// key held server-side — see netlify/functions/state-legislators.mjs). This is a precise
// point-in-polygon lookup, unlike 5calls' internal geocoding of the raw search string, which
// is why it recovers the state reps that go missing on ZIP-only searches.
//
// Fails soft to an empty list in every failure mode: mergeStateLegislators treats that as
// "keep whatever 5calls gave us", so state results can only get better here, never worse.
async function getStateLegislators(geo) {
  // Coerce rather than trusting the type: geocode()'s two paths build coordinates differently
  // (the ZIP fallback parses strings from zippopotam), so a bare Number.isFinite check on the
  // raw value would silently skip the lookup if either ever hands back a numeric string.
  const lat = Number(geo?.lat);
  const lon = Number(geo?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  try {
    const res = await fetch(`/api/state-legislators?lat=${lat}&lon=${lon}`);
    if (!res.ok) return [];
    const data = await res.json();
    return toStateRepCards(data.results, geo.state);
  } catch (error) {
    console.error('State legislator lookup failed:', error);
    return [];
  }
}

// How long a shard-miss request runs before we tell the user it's a genuinely slow live scrape,
// not just a normal fetch. A shard miss can resolve two very different ways server-side —
// netlify/functions/local-officials.mjs's own `source` field distinguishes them in the
// response — but the client can't know which one it's getting until the response arrives, so
// this waits a beat rather than assuming the worst up front:
//   - Netlify Blobs cache hit (someone already triggered discovery for this city): fast,
//     comparable to a normal search.
//   - genuine live scrape (nobody has searched this city before): can take up to ~30s.
const SLOW_SCRAPE_THRESHOLD_MS = 1500;

// Ask the on-demand scraper (Netlify function) to find and scrape this jurisdiction, since the
// committed static shard has nothing for it. First time this city is searched it's slow (a
// live scrape); the function saves the result so every search after that is a cache hit. Fails
// soft to an empty list — an uncovered city should never break federal/state results — but
// `onScrapeResult` (if given) is always called with what actually happened, since a silent []
// makes "we haven't found anything for you yet" indistinguishable from "the scraper is broken",
// which is exactly the confusion this exists to resolve: the Netlify function (see its own
// header comment) already computes a real `error`/`source` on every non-empty-officials outcome,
// this just stops discarding it.
async function scrapeLocalOfficials(geo, { onSlowScrape, onScrapeResult } = {}) {
  const city = geo.place || (geo.county ? `${geo.county} County` : null);
  if (!city) return [];
  const level = geo.place ? 'local' : 'county';

  const slowTimer = setTimeout(() => onSlowScrape?.(), SLOW_SCRAPE_THRESHOLD_MS);

  // Just under Netlify's own ~30s function ceiling (confirmed directly: a cold on-demand scrape
  // that needs several candidate pages gets a 502 from Netlify itself right around 30s) — no
  // point aborting client-side well before the server would anyway. The server keeps working
  // and caches the result even if this abort does fire, so a premature abort just costs the
  // user a second search rather than losing the work.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 28000);
  try {
    const res = await fetch('/api/local-officials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: geo.state, city, level }),
      signal: controller.signal,
    });
    if (!res.ok) {
      onScrapeResult?.({ city, found: false, error: `Server error (HTTP ${res.status})` });
      return [];
    }
    const data = await res.json();
    const officials = (data.officials || []).map((o) => toRepCard(o, geo.state));
    onScrapeResult?.({ city, found: officials.length > 0, error: data.error || null, source: data.source });
    return officials;
  } catch (error) {
    const message = error.name === 'AbortError' ? 'Timed out' : error.message;
    console.error('On-demand local scrape failed:', error);
    onScrapeResult?.({ city, found: false, error: message });
    return [];
  } finally {
    clearTimeout(timer);
    clearTimeout(slowTimer);
  }
}

// Return the local officials matching the geocoded place (or county) from an already-fetched
// officials shard (see getOfficialsShard). If the shard has nothing for this jurisdiction,
// fall back to scraping it on demand (and saving the result) instead of just showing nothing.
// Fails soft to an empty list so the app still shows federal/state reps if the shard is
// missing or no match.
export async function getLocalOfficials(geo, shard, { onSlowScrape, onScrapeResult } = {}) {
  if (!geo?.state) return [];

  const wantPlace = normalizePlace(geo.place);
  const wantCounty = normalizePlace(geo.county);

  const shardMatches = (shard?.officials || []).filter((o) => {
    // Match by level, not by name alone: normalizePlace strips the "County" suffix, so a
    // county and a like-named city collide ("Bastrop County" and the city of Bastrop both
    // reduce to "bastrop"). Without this an Elgin resident would be shown Bastrop's mayor.
    // Any other level is ignored — the shard holds only local and county records.
    const name = normalizePlace(o.jurisdiction?.city);
    if (o.level === 'county') return Boolean(wantCounty) && name === wantCounty;
    if (o.level === 'local') return Boolean(wantPlace) && name === wantPlace;
    return false;
  });

  if (shardMatches.length) return shardMatches.map((o) => toRepCard(o, geo.state));

  // Nothing in the pre-scraped shard for this place — check the on-demand cache / scrape it.
  return scrapeLocalOfficials(geo, { onSlowScrape, onScrapeResult });
}

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

function SocialLinks({ social }) {
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
function OfficesList({ offices, topLevelPhone }) {
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
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function CommitteesList({ committees }) {
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

function Results({ repList }) {
  return (
    <section className="results">
      {/* <pre>{JSON.stringify(repList, null, 2)}</pre> */}
      {repList?.representatives?.map((rep) => (
        <section key={rep.id} className={`rep-card ${rep.area.toLowerCase().replace(/ /g, "-")}`}>


          <img src={!rep.photoURL ? "../generic-profile.jpg" : rep.photoURL} alt={rep.name} />
          <div>
            <h2>{rep.name}</h2>
            <ul>
              <li>
                {rep.area.replace("StateUpper", `${rep.state} Senate`).replace("StateLower", `${rep.state} House`)}
                {rep.district && ` — ${rep.district}`}
              </li>
              {rep.phone && <li><a href={`tel:${rep.phone}`}>{rep.phone}</a></li>}
              {rep.email && <li><a href={`mailto:${rep.email}`}>{rep.email}</a></li>}
              {rep.address && <li className="rep-address">{rep.address}</li>}
              {rep.url && <li><a href={`${rep.url}`}>{rep.url}</a></li>}
              <SocialLinks social={rep.social} />
              {rep.term_end && <li className="rep-term">Term ends {formatDate(rep.term_end)}</li>}
              {rep.bio && <li className="rep-bio">{rep.bio}</li>}
              <CommitteesList committees={rep.committees} />
              <OfficesList offices={rep.offices} topLevelPhone={rep.phone} />
            </ul>
          </div>

        </section>
      ))}
    </section>
  );
}
