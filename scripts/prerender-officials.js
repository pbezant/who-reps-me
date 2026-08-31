#!/usr/bin/env node
/*
 * Prerender one static HTML page per local official into build/rep/<slug>/index.html.
 *
 * Runs as part of `postbuild` (before generate-sitemap.js). Create React App can't server-render,
 * so a cold crawl of /rep/<slug> would otherwise get an empty #root. This writes a real, crawlable
 * page for every official in public/officials/*.json:
 *   - per-page <title>, description, canonical, Open Graph/Twitter, and Person JSON-LD in <head>
 *     (tagged data-rh so react-helmet-async cleanly replaces them once the app mounts);
 *   - a semantic HTML body inside #root so non-JS crawlers read the actual content;
 *   - window.__REP__ with the record inlined, so the React app's first client render already has
 *     the data (src/RepProfile.js reads it) instead of re-fetching the shard.
 * The app then client-renders over #root — no hydration, so the simplified static body never has
 * to match React's tree exactly.
 *
 * The id<->slug mapping and the record->card mapping come from src/officials.js, the same module
 * the app and the sitemap use, so URLs and data can't drift between them.
 */
const fs = require('fs');
const path = require('path');
const { toRepCard, buildSlugMap } = require('../src/officials');

const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const OFFICIALS_DIR = path.join(ROOT, 'public', 'officials');

function siteUrl() {
  const raw =
    process.env.REACT_APP_SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}

// Escape for HTML text/attribute content.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Escape a JSON string for safe embedding inside a <script> element: neutralize </script> and
// HTML-comment sequences, and the two Unicode line terminators that are valid in JSON strings but
// break JS string literals.
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function officeLine(rep) {
  return [rep.area, rep.district].filter(Boolean).join(' — ');
}

// The crawlable body — a semantic subset of src/RepProfile.js's render. The React app replaces it
// on mount, so this is for crawlers and the pre-JS paint, not visual fidelity.
function renderBody(rep) {
  const office = officeLine(rep);
  const parts = [];
  parts.push('<main class="rep-profile">');
  parts.push('<a href="/">&larr; Back to search</a>');
  parts.push(`<h1>${esc(rep.name)}</h1>`);
  if (office) parts.push(`<p>${esc(office)}</p>`);
  if (rep.body) parts.push(`<p>${esc(rep.body)}</p>`);
  if (rep.party) parts.push(`<p>${esc(rep.party)}</p>`);

  const contact = [];
  if (rep.phone) contact.push(`<li>Phone: <a href="tel:${esc(rep.phone)}">${esc(rep.phone)}</a></li>`);
  if (rep.email) contact.push(`<li>Email: <a href="mailto:${esc(rep.email)}">${esc(rep.email)}</a></li>`);
  if (rep.url) contact.push(`<li>Website: <a href="${esc(rep.url)}" rel="noreferrer noopener">${esc(rep.url)}</a></li>`);
  if (rep.address) contact.push(`<li>Office: ${esc(rep.address)}${rep.hours ? ` (${esc(rep.hours)})` : ''}</li>`);
  if (contact.length) {
    parts.push('<h2>Contact</h2>');
    parts.push(`<ul>${contact.join('')}</ul>`);
  }

  if (rep.bio) parts.push(`<h2>About</h2><p>${esc(rep.bio)}</p>`);
  if (rep.verifiedAt) {
    const src = rep.sourceUrl
      ? ` &middot; <a href="${esc(rep.sourceUrl)}" rel="noreferrer noopener">source</a>`
      : '';
    parts.push(`<p>Verified ${esc(String(rep.verifiedAt).slice(0, 10))}${src}</p>`);
  }
  parts.push('</main>');
  return parts.join('');
}

// The built index.html carries generic site-level title/description/OG/Twitter/canonical (from
// public/index.html + generate-sitemap.js's absolutizer). Strip those so each prerendered page
// has exactly one, per-page set — otherwise a crawler reading the raw HTML sees the generic
// "Who Reps Me" title first. The WebSite JSON-LD, icons, and analytics are left untouched.
function stripHeadTags(html) {
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta[^>]*name="description"[^>]*>/gi, '')
    .replace(/<meta[^>]*property="og:[^"]*"[^>]*>/gi, '')
    .replace(/<meta[^>]*name="twitter:[^"]*"[^>]*>/gi, '')
    .replace(/<link[^>]*rel="canonical"[^>]*>/gi, '');
}

