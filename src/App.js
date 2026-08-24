import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Routes, Route } from 'react-router-dom';

import { geocode, normalizePlace } from './geocode';
import { toStateRepCards, mergeStateLegislators } from './stateLegislators';
import { toStateExecutiveCards, mergeStateExecutives } from './stateExecutives';
import ReportBug from './ReportBug';
import RepCard from './RepCard';
import RepProfile from './RepProfile';
// import logo from './logo.svg';
import './App.css';

const apiKey = "16d983f13d34f95039958108";

function App() {
  const [repList, setRepList] = useState(null);

  return (
    <div className="App">
      <Routes>
        <Route path="/" element={<HomePage repList={repList} setRepList={setRepList} />} />
        {/* Same-session only (see RepProfile.js's own header comment): reached by clicking
            "View full profile" on a card from repList above, which hands the clicked rep's
            data along via router state. A cold visit — refresh, a shared link, typing the URL —
            has no repList to draw from, so RepProfile shows a "go back and search again"
            fallback instead of attempting a fresh id→rep lookup that doesn't exist yet for
            federal/state tiers. */}
        <Route path="/rep/:id" element={<RepProfile />} />
      </Routes>
      {/* Always available, unlike the officials-suggestion button it replaced — a bug can
          happen before a search ever completes. See ReportBug.js's own header comment. */}
      <ReportBug repList={repList} />
    </div>
  );
}
export default App;

// The search page: hero title, address search bar, and results. This used to be App's whole
// always-rendered tree before /rep/:id needed a second route to live alongside it (see App()
// above) — pulled out unchanged so Routes/Route stays the only thing App() itself renders.
function HomePage({ repList, setRepList }) {
  return (
    <main>
      <h1 className='hero-title'>Who Reps Me?</h1>
      <h2 className='hero-subtitle'>An application to find your representatives</h2>
      <SearchBar apiKey={apiKey} setRepList={setRepList} />
      <Results repList={repList} />
    </main>
  );
}

