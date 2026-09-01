import { Helmet } from 'react-helmet-async';

// Single source of truth for the site's absolute base URL.
//
// In production the Netlify build sets REACT_APP_SITE_URL to the deployed site URL (see the
// build command in netlify.toml, which forwards Netlify's own $URL). That means pointing the app
// at a real custom domain later is a zero-code change: Netlify updates $URL when the primary
// domain changes, and canonical/og:url follow automatically. At runtime we fall back to the
// current origin, so even with no env set the tags are correct on whatever host served the page.
export function siteUrl() {
  const fromEnv = process.env.REACT_APP_SITE_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    return window.location.origin;
  }
  return '';
}

const DEFAULT_IMAGE = '/logo512.png';
const SITE_NAME = 'Who Reps Me';

// Per-page <head> tags. Social scrapers (Slack, iMessage, Facebook, most of Twitter/X) do not run
// our JavaScript, so the *static* defaults in public/index.html are what they read on a cold link.
// This component layers the per-route title/description/canonical/JSON-LD on top for real browsers
// and for crawlers (Google) that do execute JS — which is every route the user actually navigates.
export default function Seo({
  title,
  description,
  path = '/',
  image = DEFAULT_IMAGE,
  noindex = false,
  jsonLd,
}) {
  const base = siteUrl();
  const url = base ? `${base}${path}` : path;
  const absImage = image && image.startsWith('http') ? image : `${base}${image}`;
  const fullTitle = title ? `${title} · ${SITE_NAME}` : SITE_NAME;
  const desc = description || 'Find everyone who represents you — federal, state, and local — from your address or ZIP.';

  return (
    <Helmet prioritizeSeoTags>
      <title>{fullTitle}</title>
      <meta name="description" content={desc} />
      <link rel="canonical" href={url} />
      {noindex ? <meta name="robots" content="noindex, follow" /> : null}

      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={desc} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={absImage} />

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={desc} />
      <meta name="twitter:image" content={absImage} />

      {jsonLd ? (
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      ) : null}
    </Helmet>
  );
}
