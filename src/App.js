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

// Fetch the per-state officials shard and return the local officials matching the geocoded
// place (or county), mapped into the same card shape the 5calls reps use. Fails soft to an
// empty list so the app still shows federal/state reps if the shard is missing or no match.
async function getLocalOfficials(geo) {
  if (!geo?.state) return [];
  try {
    const res = await fetch(`${process.env.PUBLIC_URL}/officials/${geo.state}.json`);
    if (!res.ok) return [];
    const shard = await res.json();

    const wantPlace = normalizePlace(geo.place);
    const wantCounty = normalizePlace(geo.county);

    return (shard.officials || [])
      .filter((o) => {
        const city = normalizePlace(o.jurisdiction?.city);
        return (wantPlace && city === wantPlace) || (wantCounty && city === wantCounty);
      })
      .map((o) => ({
        id: o.id,
        name: o.name,
        area: o.office || o.body || 'Local',
        state: geo.state,
        phone: o.phone || '',
        url: o.url || '',
        photoURL: o.photo_url || '',
        email: o.email || '',
        district: o.district || '',
        isLocal: true,
      }));
  } catch (error) {
    console.error('Error fetching local officials:', error);
    return [];
  }
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
