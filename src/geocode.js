// Address geocoding via the US Census Geocoder — free, no API key ($0).
//
// One call returns coordinates plus the administrative geographies we need to match local
// officials: Incorporated Place (city), County, and State. It also carries Congressional and
// State Legislative districts, which we keep for future use.
//
// The geocoder does NOT support CORS, but it DOES support JSONP (format=jsonp&callback=...),
// which works identically in local dev and on Netlify with no backend — sidestepping CRA's
// single-`proxy` limitation.
//
// KNOWN GAP, WORKED AROUND BELOW: the Census "onelineaddress" endpoint is an address-RANGE
// matcher — it needs an actual street address and returns zero matches for a bare ZIP code
// (confirmed: address=78640 alone -> addressMatches: []), even though the search box invites
// "address or zip code". A point-in-polygon lookup at the ZIP's centroid doesn't reliably fix
// this either: the centroid frequently falls just outside a city's real limits (verified for
// 78640, which lands in unincorporated county land with no "Incorporated Places" layer at
// all), so the fallback below uses the ZIP's USPS-associated city name instead of a strict
// boundary match — an approximation, not exact, but far better than silently showing nothing.

const GEOCODER_BASE = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";
const COORDS_BASE = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates";
const ZIP_BASE = "https://api.zippopotam.us/us";

// Minimal JSONP: inject a <script> with a one-shot global callback; resolve when the
// geocoder invokes it, reject on network error or timeout, and always clean up.
function jsonp(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const cb = `__censusGeocode_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const script = document.createElement("script");
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      delete window[cb];
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    window[cb] = (data) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error("geocoder request failed"));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("geocoder request timed out"));
    }, timeoutMs);

    script.src = `${url}${url.includes("?") ? "&" : "?"}format=jsonp&callback=${cb}`;
    document.body.appendChild(script);
  });
}

// Strip common government suffixes so scraped city names and geocoded names compare cleanly.
export function normalizePlace(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/\b(city|town|village|borough|municipality|cdp|county|parish)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function firstLayer(geographies, key) {
  const arr = geographies && geographies[key];
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}

// District layer names are vintage-specific ("116th Congressional Districts", year-prefixed
// legislative layers), so match by substring to survive Census vintage changes.
function firstLayerMatching(geographies, ...substrings) {
  if (!geographies) return null;
  const key = Object.keys(geographies).find((k) =>
    substrings.every((s) => k.toLowerCase().includes(s.toLowerCase()))
  );
  const arr = key ? geographies[key] : null;
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}

function districtsFrom(g) {
  return {
    congressional: firstLayerMatching(g, "congressional")?.BASENAME || null,
    stateUpper: firstLayerMatching(g, "legislative", "upper")?.BASENAME || null,
    stateLower: firstLayerMatching(g, "legislative", "lower")?.BASENAME || null,
  };
}

const BARE_ZIP_RE = /^\d{5}(-\d{4})?$/;

// ZIP-only fallback for when the primary address match comes up empty. Looks up the ZIP's
// USPS-associated city (zippopotam.us — free, keyless, CORS-enabled) for `place`, and the
// Census coordinates endpoint at that ZIP's centroid for the county/districts a real point
// lookup can answer reliably. Returns null on any failure so the caller just treats it as "no
// match", same as the primary path.
async function geocodeByZip(zip5) {
  let zipData;
  try {
    const res = await fetch(`${ZIP_BASE}/${zip5}`);
    if (!res.ok) return null;
    zipData = await res.json();
  } catch (err) {
    console.error("ZIP lookup failed:", err);
    return null;
  }

  const place = zipData?.places?.[0];
  if (!place) return null;
  const lat = Number(place.latitude);
  const lon = Number(place.longitude);

  const coordsUrl =
    `${COORDS_BASE}?x=${lon}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current`;
  let coordsData;
  try {
    coordsData = await jsonp(coordsUrl);
  } catch (err) {
    console.error("ZIP-centroid geography lookup failed:", err);
    coordsData = null;
  }

  const g = coordsData?.result?.geographies || {};
  const county = firstLayer(g, "Counties");

  return {
    lat,
    lon,
    state: place["state abbreviation"] || firstLayer(g, "States")?.STUSAB || null,
    county: county?.BASENAME || county?.NAME || null,
    // USPS's ZIP-associated city name, not a strict incorporated-boundary match — see the
    // module comment above for why the precise point-in-polygon approach doesn't work here.
    place: place["place name"] || null,
    districts: districtsFrom(g),
  };
}

// Returns { lat, lon, state, county, place, districts } or null if nothing could be resolved.
export async function geocode(address) {
  if (!address || !address.trim()) return null;
  const trimmed = address.trim();

  // A bare ZIP can never match the address-RANGE geocoder (see the module comment: address=78640
  // alone returns addressMatches: []), so go straight to the ZIP path. Previously this call was
  // made first and its result discarded, which cost a round trip on every ZIP search and — worse
  // — meant a jsonp reject took the fallback down with it: the `catch` below returns null, so a
  // slow or failing Census request left a bare ZIP with no coordinates at all, and therefore no
  // state legislators and no local officials.
  if (BARE_ZIP_RE.test(trimmed)) return geocodeByZip(trimmed.slice(0, 5));

  const url =
    `${GEOCODER_BASE}?address=${encodeURIComponent(trimmed)}` +
    `&benchmark=Public_AR_Current&vintage=Current_Current&returntype=geographies`;

  let data;
  try {
    data = await jsonp(url);
  } catch (err) {
    console.error("Geocoding failed:", err);
    return null;
  }

  const match = data?.result?.addressMatches?.[0];
  if (!match) return null;

  const g = match.geographies || {};
  const place = firstLayer(g, "Incorporated Places");
  const county = firstLayer(g, "Counties");

  return {
    lat: match.coordinates?.y ?? null,
    lon: match.coordinates?.x ?? null,
    // 2-letter state abbrev is most reliable from the parsed address components.
    state: match.addressComponents?.state || firstLayer(g, "States")?.STUSAB || null,
    // BASENAME is the clean form ("Travis"); NAME may append "County"/"city".
    county: county?.BASENAME || county?.NAME || null,
    place: place?.BASENAME || place?.NAME || null,
    // Kept for future ward/point-in-polygon and district features.
    districts: districtsFrom(g),
  };
}
