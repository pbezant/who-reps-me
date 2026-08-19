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

function SearchBar({ apiKey, setRepList }) {
  const [location, setLocation] = useState('');
  const [loading, setLoading] = useState(false);

  const handleChange = (event) => {
    setLocation(event.target.value);
  };

  const executeSearch = async () => {
    if (!location.trim() || loading) return;
    setLoading(true);
    try {
      // Geocode first (authoritative city/county/state + the coordinates the state-legislator
      // lookup needs), then fetch federal reps (5calls), our per-state officials shard, the
      // federal social-links shard, and the state legislators in parallel.
      const geo = await geocode(location);
      const [fedState, shard, federalSocial, stateCards] = await Promise.all([
        getRepList(apiKey, location),
        getOfficialsShard(geo?.state),
        getFederalSocial(),
        getStateLegislators(geo),
      ]);
      const locals = await getLocalOfficials(geo, shard);

      // Merge into one list so Results renders every level uniformly. Local officials go
      // first so city-level reps are visible without scrolling past federal/state.
      //
      // mergeStateLegislators runs LAST so it can drop 5calls' state entries in favour of the
      // Open States ones — but only when Open States actually returned some, so a missing key
      // or an uncovered state leaves the previous behaviour untouched.
      const withSocial = mergeFederalSocial(fedState?.representatives || [], federalSocial);
      const representatives = [...locals, ...mergeStateLegislators(withSocial, stateCards)];
      setRepList({ ...(fedState || {}), representatives, geo });
    } catch (error) {
      console.error('Search failed:', error);
      setRepList(null);
    } finally {
      setLoading(false);
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
        <span className="text">{loading ? 'Searching…' : 'Search'}</span>
      </button>
    </div>
  );
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
    social: o.social || {},
    isLocal: true,
  };
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

// Merge social links onto 5calls' own representative records (they're used as-is elsewhere,
// not passed through toRepCard), matched by bioguide id against federalSocial. Only Congress
// needs this: state legislators come from Open States, which supplies their links directly —
// see src/stateLegislators.js.
function mergeFederalSocial(representatives, federalSocial) {
  return representatives.map((rep) => {
    if (rep.area !== 'US House' && rep.area !== 'US Senate') return rep;
    const social = federalSocial?.[rep.id];
    return social ? { ...rep, social } : rep;
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

// Ask the on-demand scraper (Netlify function) to find and scrape this jurisdiction, since the
// committed static shard has nothing for it. First time this city is searched it's slow (a
// live scrape); the function saves the result so every search after that is a cache hit. Fails
// soft to an empty list — an uncovered city should never break federal/state results.
async function scrapeLocalOfficials(geo) {
  const city = geo.place || (geo.county ? `${geo.county} County` : null);
  if (!city) return [];
  const level = geo.place ? 'local' : 'county';

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
    if (!res.ok) return [];
    const data = await res.json();
    return (data.officials || []).map((o) => toRepCard(o, geo.state));
  } catch (error) {
    console.error('On-demand local scrape failed:', error);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Return the local officials matching the geocoded place (or county) from an already-fetched
// officials shard (see getOfficialsShard). If the shard has nothing for this jurisdiction,
// fall back to scraping it on demand (and saving the result) instead of just showing nothing.
// Fails soft to an empty list so the app still shows federal/state reps if the shard is
// missing or no match.
async function getLocalOfficials(geo, shard) {
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
  return scrapeLocalOfficials(geo);
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
              {rep.url && <li><a href={`${rep.url}`}>{rep.url}</a></li>}
              <SocialLinks social={rep.social} />
            </ul>
          </div>

        </section>
      ))}
    </section>
  );
}
