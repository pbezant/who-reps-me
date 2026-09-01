// Shared, framework-free helpers for local-official records — the ONE place the id<->URL-slug
// mapping and the scraped-record -> card-shape mapping live, so the React app (src/App.js,
// src/RepProfile.js) and the Node build scripts (scripts/prerender-officials.js,
// scripts/generate-sitemap.js) all agree byte-for-byte.
//
// Deliberately CommonJS with zero React/DOM imports: webpack imports it into the app via interop,
// and `require()` pulls it straight into the build scripts. Keep it that way — a stray `import`
// of a .jsx or a browser global here would break the Node side silently.

// One id segment (city / office / name) -> a URL-safe, readable slug piece. The scraper's ids
// (scraper/src/normalize.js buildId) are lowercased and space->hyphen'd but still carry raw
// punctuation — ".", "(", ")", "'", "&", ",", ";", "?", "/" all occur in real records — none of
// which belong in a path segment. Fold every run of non-[a-z0-9] to a single hyphen.
function slugSegment(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFKD')                 // "é" -> "e" + combining acute, so we keep the base letter
    .replace(/[̀-ͯ]/g, '')   // drop the combining marks (else "pérez" -> "pe-rez")
    .replace(/[^a-z0-9]+/g, '-')       // any punctuation/space run -> one hyphen
    .replace(/^-+|-+$/g, '');          // trim leading/trailing hyphens
}

// Scraper id  "tx:austin:council-member:jane-doe"
//   -> slug   "tx/austin/council-member/jane-doe"  (the /rep/<slug> path, no leading slash).
// The state stays a bare 2-letter segment (already clean); the other three are re-slugified.
// Pure function of the id: measured unique across every committed shard, so it is never stored,
// only derived. buildSlugMap() below is the build-time guard that this stays true.
function slugFromId(id) {
  const parts = String(id || '').split(':');
  if (parts.length < 4) return '';
  const [state, jurisdiction, office, name] = parts;
  return [
    slugSegment(state),
    slugSegment(jurisdiction),
    slugSegment(office),
    slugSegment(name),
  ].join('/');
}

// First path segment of a slug -> shard filename key (e.g. "tx/austin/..." -> "TX"), so a cold
// visit to /rep/<slug> knows which public/officials/<STATE>.json to fetch.
function stateFromSlug(slug) {
  const first = String(slug || '').split('/')[0];
  return first ? first.toUpperCase() : '';
}

// The canonical in-app path for a local official's profile.
function repProfilePath(rep) {
  return `/rep/${slugFromId(rep.id)}`;
}

// Map a scraped official record (static shard or on-demand Netlify-function response — same shape,
// see scraper/src/normalize.js) into the card shape the 5calls reps use. Moved here from App.js so
// the prerender script can reuse the exact same mapping; App.js re-exports it for existing callers.
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
    // Governing body (e.g. "Austin City Council"), for context alongside the office title. Only
    // surfaced when `office` is present — when it's absent, `area` above already fell back to
    // `body` itself, so repeating it here would just show the same text twice.
    body: o.office ? (o.body || '') : '',
    // hours/bio are only ever populated by the bio-page follow-up pass (see normalize.js) — a
    // roster-page-only record always has both null.
    hours: o.hours || '',
    bio: o.bio || '',
    // Provenance: when this record was last (re)confirmed, and the page it came from — lets the
    // frontend show a "verified on" date instead of presenting scraped data as evergreen.
    verifiedAt: o.extracted_at || null,
    sourceUrl: o.source_url || '',
    // LLM self-reported extraction confidence, 0-1 (local officials only — state/federal come
    // from structured APIs, not extraction). Used to flag a record worth double-checking.
    confidence: typeof o.confidence === 'number' ? o.confidence : null,
    isLocal: true,
  };
}

// Build-time helper: given all officials in one state's shard, return an array of
// { slug, official } with any (currently non-existent) slug collision made unique by appending
// -2, -3, ... to the later id in sorted order. Deterministic, so a given shard always yields the
// same URLs. Returns { entries, collisions } so the caller can surface a collision if data ever
// changes to introduce one.
function buildSlugMap(officials) {
  const sorted = [...officials].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Map();
  const entries = [];
  let collisions = 0;
  for (const official of sorted) {
    let slug = slugFromId(official.id);
    if (!slug) continue;
    if (used.has(slug)) {
      collisions += 1;
      let n = 2;
      while (used.has(`${slug}-${n}`)) n += 1;
      slug = `${slug}-${n}`;
    }
    used.set(slug, true);
    entries.push({ slug, official });
  }
  return { entries, collisions };
}

module.exports = {
  slugSegment,
  slugFromId,
  stateFromSlug,
  repProfilePath,
  toRepCard,
  buildSlugMap,
};
