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
| Extraction | `ovh` free tier, no API key (default) | $0 |

No database server and no always-on worker. For read-only, batch-updated data, a per-state
JSON file *is* the database — the frontend already fetches JSON and knows the state from
geocoding, so it downloads exactly one small shard.

## LLM provider (swappable — free options)

Extraction is provider-agnostic. Most free LLM APIs expose an **OpenAI-compatible**
`/chat/completions` endpoint, so one code path covers all of these. Pick one with `LLM_PRESET`:

| Preset | Free tier | Key needed | Notes |
| --- | --- | --- | --- |
| ~~`github`~~ | **RETIRED** | — | GitHub shut GitHub Models down; it returns HTTP 410. Do not use |
| `groq` | 30 RPM, 1,000 RPD | `LLM_API_KEY` | Very fast; Llama 3.3 70B |
| `gemini` | 15 RPM, 1,500 RPD | `LLM_API_KEY` | Strong at structured output; 1M context |
| `mistral` | ~1B tokens/month | `LLM_API_KEY` | Highest volume ceiling — best for going nationwide |
| `nvidia` | ~40 RPM, no daily cap | `LLM_API_KEY` | Good for bulk backfills |
| `cerebras` | 5 RPM, 1M TPD | `LLM_API_KEY` | Payment method required |
| `openrouter` | 20 RPM, 50 RPD | `LLM_API_KEY` | Many `:free` models |
| `samba`, `llm7` | varies | `LLM_API_KEY` | See the list below |
| **`ovh`** ← default | 2 RPM per IP | **none** — anonymous | Keyless, so it works with zero setup, but 2 RPM means a 25-city run takes ~15 min |
| `anthropic` | — (paid) | `ANTHROPIC_API_KEY` | ~$0.014/page, best extraction quality |

Provider list and limits: [awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis).

```bash
# default: OVH anonymous tier — no key at all, but only 2 requests/minute
cd scraper
npm run scrape

# free and much faster, via Groq
LLM_PRESET=groq LLM_API_KEY=gsk_... npm run scrape

# any other OpenAI-compatible endpoint
LLM_BASE_URL=https://... LLM_MODEL=some-model LLM_API_KEY=... npm run scrape
```

In CI, set the repository **variable** `LLM_PRESET` to switch permanently, or use the
workflow's `provider` input to trial one for a single run.

**Free tiers are limited by requests, not dollars**, so `extract.js` throttles to the preset's
RPM and retries on 429/5xx with backoff (honoring `Retry-After`). Override with `LLM_RPM`.

### Honest trade-offs

