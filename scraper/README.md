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

**Always probe first — it's free.** The probe checks every seed URL without making a single
Claude call, so you never spend extraction tokens on dead links:

```bash
cd scraper
npm run probe                  # free: verify all seed URLs
npm run probe -- --only Kyle   # free: verify one

export ANTHROPIC_API_KEY=sk-ant-...
npm run scrape                 # costs tokens: all seed cities
npm run scrape -- --only Kyle  # costs tokens: one city
```

`probe` reports each URL as `OK`, `FAIL`, `NEEDS-BROWSER`, or `NO-ROSTER-KEYWORDS`, and for
anything not OK it scans the site's homepage and prints candidate council links to use instead.
Full report: `scraper/data/probe.json`.

Scrape output: `public/officials/<STATE>.json` shards + `index.json`. Failed pages go to
`scraper/data/problems.json`.

## Run on a schedule (free)

`.github/workflows/scrape.yml` runs **overnight** — weekly, Monday at 07:00 UTC
(2:00 AM CDT / 1:00 AM CST) — so it never competes with daytime API usage. It commits changed
shards and Netlify auto-deploys on the push. Change the cron to `0 7 * * *` for nightly, though
weekly is usually plenty since officials rarely change.

**One-time setup:** add repo secret `ANTHROPIC_API_KEY` under
*Settings → Secrets and variables → Actions*.

The **Run workflow** button takes a `mode`:

| mode | Cost | Use |
| --- | --- | --- |
| `probe` | free | Verify seed URLs; downloads a `seed-probe-report` artifact |
| `scrape` | tokens | The real run |

Scheduled runs always scrape. Note that schedules fire only from the **default branch**, so use
the manual button to test a feature branch; GitHub also disables schedules after ~60 days of
repo inactivity.

## Seed list

`config/seeds.json` currently covers **Central Texas** (26 jurisdictions): the Austin metro
(Austin, Round Rock, Cedar Park, Georgetown, Leander, Pflugerville, Hutto, Taylor, Lakeway,
Bee Cave, Manor), the Hays/Caldwell/Bastrop cities (Kyle, Buda, San Marcos, Dripping Springs,
Wimberley, Lockhart, Luling, Bastrop, Elgin, Smithville), and 5 county commissioners courts
(Travis, Williamson, Hays, Caldwell, Bastrop).

Counties use `level: "county"` with `city` set to `"<Name> County"` — the frontend's
`normalizePlace` strips the "County" suffix so it matches the geocoded county.

These URLs are best-effort and **not yet verified against the live sites** (the dev sandbox
blocks outbound access to municipal hosts). Run `npm run probe` — locally or via the workflow's
`probe` mode — and fix any non-OK entries before the first real scrape.

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
