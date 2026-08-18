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
| Extraction | swappable LLM — free tier or Claude Haiku | $0–20 |

No database server and no always-on worker. For read-only, batch-updated data, a per-state
JSON file *is* the database — the frontend already fetches JSON and knows the state from
geocoding, so it downloads exactly one small shard.

## LLM provider (swappable — free options)

Extraction is provider-agnostic. Most free LLM APIs expose an **OpenAI-compatible**
`/chat/completions` endpoint, so one code path covers all of these. Pick one with `LLM_PRESET`:

| Preset | Free tier | Key needed | Notes |
| --- | --- | --- | --- |
| `github` | 15 RPM, 150 RPD | **none** — built-in `GITHUB_TOKEN` | Simplest in Actions; needs `models: read` |
| `groq` | 30 RPM, 1,000 RPD | `LLM_API_KEY` | Very fast; Llama 3.3 70B |
| `gemini` | 15 RPM, 1,500 RPD | `LLM_API_KEY` | Strong at structured output; 1M context |
| `mistral` | ~1B tokens/month | `LLM_API_KEY` | Highest volume ceiling — best for going nationwide |
| `nvidia` | ~40 RPM, no daily cap | `LLM_API_KEY` | Good for bulk backfills |
| `cerebras` | 5 RPM, 1M TPD | `LLM_API_KEY` | Payment method required |
| `openrouter` | 20 RPM, 50 RPD | `LLM_API_KEY` | Many `:free` models |
| `samba`, `llm7` | varies | `LLM_API_KEY` | See the list below |
| `ovh` | 2 RPM per IP | **none** — anonymous | EU-hosted; slow but keyless |
| `anthropic` | — (paid) | `ANTHROPIC_API_KEY` | ~$0.014/page, best extraction quality |

Provider list and limits: [awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis).

```bash
# free, via Groq
cd scraper
LLM_PRESET=groq LLM_API_KEY=gsk_... npm run scrape

# free, no key at all (EU-hosted, 2 RPM so it's slow)
LLM_PRESET=ovh npm run scrape

# any other OpenAI-compatible endpoint
LLM_BASE_URL=https://... LLM_MODEL=some-model LLM_API_KEY=... npm run scrape
```

In CI, set the repository **variable** `LLM_PRESET` to switch permanently, or use the
workflow's `provider` input to trial one for a single run.

**Free tiers are limited by requests, not dollars**, so `extract.js` throttles to the preset's
RPM and retries on 429/5xx with backoff (honoring `Retry-After`). Override with `LLM_RPM`.

### Honest trade-offs

- **Quality varies.** Claude Haiku and Gemini Flash are reliably good at strict JSON
  extraction; smaller open models miss fields or wander from the schema more often. Every
  record carries a `confidence` score — spot-check a couple of cities after switching, and
  compare providers using the `provider` input on a single city (`--only Austin`).
- **Rate limits, not cost, are the real constraint at scale.** For Central Texas (26 pages)
  every option above fits easily. Nationwide (~25k pages) the daily caps decide the timeline:
  Mistral's ~1B tokens/month or NVIDIA's uncapped ~40 RPM finish in days; a 50 RPD free model
  would take over a year.
- **Several free tiers train on or log prompts** (Gemini, Mistral, OpenRouter free models).
  We only send **public government web pages**, so there's nothing sensitive at stake — but
  don't reuse these presets for private data.
- **Cohere's trial tier is non-commercial only**, and free endpoints change without notice
  (Groq cut its daily limits in 2026). Keep the preset swappable rather than hard-coding one.

## Approach: AI extraction, not per-site parsers

Every city website has a different layout, so hand-written CSS/XPath scrapers don't scale.
Instead we send each page's **visible text to an LLM** and ask for a strict JSON list of
officials (`src/extract.js`). Adding a new city is **adding a URL to the seed list**, not
writing new code. Any provider works — see above.

## Pipeline

```
seeds.json ─> fetch ─> AI extract ─> normalize ─> dedupe ─> per-state shards
 (config)    fetch.js   extract.js   normalize.js  pipeline.js   output.js -> ../public/officials/<ST>.json
```

- **fetch.js** — native `fetch`, strips HTML to text, flags likely JS-only pages for a browser fallback.
- **extract.js** — provider-agnostic LLM call (raw fetch, no SDK) with RPM throttle and 429 retry.
- **normalize.js** — canonical record with provenance (`source_url`, `extracted_at`) and `confidence`.
- **pipeline.js** — per-jurisdiction orchestration + dedupe.
- **output.js** — groups by state and **upsert-merges** into `public/officials/<STATE>.json` so a
  scoped run never wipes other cities; also maintains `public/officials/index.json` (coverage).
- **run.js** — CLI entry; writes shards + a scratch `data/problems.json` (gitignored).

## Run locally

**Always probe first — it's free.** The probe checks every seed URL without making a single
LLM call, so you never waste requests (or money) on dead links:

```bash
cd scraper
npm run probe                  # free: verify all seed URLs
npm run probe -- --only Kyle   # free: verify one

# then scrape with whichever provider you chose above
LLM_PRESET=groq LLM_API_KEY=gsk_... npm run scrape
LLM_PRESET=groq LLM_API_KEY=gsk_... npm run scrape -- --only Austin
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

**One-time setup:** pick a provider. The `github` preset needs **nothing** (it uses the
built-in `GITHUB_TOKEN`). Any other provider needs a repo secret — `LLM_API_KEY` for a free
provider, or `ANTHROPIC_API_KEY` for Claude — under
*Settings → Secrets and variables → Actions*. Set the repo **variable** `LLM_PRESET` to choose.

The **Run workflow** button takes a `mode`:

| mode | Cost | Use |
| --- | --- | --- |
| `probe` | free | Verify seed URLs; downloads a `seed-probe-report` artifact |
| `scrape` | free or paid, per provider | The real run |

Scheduled runs always scrape.

> **The workflow only appears in the Actions tab once this file is on the repository's default
> branch.** GitHub registers workflows from the default branch only, so while it lives on a
> feature branch there is nothing to run — no **Run workflow** button and no cron, and switching
> branches in the UI won't reveal it. Until it's merged, run the scraper locally (see above).
> GitHub also disables schedules after ~60 days of repo inactivity.

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