- **Free providers disappear.** GitHub Models was retired outright mid-2026, and Groq cut its
  daily limits. This is why the provider is a one-variable swap and why a dead provider now
  aborts the run on the first failure instead of retrying 25 times.
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
officials (`src/extract.js`). Adding a new city is **adding a URL to the seed list** — by hand
in `config/seeds.json`, or automatically via `discover-jurisdictions.js` (see "Dynamic
jurisdiction discovery" below) — not writing new code. Any provider works — see above.

## Pipeline

```
seeds.json ∪ seeds.discovered.json ─> fetch ──> AI extract ─> normalize ─> bio-page follow-up ─> dedupe ─> per-state shards
   (config, via seeds.js)              fetch.js  extract.js   normalize.js   pipeline.js            pipeline.js  output.js
                  │                    └─ browser.js  ^                          │                              -> ../public/officials/<ST>.json
                  │                       (fallback)  └── media.js (photo/social candidates from the raw HTML)
                  │
                  └── config/seeds.discovered.json is grown by discover-jurisdictions.js (batch)
                      or netlify/functions/local-officials.mjs (on-demand) — see "Dynamic
                      jurisdiction discovery" below. config/seeds.json always wins a conflict.
```

## On-demand scraping (self-building coverage)

The weekly batch run above only covers what's in `config/seeds.json` ∪ `config/seeds.discovered.json`
(see "Dynamic jurisdiction discovery" below). For everything else, the frontend falls back to
scraping the jurisdiction live, the first time anyone searches it, and saving the result so it
never has to scrape that city again. This is what lets coverage grow to "wherever someone has
actually searched" without pre-seeding the whole country.

```
search with no shard match
        │
        ▼
netlify/functions/local-officials.mjs  (POST /api/local-officials)
        │
        ├─ 1. Netlify Blobs cache hit? ─────────────────► return cached officials
        │        (90-day TTL on a hit, 7-day TTL on a miss)
        │
        ├─ 2. discover.js: ask the LLM for the official site,
        │     then FETCH it to verify before trusting the answer
        │        │
        │        no site found ──────────────────────────► cache the miss, return []
        │        │
        ├─ 3. same fetch → extract → normalize pipeline the batch scraper uses
        │        (no browser fallback — see below)
        │
        └─ 4. save to Netlify Blobs, return the officials
```

- **`scraper/src/discover.js`** — two pieces, both shared with the batch discovery script
  (`discover-jurisdictions.js`, see below) so a fix here only ever happens once:
  - `discoverJurisdictionSite()` — ask the configured LLM to recall the official homepage, then
    **fetch it and check it actually looks like that jurisdiction's government site** before
    trusting it — models confidently hallucinate plausible `.gov`-shaped URLs for small towns,
    so recall alone isn't enough. A city the model doesn't know fails soft (empty result), not
    with an error.
  - `findRosterPage()` — a small breadth-first crawl from that confirmed homepage looking for
    the actual roster page (the homepage rarely is one), bounded by a fetch budget.
- **`netlify/functions/local-officials.mjs`** — the endpoint, using Netlify Blobs
  (`@netlify/blobs`) as the cache/save layer. Blobs, not a real database, to keep the same $0
  model as the rest of this project — no server to provision, included in Netlify's free tier.
- **No headless-browser fallback on this path.** Playwright doesn't fit a synchronous
  request/response function. A jurisdiction that needs it fails soft here and stays eligible
  for the batch scraper (which does have the browser fallback, via `browser.js`) to pick up
  later if it's ever added to `seeds.json`/discovered by `discover-jurisdictions.js`.
- **Not promoted into the committed shard automatically.** An on-demand find lives only in
  Blobs, separate from `public/officials/<STATE>.json`. It works (the frontend checks Blobs
  whenever the shard misses), but the batch scraper never sees it, and Blobs isn't backed up —
  if you want the URL it found in the permanent, git-committed dataset too, copy it into
  `config/seeds.json` by hand (or let `discover-jurisdictions.js` find the same jurisdiction on
  its own schedule — see "Dynamic jurisdiction discovery" below, which *does* write into a
  committed file).

### Setup: Netlify environment variables

This path runs **synchronously inside a live search**, so it needs a fast LLM preset — the
scraper's own `ovh` default (2 requests/minute, no key) will blow past Netlify's function
timeout. In the Netlify site's *Site configuration → Environment variables*, set:

```
LLM_PRESET=groq            # or gemini / mistral — anything faster than ovh
LLM_API_KEY=...            # that provider's free-tier key
```

Same variables the batch scraper uses (see the provider table above) — just set on the
Netlify site itself, not only as a GitHub Actions secret, since the two run in different
places.

### Testing locally

Netlify Blobs only works inside Netlify's runtime, so `npm start` alone won't exercise this
path — run it through the Netlify CLI instead:

```bash
npm install -g netlify-cli   # once
netlify dev
```

- **fetch.js** — native `fetch`, strips HTML to text; retries through headless Chromium when a
  page is client-rendered or WAF-blocked.
- **browser.js** — optional Playwright fallback, lazily imported and shared across the run.
- **media.js** — regex scan of the page's *raw* HTML (before fetch.js strips it to text) for
  photo `<img>` and social-link `<a>` candidates, plus a post-hoc `stripSharedMedia()` pass that
  nulls out a photo/link repeated across several officials (a jurisdiction-wide logo/account, not
  a personal one). Without this, `extract.js`'s `photo_url`/`social` fields have nothing to work
  with — `htmlToText()` removes every `src`/`href` before the LLM ever sees the page.
- **extract.js** — provider-agnostic LLM call (raw fetch, no SDK) with RPM throttle and 429 retry.
  Also builds the "images and social links found on this page" block from `media.js`'s output.
- **normalize.js** — canonical record with provenance (`source_url`, `extracted_at`) and `confidence`.
  Its `id` (`state:city:office:name`) canonicalizes the office string and strips quote characters
  before building the id, so two runs that extract the same person with slightly different office
  phrasing ("City Council Member" vs "Council Member") or nickname-quote style don't get upserted
  as two different people (`output.js`'s upsert is keyed on `id`) — see `buildId()`.
- **pipeline.js** — per-jurisdiction orchestration: roster-page fetch/extract/normalize, dedupe,
  then a budget-capped bio-page follow-up pass (`enrichFromBioPages()`) — see "Photos and social
  links" below.
- **output.js** — groups by state and **upsert-merges field-by-field** (not a wholesale replace
  — see `normalize.js`'s `mergeRecordFields()`) into `public/officials/<STATE>.json` so a scoped
  run never wipes other cities, and a later run that doesn't re-reach a given official's bio page
  never erases enrichment a previous run already found; also maintains
  `public/officials/index.json` (coverage).
- **run.js** — CLI entry; writes shards + a scratch `data/problems.json` (gitignored). Loads its
  jurisdiction list via `seeds.js`, not `config/seeds.json` directly. Unless `--only` targets a
  single city, each run is budget-capped (`SCRAPER_BUDGET`, default 50) and prioritized via
  `selectScrapeCandidates()` — never-scraped jurisdictions first, then whichever previously-
  scraped ones are most overdue for a refresh (`SCRAPER_REFRESH_DAYS`, default 30). At nationwide
  scale a full sweep every run doesn't fit GitHub Actions' 6-hour job limit or a free-tier LLM
  rate limit, so a run that doesn't get through everything just picks up where it left off next
  time — the same resumable pattern `discover-jurisdictions.js` already uses.
- **seeds.js** — merges `config/seeds.json` (hand-authored) with `config/seeds.discovered.json`
  (auto-discovered — see "Dynamic jurisdiction discovery" below), hand-authored entries always
  winning a conflict. Shared by `run.js` and `probe.js`.
- **federal-social.js** — unrelated to the scrape pipeline above: builds
  `public/federal-social.json` from the public `unitedstates/congress-legislators` project (no
  LLM calls). See "Photos and social links" below.
- **federal-details.js** — same zero-LLM pattern as `federal-social.js`, from the same project:
  builds `public/federal-details.json` (term dates, committee assignments, DC office,
  crowdsourced district offices, a Wikipedia bio blurb). See "Photos and social links" below.

## Photos and social links

Every official record carries `photo_url`, a `social` object
(`{twitter, facebook, instagram, linkedin, youtube}`, each a URL or `null`), and an `offices[]`
array (`{classification, name, city, address, phone, fax, hours}` per entry — capitol, district,
DC, field, whatever a source calls it) — see `normalize.js`'s `normalizeOffices()`. Two more
top-level fields, `hours` and `bio`, exist only for local officials and are only ever filled by
the bio-page follow-up pass described below. Coverage varies by source:

- **Local officials (this scraper)**: extracted from whatever roster page is already being
  fetched, via `media.js` + the extended `extract.js` prompt — this alone rarely shows a photo
  or personal social links. `pipeline.js` then runs a second pass, `enrichFromBioPages()`: for
  each official who still has a gap (no photo, address, phone, email, hours, or bio) **and** has
  their own bio-page `url`, it fetches that page and asks `extractOfficialDetail()` (`extract.js`)
  for just that one person's details, merging in whatever it finds via `mergeEnrichment()`
  (`normalize.js`) — which only ever fills a null field, never overrides what the roster page
  already found. Budget-capped per jurisdiction per run (`SCRAPER_ENRICH_BUDGET`, default 10) so
  a large council doesn't blow past a free-tier LLM rate limit in one run; a jurisdiction that
  hits the cap resumes automatically next run, since a record still missing fields stays a
  candidate. Skips a bio-page `url` shared by 2+ officials (almost always a generic "Contact Us"
  page, not a personal bio) and a record checked within the last 90 days. A photo/link that
  repeats across multiple officials *on the roster page itself* is treated as shared branding and
  dropped (`stripSharedMedia()`), not attributed to any one person — this is separate from, and
  doesn't cover, the bio-page pass's own shared-url guard above.
- **State legislators**: come from **Open States v3** (`people.geo`), which returns the photo,
  email, and the legislator's **full `offices[]` array** (capitol + any district offices, each
  with an address where the source has one) at a lat/lng — see the main `README.md` and
  `src/stateLegislators.js`'s `officesFrom()`. This replaced two weaker approaches at once:
  5calls' state entries (which often go missing entirely on ZIP-only searches, since it geocodes
  the search string rather than coordinates) and the roster-scraping path described below. Open
  States' office schema has no `hours` field — that's a permanent gap for this tier, not
  unpopulated data.

  The scraper used to seed state chamber rosters (`level: "state-upper"`/`"state-lower"`) and
  the frontend matched them onto 5calls records by `(state, chamber, district)`. **That path has
  been removed.** It needed one hand-vetted roster URL per chamber per state, and plenty of
  chambers have no single page carrying districts *and* photos/socials — the Texas House
  defeated it outright. It only ever had one seed, and no state-level record ever reached a
  shard. Open States covers all 50 states with no seeding, so `seeds.json` is now local and
  county jurisdictions only.
- **Federal reps**: photo and `field_offices` (phone + city, no address) come from 5calls, merged
  into `offices[]` by the frontend (`src/App.js`'s `officesFromFieldOffices()`). Everything else
  — social links, term dates, committee assignments, the DC office, and (usually) full
  district-office addresses — comes from two zero-scraping shards built from the public-domain
  `unitedstates/congress-legislators` project, keyed by bioguide ID (the same ID 5calls uses):
  `public/federal-social.json` (`federal-social.js`) and `public/federal-details.json`
  (`federal-details.js`). No scraping, no LLM calls, for either.

### Rebuilding the federal shards

```bash
cd scraper
npm install
npm run federal-social
npm run federal-details             # add SKIP_BIO=1 to skip the ~535 Wikipedia lookups
```

`federal-social.js` fetches and parses `legislators-social-media.yaml` (public domain, ~500
members) and writes `public/federal-social.json`.

`federal-details.js` fetches `legislators-current.yaml` (term dates + DC office),
`committee-membership-current.yaml` + `committees-current.yaml` (committee assignments), and
`legislators-district-offices.yaml` (crowdsourced district-office addresses/phones/hours — an
office needs at least an address or phone to be listed there at all, so coverage varies; measured
at 535/537 current members having at least one, per this script's own logged
"District-office coverage" line) into `public/federal-details.json`, plus an optional
one-paragraph Wikipedia bio blurb per member (`id.wikipedia` in the source YAML, via Wikipedia's
keyless REST summary endpoint).

Neither needs an API key or hits a rate limit — both can run far more often than the officials
scrape, and do, on the same schedule via `.github/workflows/federal-social.yml`.

## Tests

```bash
cd scraper
npm test
```

Uses Node's built-in test runner (`node --test`, no dependency needed) across `src/**/*.test.js`
and `scripts/**/*.test.js`. Coverage includes `normalize.js`'s id canonicalization (`buildId()`)
and field-level merge (`mergeRecordFields()`/`mergeEnrichment()`), the upsert-not-duplicate and
upsert-doesn't-erase-enrichment behaviors `output.js`'s `writeShards()` is meant to guarantee,
`pipeline.js`'s bio-page enrichment candidate selection/budget, `discover.js`'s same-origin link
filtering, `seeds.js`'s hand-authored-wins merge precedence, `discover-jurisdictions.js`'s
candidate-selection/cooldown logic, and `build-jurisdiction-universe.js`'s Gazetteer parsing.
Everything network/LLM-touching (the actual fetch/extract calls) is deliberately left untested
by unit tests, matching how `pipeline.js`'s `scrapeJurisdiction()` itself always has been — the
pure decision logic around it is extracted into small, directly-testable functions instead.

## One-off maintenance: deduping a shard

If a shard ever accumulates duplicate records under the *old* id scheme (pre-canonicalization —
the exact bug `buildId()` now fixes going forward), `scripts/dedupe-shard.js` re-derives every
record's id with the current `buildId()` and merges any that land on the same id, keeping the
newest `extracted_at` and backfilling null fields (`phone`, `email`, `url`, `photo_url`,
`address`, `district`, `hours`, `bio`, `bio_checked_at`, `offices`) from an older duplicate that
has them:

```bash
cd scraper
node scripts/dedupe-shard.js ../public/officials/TX.json --dry-run   # preview
node scripts/dedupe-shard.js ../public/officials/TX.json             # write
```

It only merges records that canonicalize to the same id — it will not touch two records that are
genuinely different offices or different people. If you run it against a shard, remember to
update `public/officials/index.json`'s `count` for that state to match (`writeShards()` keeps the
two in sync on a normal scrape; this script only touches the one shard file you point it at).

## Run locally

**Always probe first — it's free.** The probe checks every seed URL without making a single
LLM call, so you never waste requests (or money) on dead links:

```bash
cd scraper
npm run probe                  # free: verify all seed URLs
npm run probe -- --only Kyle   # free: verify one

# then scrape (OVH by default, no key; or pick a faster provider)
npm run scrape
LLM_PRESET=groq LLM_API_KEY=gsk_... npm run scrape -- --only Austin
```

`probe` reports each URL as `OK`, `OK (via browser)`, `FAIL`, `NEEDS-BROWSER`, or
`NO-ROSTER-KEYWORDS`, and for
anything not OK it scans the site's homepage and prints candidate council links to use instead.
Full report: `scraper/data/probe.json`.

Scrape output: `public/officials/<STATE>.json` shards + `index.json`. Failed pages go to
`scraper/data/problems.json`. A scrape also runs the bio-page follow-up pass described in
"Photos and social links" above; set `SCRAPER_ENRICH_BUDGET` (default 10) to change how many
bio-page fetches per jurisdiction per run it's allowed, or `SCRAPER_ENRICH_BUDGET=0` to disable
it entirely (roster-page-only, the old behavior).

At nationwide scale, `npm run scrape` (without `--only`) doesn't attempt every known
jurisdiction in one run — it picks up to `SCRAPER_BUDGET` (default 50) of them, never-scraped
ones first, then whichever previously-scraped ones are most overdue for a refresh
(`SCRAPER_REFRESH_DAYS`, default 30 — officials rarely change, so there's no value re-confirming
one scraped last week). A run reports how many jurisdictions were due vs. how many it actually
got to; anything left over just gets picked up next run, the same resumable pattern
`discover-jurisdictions.js` uses for its own queue. `--only` bypasses budget/staleness entirely.

## Run on a schedule (free)

`.github/workflows/scrape.yml` runs **overnight** — weekly, Monday at 07:00 UTC
(2:00 AM CDT / 1:00 AM CST) — so it never competes with daytime API usage. It commits changed
shards and Netlify auto-deploys on the push. Change the cron to `0 7 * * *` for nightly, though
weekly is usually plenty since officials rarely change.

**Setup: none required.** Extraction defaults to the `ovh` preset, whose anonymous tier needs no
key — but at 2 requests/minute a full run (roster pass + the bio-page follow-up pass, which adds
up to `SCRAPER_ENRICH_BUDGET` more LLM calls per jurisdiction — see "Run locally" above) takes
well over the ~15 minutes a roster-only run used to. `SCRAPER_BUDGET` (repo variable, default 50)
keeps a single run bounded regardless of how many jurisdictions are known in total — see "Run
locally" above — so a slow provider means more weeks to cycle through the full list, not a run
that blows past GitHub Actions' 6-hour job limit. For faster and better extraction, add a repo
secret (`LLM_API_KEY` for a free provider, or `ANTHROPIC_API_KEY` for Claude) under
*Settings → Secrets and variables → Actions*, and set the repo **variable** `LLM_PRESET` to that
provider's name.

> **GitHub Models is retired.** It was the original default and now returns
> `HTTP 410 github_models_retirement_brownout` for every request. It has been removed from the
> workflow's provider dropdown, and a run whose `LLM_PRESET` variable still says `github` fails
> in the first seconds with a message naming the working alternatives — check that repository
> **variable** if a run aborts this way, since a variable overrides the `ovh` default.

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

## Dynamic jurisdiction discovery

`config/seeds.json` no longer has to be the complete list of jurisdictions to scrape — it's now
specifically for **hand-vetted overrides/corrections**, merged (via `seeds.js`) with
`config/seeds.discovered.json`, an auto-generated file that grows on its own via
`discover-jurisdictions.js`. `seeds.json` always wins a conflict, so a hand-fixed URL is never
clobbered by automation.

### 1. Build the jurisdiction "universe" for a state (once, occasionally)

`discover-jurisdictions.js` needs to know what cities/counties exist before it can look for
their roster pages. That list comes from the US Census Bureau's annual **Gazetteer Files**
(public domain, no key —
[census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html)).
Download the national **Places** and **Counties** files for the year you want (each a `.zip`
containing one tab-delimited `.txt`), unzip them locally, then:

```bash
cd scraper
node scripts/build-jurisdiction-universe.js TX \
  --places /path/to/2025_gaz_place_national.txt \
  --counties /path/to/2025_gaz_county_national.txt
```

Writes `scraper/data/jurisdictions/TX.json` — **committed reference data**, regenerated by hand
only when it goes stale (Census publishes a new vintage annually). This script deliberately does
**not** download or unzip anything itself: the exact current-year filename wasn't verified
against a live fetch when this was built, and a human fetching the authoritative file once is
more robust than code trusting a URL that might 404 a year from now. See the script's own header
comment for exactly what it does with the two files (state/active-government filtering, stripping
Census's place-name suffixes to match `seeds.json`'s bare-name convention, ...).

### 2. Run discovery (budget-capped, repeatable)

```bash
DISCOVER_STATES=TX LLM_PRESET=groq LLM_API_KEY=... npm run discover-jurisdictions
```

For up to `DISCOVER_BUDGET` (default 15) jurisdictions not already in `seeds.json` or
`seeds.discovered.json` (and not a miss still inside its 90-day retry cooldown): asks the LLM for
the jurisdiction's homepage (`discoverJurisdictionSite()`), verifies it, then runs the same
roster-page crawl the on-demand path uses (`findRosterPage()` — both live in `discover.js`, so a
fix to this logic only ever happens once). A hit is appended to `seeds.discovered.json`; a miss
is recorded there too, with a reason, so a human can spot-check a sample for false positives
rather than trusting the automation blindly.

**This does not extract or commit officials data** — only URLs. The next `npm run scrape` (or
scheduled `scrape.yml` run) picks up anything newly discovered automatically via `seeds.js`.

Needs a real `LLM_PRESET`/`LLM_API_KEY` to be useful in a reasonable time — each attempt is up to
7 LLM calls, so the keyless `ovh` default (2 RPM) makes even a 15-jurisdiction budget slow (same
trade-off as the on-demand Netlify path). Runs on its own schedule via
`.github/workflows/discover-jurisdictions.yml`, decoupled from `scrape.yml`/`federal-social.yml`
the same way those two are decoupled from each other.

## Seed list

`config/seeds.json` covers **Central Texas** — 25 jurisdictions across the Austin metro and the
Hays / Caldwell / Bastrop / Williamson counties, including 5 county commissioners courts. This is
the hand-vetted core; `config/seeds.discovered.json` (see "Dynamic jurisdiction discovery" above)
grows the rest.

Counties use `level: "county"` with `city` set to `"<Name> County"` — the frontend's
`normalizePlace` strips the "County" suffix so it matches the geocoded county.

**Seed URLs are guesses until a run proves otherwise.** A first probe scored 4/26; its homepage
suggestions supplied corrections. The first real scrape then confirmed that **19 of 25
jurisdictions fetch successfully** — they failed only at the LLM step, because GitHub Models had
been retired. Current state:

| Fetch status | Jurisdictions |
| --- | --- |
| **Fetches OK** (19) | Austin, Leander, Travis County, Caldwell County, Bee Cave, Round Rock, Hutto, Kyle, Bastrop, Bastrop County, Wimberley, Lockhart, Taylor, Buda, Williamson County, Pflugerville, Manor, Hays County, Smithville |
| `HTTP 404` — needs a new URL | Lakeway, Cedar Park, San Marcos, Elgin |
| DNS failure — wrong domain | Georgetown (`georgetown.org` does not resolve) |
| Empty even after browser render | Dripping Springs |

A scrape run now prints `try:` URL suggestions for each failed page, so the six above can be
fixed from the next run's output without a separate probe.

Luling was removed: `www.lulingtx.org` does not resolve and the city's real domain is unknown.

**Workflow when a seed fails:** run `npm run probe`, read the `try:` suggestions it prints under
each failure, paste the right URL into `seeds.json`, repeat. Each round is free.

