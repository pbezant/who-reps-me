# Who Reps Me?

Enter an address or ZIP and see everyone who represents you — federal, state, and local.

## Data sources

| Level | Source | Cost | Key |
| --- | --- | --- | --- |
| US House / Senate | [5calls](https://5calls.org/representatives-api/) | free | token in `src/App.js` |
| State legislators | [Open States v3](https://docs.openstates.org/api-v3/) `people.geo` | free | `OPENSTATES_API_KEY` (server-side) |
| City / county officials | this repo's own scraper | free | see [`scraper/README.md`](scraper/README.md) |
| Geocoding | US Census Geocoder | free | none |

### Why state legislators don't come from 5calls

5calls returns state legislators, but it geocodes the location **string** we send it. State
legislative districts are much smaller than a ZIP code, so a ZIP-only search often resolves to a
congressional district and no state ones — 5calls flags this as `lowAccuracy`. Open States takes
a **lat/lng** instead and does a real point-in-polygon lookup, and `src/geocode.js` already gets
those coordinates from the Census geocoder on every search.

So both are used: 5calls for Congress, Open States for the statehouse. If Open States is
unconfigured or returns nothing, whatever state reps 5calls found are kept as-is — the app never
ends up with fewer reps than before.

## Configuration

The app runs without any setup; each key only improves one layer.

```
OPENSTATES_API_KEY=...   # free key from https://open.pluralpolicy.com/ — state legislators
LLM_PRESET=groq          # on-demand local scraping (see scraper/README.md)
LLM_API_KEY=...
```

Set these in the Netlify site's *Site configuration → Environment variables*. `OPENSTATES_API_KEY`
is read only by `netlify/functions/state-legislators.mjs` and never reaches the browser: Open
States keys carry a per-account daily quota, and v3 doesn't serve CORS for browser requests
anyway. Coordinate lookups are cached in Netlify Blobs for 30 days to stay well inside that quota.

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
