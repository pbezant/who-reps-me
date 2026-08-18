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
| Extraction | GitHub Models via built-in `GITHUB_TOKEN` (default) | $0 |

No database server and no always-on worker. For read-only, batch-updated data, a per-state
JSON file *is* the database — the frontend already fetches JSON and knows the state from
geocoding, so it downloads exactly one small shard.

## LLM provider (swappable — free options)

Extraction is provider-agnostic. Most free LLM APIs expose an **OpenAI-compatible**
`/chat/completions` endpoint, so one code path covers all of these. Pick one with `LLM_PRESET`:

| Preset | Free tier | Key needed | Notes |
| --- | --- | --- | --- |
| **`github`** ← default | 15 RPM, 150 RPD | **none** — built-in `GITHUB_TOKEN` | Simplest in Actions; needs `models: read`. Per-request cap ~8K in / 4K out, so pages clip to 18k chars |
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
# default: GitHub Models. In Actions this needs nothing at all. Locally, GITHUB_TOKEN
# isn't set for you, so use a fine-grained PAT with the "Models: read" permission:
cd scraper
LLM_API_KEY=github_pat_... npm run scrape

# free, via Groq
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
seeds.json ─> fetch ─────────> AI extract ─> normalize ─> dedupe ─> per-state shards
 (config)    fetch.js         extract.js   normalize.js  pipeline.js   output.js
             └─ browser.js                                          -> ../public/officials/<ST>.json
                (fallback)
```

- **fetch.js** — native `fetch`, strips HTML to text; retries through headless Chromium when a
  page is client-rendered or WAF-blocked.
- **browser.js** — optional Playwright fallback, lazily imported and shared across the run.
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

# then scrape (GitHub Models by default; locally needs a PAT with "Models: read")
LLM_API_KEY=github_pat_... npm run scrape
LLM_API_KEY=github_pat_... npm run scrape -- --only Austin
```

`probe` reports each URL as `OK`, `OK (via browser)`, `FAIL`, `NEEDS-BROWSER`, or
`NO-ROSTER-KEYWORDS`, and for
anything not OK it scans the site's homepage and prints candidate council links to use instead.
Full report: `scraper/data/probe.json`.

Scrape output: `public/officials/<STATE>.json` shards + `index.json`. Failed pages go to
`scraper/data/problems.json`.

## Run on a schedule (free)

`.github/workflows/scrape.yml` runs **overnight** — weekly, Monday at 07:00 UTC
(2:00 AM CDT / 1:00 AM CST) — so it never competes with daytime API usage. It commits changed
shards and Netlify auto-deploys on the push. Change the cron to `0 7 * * *` for nightly, though
weekly is usually plenty since officials rarely change.

**Setup: none required.** Extraction defaults to GitHub Models using the `GITHUB_TOKEN` that
Actions injects automatically (the workflow grants `models: read`). To use a different provider,
add a repo secret — `LLM_API_KEY` for a free provider, or `ANTHROPIC_API_KEY` for Claude — under
*Settings → Secrets and variables → Actions*, and set the repo **variable** `LLM_PRESET` to its name.

The **Run workflow** button takes a `mode`:

| mode | Cost | Use |
| --- | --- | --- |
| `scrape` ← default | free | The real run: extracts officials and commits the data |
| `probe` | free | Only checks seed URLs and **writes no data**; downloads a `seed-probe-report` artifact |

Scheduled runs always scrape.

> **The workflow only appears in the Actions tab once this file is on the repository's default
> branch.** GitHub registers workflows from the default branch only, so while it lives on a
> feature branch there is nothing to run — no **Run workflow** button and no cron, and switching
> branches in the UI won't reveal it. Until it's merged, run the scraper locally (see above).
> GitHub also disables schedules after ~60 days of repo inactivity.

## Browser fallback (headless Chromium)

Two things defeat a plain HTTP fetch: rosters rendered client-side (you get an empty shell) and
municipal WAFs that answer non-browser requests with **403**. Both are retried through headless
Chromium via Playwright, which executes the page's JS and presents as a real browser.

Playwright is an **optional dependency** — `browser.js` imports it lazily, so without it the
scraper behaves exactly as before and just reports those pages as `needs-browser`.

```bash
cd scraper
npm install                          # installs playwright (optional dep)
npx playwright install chromium      # downloads the browser
npm run probe                        # now reports "OK (via browser)" where relevant

npm install --omit=optional          # opt out entirely; static-only
SCRAPER_BROWSER=0 npm run scrape     # or disable per-run
```

If your Chromium lives outside Playwright's default location, point at it with
`PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome`.

In CI the workflow installs and caches Chromium automatically. Set the repo variable
`SCRAPER_BROWSER=0` to turn the fallback off.

Costs nothing in API terms — rendering is local work, not LLM tokens. It only spends CI minutes.

## Seed list

`config/seeds.json` covers **Central Texas** — 25 jurisdictions across the Austin metro and the
Hays / Caldwell / Bastrop / Williamson counties, including 5 county commissioners courts.

Counties use `level: "county"` with `city` set to `"<Name> County"` — the frontend's
`normalizePlace` strips the "County" suffix so it matches the geocoded county.

**Seed URLs are guesses until a probe run proves otherwise.** The first probe run scored only
4/26, and its homepage suggestions supplied the corrections now in the file. Current state:

| Status | Jurisdictions |
| --- | --- |
| Probe-verified `OK` | Austin, Leander, Travis County, Caldwell County |
| Corrected from probe suggestions | Bee Cave, Round Rock, Hutto, Kyle, Bastrop, Bastrop County, Wimberley, Lockhart |
| Previously timed out at 15s (timeout now 30s) | Lakeway, Cedar Park, Taylor, Buda, San Marcos, Elgin, Williamson County |
| Needs the browser fallback (403 / client-rendered) | Dripping Springs, Pflugerville |
| Root seeded so probe can suggest the council page | Manor, Hays County, Georgetown, Smithville |

Luling was removed: `www.lulingtx.org` does not resolve and the city's real domain is unknown.

**Workflow when a seed fails:** run `npm run probe`, read the `try:` suggestions it prints under
each failure, paste the right URL into `seeds.json`, repeat. Each round is free.

