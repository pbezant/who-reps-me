# who-reps-me · local officials scraper

Background scraper that fills the gap no free API covers: **local elected officials, down to
city council**, with contact info. Federal + state are already handled by 5calls in the
frontend; this service handles the local layer and serves it to the app.

## Why a scraper (and not an API)

There is no free API for city-council-level officials nationwide. Google's Civic
Representatives API shut down April 2025; the only comprehensive providers (Cicero,
BallotReady) are paid commercial data. This scraper is the DIY alternative.

## Approach: AI extraction, not per-site parsers

Every city website has a different layout, so hand-written CSS/XPath scrapers don't scale —
you'd maintain thousands of them. Instead we send each page's **visible text to Claude** and
ask for a strict JSON list of officials (`src/extract.js`). Adding a new city is **adding a
URL to the seed list**, not writing new code.

## Pipeline

```
seeds.json ──> fetch ──> AI extract ──> normalize ──> dedupe ──> officials.json / Postgres
 (discover)   fetch.js    extract.js    normalize.js   pipeline.js        run.js
```

- **fetch.js** — native `fetch`, strips HTML to text, flags likely JS-only pages that need a browser.
- **extract.js** — Claude Messages API (raw fetch, no SDK). Cheap model by default.
- **normalize.js** — canonical record with provenance (`source_url`, `extracted_at`) and `confidence`.
- **pipeline.js** — per-jurisdiction orchestration + dedupe.
- **run.js** — prototype CLI; writes `data/officials.json`.

## Run the prototype

```bash
cd scraper
export ANTHROPIC_API_KEY=sk-ant-...
npm run scrape              # all seed cities
npm run scrape -- --only Kyle
```

Output: `data/officials.json` — normalized officials + a `problems` list of pages that
failed or need a browser.

## Record schema

```jsonc
{
  "id": "tx:austin:mayor:kirk-watson",
  "name": "Kirk Watson",
  "office": "Mayor",
  "level": "local",              // federal | state | county | local
  "body": "Austin City Council",
  "district": null,              // "District 4" / "Ward 2" / "Place 5" when applicable
  "phone": "512-978-2100",
  "email": null,
  "url": "https://...",
  "photo_url": "https://...",
  "address": null,
  "jurisdiction": { "city": "Austin", "state": "TX" },
  "source_url": "https://...",   // provenance
  "extracted_at": "2026-08-09T...",
  "confidence": 0.9
}
```

## Scaling to nationwide (the roadmap)

The prototype and the national system run the **same** `pipeline.js`. Scaling is these
additions, not a rewrite:

1. **Discovery layer (`discover.js`, phase 2).** Seed the list of *which* governments exist
   from the US Census Bureau **Census of Governments** (~19k municipalities, ~3k counties,
   ~13k school districts), then resolve each to its website via search. This replaces the
   hand-written `seeds.json`.
2. **Browser fallback (phase 2).** Playwright for pages `fetch.js` flags as `needs-browser`
   (JS-rendered SPAs).
3. **Postgres (phase 2).** Upsert records by `id`; keep `last_verified`. Swap the JSON file
   write in `run.js` for DB upserts.
4. **Incremental crawl (phase 3).** A queue + nightly slice so we never hit 25k sites at
   once. Re-crawl aggressively right after November elections when officials change.
5. **API (phase 3).** Small Express service the React app queries instead of 5calls for the
   local layer.

### The hard limitation to be honest about

**Address → *your specific* council member** needs ward/district boundary maps that most
cities don't publish. So:
- City-level (mayor, all council members for a city) → achievable everywhere.
- Ward/district-level (your one representative) → only where boundary data exists; elsewhere
  we return all council members for the city and let the user pick.

Even Cicero has gaps here — it's a property of the data ecosystem, not this design.

## Deploying on DigitalOcean

- **Managed Postgres** for storage.
- **App Platform Worker** (or a small Droplet) running the crawler on a cron schedule.
- **App Platform Service** for the read API.
- Secrets: `ANTHROPIC_API_KEY`, `DATABASE_URL` as env vars.
- Be a good citizen: honest User-Agent (set in `fetch.js`), respect robots.txt, rate-limit
  per-domain. Public gov data is generally low-risk to collect, but crawl politely.
