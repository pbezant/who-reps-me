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

### Help us grow this map

A floating button (bottom-right, always visible) lets a visitor drop a link to where they saw a
missing or outdated official, plus a quick note. Each submission is triaged by an LLM on the
spot: it checks the note against currently-open `user-reported` issues to catch duplicates
(commenting on the existing issue instead of filing a new one), then either opens a new GitHub
issue or comments on the matching one, and appends a row to [`BUG_REPORTS.md`](BUG_REPORTS.md)
either way. This files the report for a human to review — it doesn't itself trigger a scrape; see
`netlify/functions/report-bug.mjs`'s own header comment for the full flow and required
`GITHUB_TOKEN` setup.

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

## Configuration

The app runs without any setup; each key only improves one layer.

```
OPENSTATES_API_KEY=...   # free key from https://open.pluralpolicy.com/ — state legislators + executives
LLM_PRESET=groq          # on-demand local scraping (see scraper/README.md) + bug-report triage
LLM_API_KEY=...
GITHUB_TOKEN=...         # bug-report triage (netlify/functions/report-bug.mjs) — needs Issues:write
                          # + Contents:write on this repo (fine-grained PAT), or classic `repo` scope
GITHUB_OWNER=pbezant     # only needed if forking — defaults to pbezant/who-reps-me
GITHUB_REPO=who-reps-me
```

Set these in the Netlify site's *Site configuration → Environment variables*. `OPENSTATES_API_KEY`
is read only by `netlify/functions/state-legislators.mjs` and `netlify/functions/state-executives.mjs`
— never by the browser: Open States keys carry a per-account daily quota, and v3 doesn't serve
CORS for browser requests anyway. Legislator lookups are cached in Netlify Blobs for 30 days
(per coordinate) to stay well inside that quota; executive lookups for 90 days (per state — a
much smaller, much slower-changing dataset, so a longer window is safe).

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