// Free, keyless address-suggestion API (Komoot's public Photon instance, built on
// OpenStreetMap data). It's a shared demo server — no SLA, rate-limited — which is fine for
// a low-traffic personal project but worth knowing if this ever gets busy.
const PHOTON_URL = 'https://photon.komoot.io/api/';
const MIN_SUGGEST_CHARS = 3;
const SUGGEST_DEBOUNCE_MS = 300;

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
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const containerRef = useRef(null);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);

  // Close the suggestion dropdown on outside click, and clean up in-flight
  // timers/requests when the component unmounts.
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const fetchSuggestions = (value) => {
    clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();

    if (value.trim().length < MIN_SUGGEST_CHARS) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        // Ask for more than we'll show — Photon is a global index, so a plain place name
        // often ranks non-US matches first; over-fetch and filter down to US results below.
        const res = await fetch(
          `${PHOTON_URL}?q=${encodeURIComponent(value)}&limit=10&lang=en`,
          { signal: controller.signal }
        );
        if (!res.ok) return;
        const data = await res.json();
        const results = (data.features || [])
          .filter((f) => {
            const { countrycode, country } = f.properties || {};
            if (countrycode) return countrycode === 'US';
            if (country) return country === 'United States';
            return true;
          })
          .map((f) => formatAddress(f.properties))
          .filter(Boolean);
        // Multiple POIs (e.g. separate venues in one building) can share an address, which
        // formatAddress collapses to the same string — de-dupe before capping the list.
        const deduped = [...new Set(results)].slice(0, 5);
        setSuggestions(deduped);
        setShowSuggestions(deduped.length > 0);
        setHighlightIndex(-1);
      } catch (error) {
        if (error.name !== 'AbortError') console.error('Address suggestion lookup failed:', error);
      }
    }, SUGGEST_DEBOUNCE_MS);
  };

  const handleChange = (event) => {
    const value = event.target.value;
    setLocation(value);
    fetchSuggestions(value);
  };

  const selectSuggestion = (label) => {
    setSuggestions([]);
    setShowSuggestions(false);
    setLocation(label);
    executeSearch(label);
  };

  const executeSearch = async (overrideLocation) => {
    const query = (overrideLocation ?? location).trim();
    if (!query || loading) return;
    setShowSuggestions(false);
    setStatus('searching');
    setScrapeNote(null);
    try {
      // Geocode first (authoritative city/county/state + the coordinates the state-legislator
      // lookup needs), then fetch federal reps (5calls), our per-state officials shard, the
      // federal social-links shard, and the state legislators in parallel.
      const geo = await geocode(query);
      const [fedState, shard, federalSocial, federalDetails, stateCards, executiveCards] = await Promise.all([
        getRepList(apiKey, query),
        getOfficialsShard(geo?.state),
        getFederalSocial(),
        getFederalDetails(),
        getStateLegislators(geo),
        getStateExecutives(geo?.state),
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
      // mergeStateLegislators runs before mergeStateExecutives so it can drop 5calls' state
      // entries in favour of the Open States ones — but only when Open States actually returned
      // some, so a missing key or an uncovered state leaves the previous behaviour untouched.
      // mergeStateExecutives then appends Governor/AG/etc — pure addition, since 5calls never
      // returns state executives at all (see that function's own header comment).
      const withSocial = mergeFederalSocial(fedState?.representatives || [], { federalSocial, federalDetails });
      const withState = mergeStateLegislators(withSocial, stateCards);
      const representatives = [...locals, ...mergeStateExecutives(withState, executiveCards)];
      setRepList({ ...(fedState || {}), representatives, geo });
    } catch (error) {
      console.error('Search failed:', error);
      setRepList(null);
    } finally {
      setStatus('idle');
    }
  }

  // Arrow keys move through suggestions; Escape closes the list. Enter is handled directly
  // here (rather than left to the browser's implicit submit-on-Enter) so it reliably fires
  // the search — with or without a highlighted suggestion — across browsers.
  const handleKeyDown = (e) => {
    if (showSuggestions && suggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Escape') {
        setShowSuggestions(false);
        return;
      }
      if (e.key === 'Enter' && highlightIndex >= 0) {
        e.preventDefault();
        selectSuggestion(suggestions[highlightIndex]);
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      executeSearch();
    }
  };

  return (
    <div className='search-bar' ref={containerRef}>
      <div className="search-input-wrap">
        <input
          type="text"
          className="search"
          name="address"
          value={location}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => suggestions.length && setShowSuggestions(true)}
          placeholder="Enter your address or zip code"
          // "street-address" lets the browser's own saved-address autofill offer to fill
          // this field, alongside the live Photon suggestions below.
          autoComplete="street-address"
          role="combobox"
          aria-expanded={showSuggestions}
          aria-autocomplete="list"
          aria-controls="address-suggestions-list"
        />
        {showSuggestions && (
          <ul className="address-suggestions" role="listbox" id="address-suggestions-list">
            {suggestions.map((label, i) => (
              <li
                key={`${label}-${i}`}
                role="option"
                aria-selected={i === highlightIndex}
                className={i === highlightIndex ? 'active' : ''}
                onMouseDown={(e) => { e.preventDefault(); selectSuggestion(label); }}
                onMouseEnter={() => setHighlightIndex(i)}
              >
                {label}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        className='button-cta'
        onClick={() => executeSearch()}
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

// Build a human-readable address string from a Photon feature's properties.
function formatAddress(props) {
  const parts = [];
  const line1 = [props.housenumber, props.street].filter(Boolean).join(' ');
  if (line1) parts.push(line1);
  else if (props.name) parts.push(props.name);
  if (props.city) parts.push(props.city);
  else if (props.county) parts.push(props.county);
  if (props.state) parts.push(props.state);
  if (props.postcode) parts.push(props.postcode);
  return parts.join(', ');
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
export function toRepCard(o, state) {
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
    // Governing body (e.g. "Austin City Council"), for context alongside the office title.
    // Only surfaced when `office` is present — when it's absent, `area` above already fell
    // back to `body` itself, so repeating it here would just show the same text twice.
    body: o.office ? (o.body || '') : '',
    // hours/bio are only ever populated by the bio-page follow-up pass (see normalize.js) — a
    // roster-page-only record always has both null.
    hours: o.hours || '',
    bio: o.bio || '',
    // Provenance: when this record was last (re)confirmed, and the page it came from — lets
    // the frontend show a "verified on" date instead of presenting scraped data as evergreen.
    // See normalize.js's own header comment for the same intent.
    verifiedAt: o.extracted_at || null,
    sourceUrl: o.source_url || '',
    // LLM self-reported extraction confidence, 0-1 (local officials only — state/federal come
    // from structured APIs, not extraction). Not shown as a raw number; used to flag a record
    // worth double-checking instead.
    confidence: typeof o.confidence === 'number' ? o.confidence : null,
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

// Ask our Netlify function for a state's executive officials (Open States v3, key held
// server-side — see netlify/functions/state-executives.mjs). Unlike getStateLegislators this
// is keyed on the state alone, not a coordinate: every address in a state has the same Governor.
//
// Fails soft to an empty list in every failure mode: mergeStateExecutives just has nothing to
// append, so this can only ever add reps, never remove any.
async function getStateExecutives(state) {
  if (!state) return [];
  try {
    const res = await fetch(`/api/state-executives?state=${encodeURIComponent(state)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return toStateExecutiveCards(data.results, state);
  } catch (error) {
    console.error('State executive lookup failed:', error);
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

// Local officials go first (see the comment in executeSearch above for why), then federal,
// then state — each rendered as its own labeled section.
const GROUP_ORDER = ['Local', 'Federal', 'State'];

function repGroup(rep) {
  if (rep.isLocal) return 'Local';
  if (rep.area === 'US House' || rep.area === 'US Senate') return 'Federal';
  return 'State';
}

function Results({ repList }) {
  const reps = repList?.representatives;
  if (!reps?.length) return null;

  const groups = { Local: [], Federal: [], State: [] };
  reps.forEach((rep) => groups[repGroup(rep)].push(rep));

  return (
    <section className="results">
      {GROUP_ORDER.filter((name) => groups[name].length).map((name) => (
        <section key={name} className="rep-group">
          <h2 className="rep-group-heading">{name}</h2>
          <div className="rep-group-cards">
            {groups[name].map((rep) => (
              <RepCard key={rep.id} rep={rep} />
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}
