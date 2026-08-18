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
      // (5calls) and local officials (our static shard) in parallel.
      const geo = await geocode(location);
      const [fedState, locals] = await Promise.all([
        getRepList(apiKey, location),
        getLocalOfficials(geo),
      ]);

      // Merge into one list so Results renders every level uniformly. Local officials go
      // first so city-level reps are visible without scrolling past federal/state.
      const representatives = [
        ...locals,
        ...(fedState?.representatives || []),
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
    isLocal: true,
  };
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

// Fetch the per-state officials shard and return the local officials matching the geocoded
// place (or county). If the shard has nothing for this jurisdiction, fall back to scraping it
// on demand (and saving the result) instead of just showing nothing. Fails soft to an empty
// list so the app still shows federal/state reps if the shard is missing or no match.
async function getLocalOfficials(geo) {
  if (!geo?.state) return [];

  let shardMatches = [];
  try {
    const res = await fetch(`${process.env.PUBLIC_URL}/officials/${geo.state}.json`);
    if (res.ok) {
      const shard = await res.json();
      const wantPlace = normalizePlace(geo.place);
      const wantCounty = normalizePlace(geo.county);

      shardMatches = (shard.officials || []).filter((o) => {
        // Match by level, not by name alone: normalizePlace strips the "County" suffix, so a
        // county and a like-named city collide ("Bastrop County" and the city of Bastrop both
        // reduce to "bastrop"). Without this an Elgin resident would be shown Bastrop's mayor.
        const name = normalizePlace(o.jurisdiction?.city);
        if (o.level === 'county') return Boolean(wantCounty) && name === wantCounty;
        return Boolean(wantPlace) && name === wantPlace;
      });
    }
  } catch (error) {
    console.error('Error fetching local officials:', error);
  }

  if (shardMatches.length) return shardMatches.map((o) => toRepCard(o, geo.state));

  // Nothing in the pre-scraped shard for this place — check the on-demand cache / scrape it.
  return scrapeLocalOfficials(geo);
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
            </ul>
          </div>

        </section>
      ))}
    </section>
  );
}
