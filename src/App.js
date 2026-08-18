import React, { useState } from 'react';
import axios from 'axios';

import { geocode, normalizePlace } from './geocode';
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
      // Geocode first (authoritative city/county/state), then fetch federal+state reps
      // (5calls), our per-state officials shard, and the federal social-links shard in
      // parallel. The officials shard is fetched once here (not inside getLocalOfficials)
      // so it can also supply state-legislator social links below, instead of re-fetching
      // the same file twice.
      const geo = await geocode(location);
      const [fedState, shard, federalSocial] = await Promise.all([
        getRepList(apiKey, location),
        getOfficialsShard(geo?.state),
        getFederalSocial(),
      ]);
      const locals = await getLocalOfficials(geo, shard);

      // Merge into one list so Results renders every level uniformly. Local officials go
      // first so city-level reps are visible without scrolling past federal/state.
      const representatives = [
        ...locals,
        ...mergeSocialLinks(fedState?.representatives || [], { federalSocial, shard, state: geo?.state }),
      ];
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
    const response = await axios.get(`/v1/representatives?location=${location}`, {
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

// Pull the leading run of digits out of a district value ("District 45", "HD 45", "45",
// "District 045") so scraped text and 5calls' bare-digit district ("45") can be compared
// regardless of how each source formats it.
function districtDigits(value) {
  if (!value) return null;
  const match = String(value).match(/\d+/);
  return match ? match[0].replace(/^0+(?=\d)/, '') : null;
}

function chamberForArea(area) {
  if (area === 'StateUpper') return 'state-upper';
  if (area === 'StateLower') return 'state-lower';
  return null;
}

// Find this state legislator's own record in the officials shard (scraped from the state
// chamber's roster page — see scraper/config/seeds.json), matched by (state, chamber,
// district) rather than name: 5calls gives no bio-page URL for state legislators to key
// off of, but district numbers are unique per chamber per state, so that triple is a
// reliable join key without any fuzzy name matching.
function findStateChamberRecord(shard, { chamber, state, district }) {
  const wantDistrict = districtDigits(district);
  if (!shard?.officials || !chamber || !state || !wantDistrict) return null;
  return (
    shard.officials.find(
      (o) =>
        o.level === chamber &&
        (o.jurisdiction?.state || '').toUpperCase() === state.toUpperCase() &&
        districtDigits(o.district) === wantDistrict
    ) || null
  );
}

// Fetch the per-state officials shard once so both local-officials matching and
// state-legislator social-link matching can use the same payload.
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

// Merge social links onto 5calls' own federal/state representative records (they're used
// as-is elsewhere, not passed through toRepCard). Federal reps match by bioguide id against
// federalSocial; state legislators match against the officials shard by chamber+district
// (see findStateChamberRecord). A state legislator's own scraped photo only fills in when
// 5calls didn't already give us one — 5calls is the more authoritative source for that field.
function mergeSocialLinks(representatives, { federalSocial, shard, state }) {
  return representatives.map((rep) => {
    if (rep.area === 'US House' || rep.area === 'US Senate') {
      const social = federalSocial?.[rep.id];
      return social ? { ...rep, social } : rep;
    }
    const chamber = chamberForArea(rep.area);
    if (chamber) {
      const match = findStateChamberRecord(shard, { chamber, state, district: rep.district });
      if (match) {
        return {
          ...rep,
          social: match.social,
          photoURL: rep.photoURL || match.photo_url || '',
        };
      }
    }
    return rep;
  });
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
    // State chambers (level 'state-upper'/'state-lower') are matched separately by district,
    // not by place name — see mergeSocialLinks/findStateChamberRecord — so they're excluded
    // here rather than falling through to the place-name branch.
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
