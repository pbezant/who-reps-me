# Who Reps Me?

Enter an address or ZIP and see everyone who represents you — federal, state, and local.

## Data sources

| Level | Source | Cost | Key |
| --- | --- | --- | --- |
| US House / Senate | [5calls](https://5calls.org/representatives-api/) | free | token in `src/App.js` |
| State legislators | [Open States v3](https://docs.openstates.org/api-v3/) `people.geo` | free | `OPENSTATES_API_KEY` (server-side) |
| State executives (Governor, Lt. Governor, AG, ...) | [Open States v3](https://docs.openstates.org/api-v3/) `/people?org_classification=executive` | free | `OPENSTATES_API_KEY` (server-side) |
| City / county officials | this repo's own scraper | free | see [`scraper/README.md`](scraper/README.md) |
| Geocoding | US Census Geocoder, with [Nominatim](https://nominatim.openstreetmap.org/) (OpenStreetMap) as a fallback for a bare "City, State" search | free | none |
| Recent news (profile page) | web search — reuses the scraper's own `webSearch()` (Brave by default, Tavily also supported — see [`scraper/README.md`](scraper/README.md)) | free tier | `SEARCH_API_KEY` (server-side) |
| Voting / legislative record — state legislators (profile page) | [Open States v3](https://docs.openstates.org/api-v3/) `/bills` (sponsor filter) | free | `OPENSTATES_API_KEY` (server-side) |
| Voting / legislative record — US House / Senate (profile page) | [Congress.gov API](https://api.congress.gov/) member sponsored/cosponsored legislation | free | `CONGRESS_API_KEY` (server-side) |

### Help us grow this map

A floating button (bottom-right, always visible) lets a visitor drop a link to where they saw a
missing or outdated official, plus a quick note. Each submission is triaged by an LLM on the
spot: it checks the note against currently-open `user-reported` issues to catch duplicates
(commenting on the existing issue instead of filing a new one), then either opens a new GitHub
issue or comments on the matching one, and appends a row to [`BUG_REPORTS.md`](BUG_REPORTS.md)
either way. A per-IP daily cap and an optional Cloudflare Turnstile bot check guard the fact that
this is the one form in the project that creates real public content from anonymous input; see
`netlify/functions/report-bug.mjs`'s own header comment for the full flow, the abuse-mitigation
reasoning, and required `GITHUB_TOKEN`/`TURNSTILE_SECRET_KEY` setup.

A submitted link doesn't stop at filing an issue: `scraper/scripts/scrape-reported-links.js` (run
daily, or on demand via the `.github/workflows/scrape-link.yml` Actions workflow) fetches it,
extracts whatever officials are on the page, and — for a confident, government-sourced,
jurisdiction-resolved find — opens a pull request adding them to the map. That PR never
auto-merges; a human always reviews and merges it by hand. See
[`scraper/README.md`](scraper/README.md)'s "Reported-link scraping" section for the full pipeline.

### Why geocoding needs a fallback at all

The Census Geocoder's `onelineaddress` endpoint is an address-**range** matcher — it needs an
actual street address and returns zero matches for a bare city name or ZIP code alone, even
though the search box invites "address or zip code" (confirmed directly: `address=78640` alone
returns `addressMatches: []`; the same is true for a bare "Durango, CO"). `src/geocode.js` already
has a dedicated fallback for a bare ZIP (via [zippopotam.us](https://zippopotam.us/)); a bare
"City, State" (or "County, State") query is resolved the same way, via Nominatim for approximate
coordinates and then the Census coordinates endpoint for the authoritative county/place/district
data — see `geocodeByPlaceName()`'s own header comment in that file for the full reasoning
(including the observed symptom: without this fallback, a bare-city search silently degrades to
federal-only results, since 5calls geocodes the raw search text itself and doesn't depend on this
module, while local officials and state legislators both do).

### Why state legislators don't come from 5calls

5calls returns state legislators, but it geocodes the location **string** we send it. State
legislative districts are much smaller than a ZIP code, so a ZIP-only search often resolves to a
congressional district and no state ones — 5calls flags this as `lowAccuracy`. Open States takes
a **lat/lng** instead and does a real point-in-polygon lookup, and `src/geocode.js` already gets
those coordinates from the Census geocoder on every search.

So both are used: 5calls for Congress, Open States for the statehouse. If Open States is
unconfigured or returns nothing, whatever state reps 5calls found are kept as-is — the app never
ends up with fewer reps than before.

### State executives (Governor, Lt. Governor, Attorney General, ...)

5calls doesn't return these at all (it's federal-only), and neither does `people.geo` — that
endpoint's own docs say so explicitly: "Currently limited to state legislators and US Congress.
Governors & mayors are not included." (a statewide office has no district geometry for a
point-in-polygon lookup to match against). `src/stateExecutives.js` instead queries Open States'
general `/people` endpoint, filtered to `org_classification=executive` and cached **per state**
rather than per coordinate, since every address in a state has the same Governor.

**Coverage is curated, not comprehensive, and varies by state.** Checked directly against Open
States' source data: Texas has exactly four executive officials on file — Governor, Lieutenant
Governor, Attorney General, Secretary of State — no Comptroller, no Land/Agriculture
Commissioner, and no Railroad Commissioner (an elected regulatory body outside what this dataset
models at all). Most states have 3-4; a few have as many as 6-7. This app shows whatever a state
has rather than assuming every state has the same set of offices.

## Representative profile pages: news and voting record

Clicking "View full profile" on a card opens `/rep/:id` (`src/RepProfile.js`) — the full detail
that used to be crammed into one long results-list card, plus two sections a dedicated page
finally had room for:

- **Recent news** (`netlify/functions/rep-news.mjs`) — a web search for the rep's name plus
  enough office/state context to disambiguate a common name, reusing the scraper's own
  provider-agnostic `webSearch()` (`scraper/src/search.js`) server-side. Same `SEARCH_API_KEY`/
  `SEARCH_PRESET` as the scraper's discovery fallback; unset, this section just says news search
  isn't set up. Requests Tavily's `topic: "news"` mode when that preset is active (a no-op on
  Brave/Google) — see `scraper/README.md`'s "Search fallback" table for why Tavily is worth
  considering over Brave: a free tier with no credit card required, and a search mode built for
  exactly this "recent news about a person" case.
- **Voting / legislative record** (`netlify/functions/state-votes.mjs`,
  `netlify/functions/federal-votes.mjs`) — recent bill sponsorship/cosponsorship, not true
  roll-call yes/no vote history: neither Open States nor Congress.gov exposes a clean per-member
  vote-history endpoint for this (ProPublica's Congress API, which historically did, was
  discontinued). Only available for state legislators and members of Congress — local officials'
  votes generally aren't published anywhere scrapable, and state executives (Governor, AG, ...)
  don't sponsor legislation the way lawmakers do, so both show a static "not available" message
  with no network request made at all.

**v1 is same-session only**: the rep object is handed to the profile route via React Router
`state` (see the "View full profile" `Link` in `src/RepCard.js`), not looked up by id — there is
no static, id-addressable store for federal/state reps to re-fetch from on a cold visit (only
local officials have one, the committed per-state shards). A hard refresh, a bookmarked link, or
typing the URL directly shows a "go back and search again" fallback instead of a fresh lookup —
see `src/RepProfile.js`'s own header comment.

## Configuration

The app runs without any setup; each key only improves one layer.

```
OPENSTATES_API_KEY=...   # free key from https://open.pluralpolicy.com/ — state legislators +
                          # executives + their voting/legislative-activity section
SEARCH_API_KEY=...       # free key from the SEARCH_PRESET provider (brave by default, tavily
                          # also supported — see scraper/README.md's "Search fallback" table) —
                          # on-demand jurisdiction discovery's search fallback + the profile
                          # page's "recent news" section
SEARCH_PRESET=tavily     # optional, only if not using the brave default
CONGRESS_API_KEY=...     # free key from https://api.congress.gov/sign-up/ — federal reps'
                          # voting/legislative-activity section on the profile page
LLM_PRESET=groq          # on-demand local scraping (see scraper/README.md) + bug-report triage
LLM_API_KEY=...
GITHUB_TOKEN=...         # bug-report triage (netlify/functions/report-bug.mjs) — needs Issues:write
                          # + Contents:write on this repo (fine-grained PAT), or classic `repo` scope
GITHUB_OWNER=pbezant     # only needed if forking — defaults to pbezant/who-reps-me
GITHUB_REPO=who-reps-me
TURNSTILE_SECRET_KEY=... # optional, and NOT currently enabled — wiring is in place but a live
                          # 400 from Cloudflare's challenge endpoint is unresolved; see
                          # netlify/functions/report-bug.mjs's header for what's already ruled out.
                          # Cloudflare Turnstile bot check on the bug-report form.
                          # Unset = verification is skipped entirely (soft-fail-open, not a
                          # security guarantee — set this before relying on it as real abuse
                          # protection). Free from a Cloudflare account: dash.cloudflare.com →
                          # Turnstile → Add site → get a sitekey + secret key pair.
```

Set these in the Netlify site's *Site configuration → Environment variables*, **except**
`REACT_APP_TURNSTILE_SITE_KEY` (Turnstile's public sitekey, paired with `TURNSTILE_SECRET_KEY`
above) — that one is a **build-time** variable: Create React App inlines any `REACT_APP_*`
variable into the JS bundle when the site is built, so it must be set wherever the build runs
(Netlify's *Site configuration → Build & deploy → Environment*, not just the general Environment
variables page most other keys here use — Netlify's UI does distinguish these, but it's an easy
place to set the wrong one and see no effect). `OPENSTATES_API_KEY`
is read only by `netlify/functions/state-legislators.mjs`, `netlify/functions/state-executives.mjs`,
and `netlify/functions/state-votes.mjs` — never by the browser: Open States keys carry a
per-account daily quota, and v3 doesn't serve CORS for browser requests anyway. Legislator
lookups are cached in Netlify Blobs for 30 days (per coordinate) to stay well inside that quota;
executive lookups for 90 days (per state — a much smaller, much slower-changing dataset, so a
longer window is safe); voting-record lookups for 24 hours (legislative activity changes weekly,
not monthly, so this deliberately does not reuse either of those longer TTLs).

`SEARCH_API_KEY` and `CONGRESS_API_KEY` are likewise read only server-side, by
`netlify/functions/rep-news.mjs` and `netlify/functions/federal-votes.mjs` respectively, each
cached in Netlify Blobs — news for 12 hours (it changes daily; a longer window would show stale
headlines), federal voting/legislative activity for 24 hours (same reasoning as the state-votes
cache above). Both are additive: unset, the corresponding profile-page section just says it isn't
available yet, exactly like every other optional key in this app.

## Tests

```bash
npm test            # frontend (jest)
cd scraper && npm test
```

---

# Getting Started with Create React App

This project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).

## Available Scripts

In the project directory, you can run:

### `npm start`

Runs the app in the development mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in your browser.

The page will reload when you make changes.\
You may also see any lint errors in the console.

### `npm test`

Launches the test runner in the interactive watch mode.\
See the section about [running tests](https://facebook.github.io/create-react-app/docs/running-tests) for more information.

### `npm run build`

Builds the app for production to the `build` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.\
Your app is ready to be deployed!

See the section about [deployment](https://facebook.github.io/create-react-app/docs/deployment) for more information.

### `npm run eject`

**Note: this is a one-way operation. Once you `eject`, you can't go back!**

If you aren't satisfied with the build tool and configuration choices, you can `eject` at any time. This command will remove the single build dependency from your project.

Instead, it will copy all the configuration files and the transitive dependencies (webpack, Babel, ESLint, etc) right into your project so you have full control over them. All of the commands except `eject` will still work, but they will point to the copied scripts so you can tweak them. At this point you're on your own.

You don't have to ever use `eject`. The curated feature set is suitable for small and middle deployments, and you shouldn't feel obligated to use this feature. However we understand that this tool wouldn't be useful if you couldn't customize it when you are ready for it.

## Learn More

You can learn more in the [Create React App documentation](https://facebook.github.io/create-react-app/docs/getting-started).

To learn React, check out the [React documentation](https://reactjs.org/).

### Code Splitting

This section has moved here: [https://facebook.github.io/create-react-app/docs/code-splitting](https://facebook.github.io/create-react-app/docs/code-splitting)

### Analyzing the Bundle Size

This section has moved here: [https://facebook.github.io/create-react-app/docs/analyzing-the-bundle-size](https://facebook.github.io/create-react-app/docs/analyzing-the-bundle-size)

### Making a Progressive Web App

This section has moved here: [https://facebook.github.io/create-react-app/docs/making-a-progressive-web-app](https://facebook.github.io/create-react-app/docs/making-a-progressive-web-app)

### Advanced Configuration

This section has moved here: [https://facebook.github.io/create-react-app/docs/advanced-configuration](https://facebook.github.io/create-react-app/docs/advanced-configuration)

### Deployment

This section has moved here: [https://facebook.github.io/create-react-app/docs/deployment](https://facebook.github.io/create-react-app/docs/deployment)

### `npm run build` fails to minify

This section has moved here: [https://facebook.github.io/create-react-app/docs/troubleshooting#npm-run-build-fails-to-minify](https://facebook.github.io/create-react-app/docs/troubleshooting#npm-run-build-fails-to-minify)
