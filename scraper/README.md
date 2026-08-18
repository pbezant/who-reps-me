# who-reps-me · local officials scraper

Background scraper that fills the gap no free API covers: **local elected officials, down to
city council**, with contact info. Federal + state are handled by 5calls in the frontend; this
service handles the local layer and stores it as static JSON the app reads directly.

## Why a scraper (and not an API)

There is no free API for city-council-level officials nationwide. Google's Civic
Representatives API shut down April 2025; the only comprehensive providers (Cicero,
BallotReady) are paid commercial data. This scraper is the DIY alternative.

## Cost model: $0 infrastructure

| Piece | Choice | Cost |
| --- | --- | --- |
| Hosting | Netlify static (already used) | $0 |
| Data store | Per-state JSON shards committed to the repo | $0 |
| Runner | GitHub Actions cron | $0 |
| Geocoding | US Census Geocoder (no API key) | $0 |
| Extraction | Claude Haiku, ~$0.014/page | scoped ~$5–20 |

No database server and no always-on worker. For read-only, batch-updated data, a per-state
JSON file *is* the database — the frontend already fetches JSON and knows the state from
geocoding, so it downloads exactly one small shard.

## Approach: AI extraction, not per-site parsers

Every city website has a different layout, so hand-written CSS/XPath scrapers don't scale.
Instead we send each page's **visible text to Claude** and ask for a strict JSON list of
officials (`src/extract.js`). Adding a new city is **adding a URL to the seed list**, not
writing new code.

## Pipeline

```
seeds.json ─> fetch ─> AI extract ─> normalize ─> dedupe ─> per-state shards
 (config)    fetch.js   extract.js   normalize.js  pipeline.js   output.js -> ../public/officials/<ST>.json
```

- **fetch.js** — native `fetch`, strips HTML to text, flags likely JS-only pages for a browser fallback.
- **extract.js** — Claude Messages API (raw fetch, no SDK). Cheap model by default.
- **normalize.js** — canonical record with provenance (`source_url`, `extracted_at`) and `confidence`.
- **pipeline.js** — per-jurisdiction orchestration + dedupe.
- **output.js** — groups by state and **upsert-merges** into `public/officials/<STATE>.json` so a
  scoped run never wipes other cities; also maintains `public/officials/index.json` (coverage).
- **run.js** — CLI entry; writes shards + a scratch `data/problems.json` (gitignored).

## Run locally

```bash
cd scraper
export ANTHROPIC_API_KEY=sk-ant-...
npm run scrape                 # all seed cities
npm run scrape -- --only Kyle  # one city
```

Output: `public/officials/<STATE>.json` shards + `index.json`. Problems (failed / needs-browser
pages) go to `scraper/data/problems.json`.

## Run on a schedule (free)

`.github/workflows/scrape.yml` runs the scraper weekly (and on-demand via **Run workflow**),
commits changed shards, and Netlify auto-deploys on the push.

**One-time setup:** add repo secret `ANTHROPIC_API_KEY` under
*Settings → Secrets and variables → Actions*. Scheduled runs fire only from the default branch,
so test with the manual **Run workflow** button before merging.

## Record schema

```jsonc
{
  "id": "tx:austin:mayor:kirk-watson",
  "name": "Kirk Watson",
  "office": "Mayor",
  "level": "local",              // federal | state | county | local
  "body": "Austin City Council",
  "district": null,              // "District 4" / "Place 5" when applicable
  "phone": "512-978-2100",
  "email": null,
  "url": "https://...",
  "photo_url": "https://...",
  "address": null,
  "jurisdiction": { "city": "Austin", "state": "TX" },
  "source_url": "https://...",   // provenance
  "extracted_at": "2026-08-18T...",
  "confidence": 0.9
}
```

## How the frontend uses it

`src/geocode.js` geocodes the user's address via the US Census Geocoder (JSONP, no key),
returning `{ lat, lon, state, county, place, districts }`. `src/App.js` then fetches
`/officials/<state>.json` and matches officials whose city/county equals the geocoded
place/county, rendering them alongside the federal/state reps. The `lat`/`lon` is retained for
future **ward-level point-in-polygon** matching.

## Scaling & limitations

- **Grow coverage** by adding jurisdictions to `config/seeds.json`. At nationwide scale the
  seed list is generated from the US Census *Census of Governments*; the pipeline is unchanged.
- **JS-rendered sites** (flagged `needs-browser`, e.g. the 403 on cityofkyle.com) need a
  Playwright fetch fallback — a drop-in phase-2 addition to `fetch.js`.
- **Address → *your specific* council member** (ward/district) needs per-city boundary GeoJSON
  most cities don't publish. MVP matches at **city + county level**; geocoding already provides
  the coordinates to upgrade wherever boundary data exists. Even Cicero has this gap.
- If server-side queries are ever needed, the shards migrate cleanly to a free-tier DB
  (Neon / Supabase / Turso / Cloudflare D1) — not required now.
