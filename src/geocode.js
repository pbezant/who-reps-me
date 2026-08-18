// Address geocoding via the US Census Geocoder — free, no API key ($0).
//
// One call returns coordinates plus the administrative geographies we need to match local
// officials: Incorporated Place (city), County, and State. It also carries Congressional and
// State Legislative districts, which we keep for future use.
//
// The geocoder does NOT support CORS, but it DOES support JSONP (format=jsonp&callback=...),
// which works identically in local dev and on Netlify with no backend — sidestepping CRA's
// single-`proxy` limitation.

const GEOCODER_BASE = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";

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

// Returns { lat, lon, state, county, place, districts } or null if no address match.
export async function geocode(address) {
  if (!address || !address.trim()) return null;

  const url =
    `${GEOCODER_BASE}?address=${encodeURIComponent(address.trim())}` +
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
    districts: {
      congressional: firstLayerMatching(g, "congressional")?.BASENAME || null,
      stateUpper: firstLayerMatching(g, "legislative", "upper")?.BASENAME || null,
      stateLower: firstLayerMatching(g, "legislative", "lower")?.BASENAME || null,
    },
  };
}