function personJsonLd(rep) {
  const obj = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: rep.name,
    jobTitle: officeLine(rep) || undefined,
    image: rep.photoURL || undefined,
    url: rep.url || undefined,
    telephone: rep.phone || undefined,
    email: rep.email || undefined,
    affiliation: rep.party ? { '@type': 'Organization', name: rep.party } : undefined,
  };
  return obj;
}

function renderHead(rep, base, slug) {
  const canonicalUrl = `${base}/rep/${slug}`;
  const office = officeLine(rep);
  const title = `${rep.name}${office ? ` · ${office}` : ''} · Who Reps Me`;
  const description = `Contact details, offices, recent news, and legislative record for ${rep.name}${office ? `, ${office}` : ''}.`;
  const image = rep.photoURL && rep.photoURL.startsWith('http') ? rep.photoURL : `${base}/logo512.png`;
  const tags = [
    `<title data-rh="true">${esc(title)}</title>`,
    `<meta data-rh="true" name="description" content="${esc(description)}">`,
    `<link data-rh="true" rel="canonical" href="${esc(canonicalUrl)}">`,
    `<meta data-rh="true" property="og:type" content="profile">`,
    `<meta data-rh="true" property="og:site_name" content="Who Reps Me">`,
    `<meta data-rh="true" property="og:title" content="${esc(title)}">`,
    `<meta data-rh="true" property="og:description" content="${esc(description)}">`,
    `<meta data-rh="true" property="og:url" content="${esc(canonicalUrl)}">`,
    `<meta data-rh="true" property="og:image" content="${esc(image)}">`,
    `<meta data-rh="true" name="twitter:card" content="summary_large_image">`,
    `<meta data-rh="true" name="twitter:title" content="${esc(title)}">`,
    `<meta data-rh="true" name="twitter:description" content="${esc(description)}">`,
    `<meta data-rh="true" name="twitter:image" content="${esc(image)}">`,
    `<script data-rh="true" type="application/ld+json">${jsonForScript(personJsonLd(rep))}</script>`,
    `<script>window.__REP__=${jsonForScript(rep)}</script>`,
  ];
  return tags.join('');
}

function main() {
  if (!fs.existsSync(BUILD_DIR) || !fs.existsSync(path.join(BUILD_DIR, 'index.html'))) {
    console.warn('[prerender] build/index.html not found — run via `npm run build` (postbuild). Skipping.');
    return;
  }
  if (!fs.existsSync(OFFICIALS_DIR)) {
    console.warn('[prerender] public/officials not found. Skipping.');
    return;
  }

  const template = stripHeadTags(fs.readFileSync(path.join(BUILD_DIR, 'index.html'), 'utf8'));
  const base = siteUrl();
  const shardFiles = fs.readdirSync(OFFICIALS_DIR).filter((f) => f.endsWith('.json'));

  let written = 0;
  let totalCollisions = 0;
  for (const file of shardFiles) {
    const state = file.replace(/\.json$/, '');
    const shard = JSON.parse(fs.readFileSync(path.join(OFFICIALS_DIR, file), 'utf8'));
    const { entries, collisions } = buildSlugMap(shard.officials || []);
    totalCollisions += collisions;

    for (const { slug, official } of entries) {
      const rep = toRepCard(official, state);
      const html = template
        .replace('</head>', `${renderHead(rep, base, slug)}</head>`)
        .replace('<div id="root"></div>', `<div id="root">${renderBody(rep)}</div>`);

      const outDir = path.join(BUILD_DIR, 'rep', slug);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'index.html'), html);
      written += 1;
    }
  }

  console.log(
    `[prerender] wrote ${written} official pages under build/rep/ for ${base}` +
      (totalCollisions ? ` (${totalCollisions} slug collision(s) disambiguated)` : '')
  );
}

main();
