#!/usr/bin/env node
/*
 * Build-time sitemap + robots generator.
 *
 * Runs as `postbuild` (see package.json), so `npm run build` writes build/sitemap.xml and a
 * build/robots.txt carrying an absolute Sitemap: line. It targets the built output rather than
 * public/, so the committed public/robots.txt stays clean and a local build leaves no churn.
 *
 * DOMAIN: the base URL is resolved from the environment, newest-domain-wins:
 *   REACT_APP_SITE_URL  — what we set ourselves (netlify.toml forwards Netlify's $URL here)
 *   URL / DEPLOY_PRIME_URL — Netlify's own build vars, in case the above isn't set
 *   http://localhost:3000  — local dev fallback
 * Pointing the app at a real custom domain is therefore a zero-code change: Netlify updates $URL
 * when the primary domain changes and this regenerates on the next deploy.
 *
 * SCOPE: the home page plus every local-official profile (/rep/<slug>) — the pages scripts/
 * prerender-officials.js writes as real, indexable HTML. Each official's <lastmod> is its own
 * extraction date, so an honest per-page freshness signal tells crawlers which pages to recrawl
 * after a nightly update. Federal/state /rep pages are deliberately excluded — they have no
 * id-addressable store, render a noindex fallback on a cold load, and would just be thin pages.
 */
const fs = require('fs');
const path = require('path');
const { buildSlugMap } = require('../src/officials');

const OFFICIALS_DIR = path.join(__dirname, '..', 'public', 'officials');

function siteUrl() {
  const raw =
    process.env.REACT_APP_SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function urlEntry({ loc, lastmod, changefreq, priority }) {
  const lines = [`    <loc>${xmlEscape(loc)}</loc>`, `    <lastmod>${lastmod}</lastmod>`];
  if (changefreq) lines.push(`    <changefreq>${changefreq}</changefreq>`);
  if (priority) lines.push(`    <priority>${priority}</priority>`);
  return `  <url>\n${lines.join('\n')}\n  </url>`;
}

// Every local-official page, one <url> each, with the official's own extraction date as lastmod.
// Reads the committed shards (same source the app and prerender use), so the sitemap can't list a
// URL the prerender didn't write. Returns { urls, count, collisions }.
function officialUrls(base, today) {
  if (!fs.existsSync(OFFICIALS_DIR)) return { urls: [], count: 0, collisions: 0 };
  const urls = [];
  let collisions = 0;
  for (const file of fs.readdirSync(OFFICIALS_DIR).filter((f) => f.endsWith('.json'))) {
    const shard = JSON.parse(fs.readFileSync(path.join(OFFICIALS_DIR, file), 'utf8'));
    const map = buildSlugMap(shard.officials || []);
    collisions += map.collisions;
    for (const { slug, official } of map.entries) {
      const lastmod = official.extracted_at ? String(official.extracted_at).slice(0, 10) : today;
      urls.push(urlEntry({ loc: `${base}/rep/${slug}`, lastmod }));
    }
  }
  return { urls, count: urls.length, collisions };
}

function buildSitemap(base) {
  const today = new Date().toISOString().slice(0, 10);
  const home = urlEntry({ loc: `${base}/`, lastmod: today, changefreq: 'weekly', priority: '1.0' });
  const officials = officialUrls(base, today);
  const body = [home, ...officials.urls].join('\n');
  return {
    xml:
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      `${body}\n` +
      `</urlset>\n`,
    count: officials.count + 1,
    collisions: officials.collisions,
  };
}

// Start from the committed public/robots.txt (crawl rules), strip any existing Sitemap: line, and
// append an absolute one for the current domain — the sitemaps spec wants an absolute URL, which
// we can't hardcode before the domain is known.
function robotsWithSitemap(base, publicDir) {
  const srcPath = path.join(publicDir, 'robots.txt');
  let body = fs.existsSync(srcPath)
    ? fs.readFileSync(srcPath, 'utf8')
    : '# https://www.robotstxt.org/robotstxt.html\nUser-agent: *\nDisallow:\n';
  body = body.replace(/^\s*Sitemap:.*$/gim, '').replace(/\s*$/, '\n');
  return `${body}Sitemap: ${base}/sitemap.xml\n`;
}

// The static tags in index.html are all CRA can produce at build time, and %PUBLIC_URL% leaves
// og:image as a root-relative "/logo512.png". Non-JS social scrapers (Slack, iMessage, Facebook)
// need an ABSOLUTE image URL and benefit from an absolute og:url + canonical, so patch those into
// build/index.html now that the domain is known. React-helmet-async (src/Seo.js) still overrides
// all of this at runtime for JS-capable crawlers.
function absolutizeHead(base, buildDir) {
  const htmlPath = path.join(buildDir, 'index.html');
  if (!fs.existsSync(htmlPath)) return;
  let html = fs.readFileSync(htmlPath, 'utf8');

  // Make any root-relative og:image / twitter:image absolute.
  html = html.replace(
    /(<meta\s+(?:property|name)="(?:og:image|twitter:image)"\s+content=")(\/[^"]*)(")/gi,
    (_m, pre, url, post) => `${pre}${base}${url}${post}`
  );

  // Add canonical + og:url for the home page if the static head doesn't already carry them.
  const inject = [];
  if (!/rel="canonical"/i.test(html)) inject.push(`<link rel="canonical" href="${base}/"/>`);
  if (!/property="og:url"/i.test(html)) inject.push(`<meta property="og:url" content="${base}/"/>`);
  if (inject.length) html = html.replace('</head>', `${inject.join('')}</head>`);

  fs.writeFileSync(htmlPath, html);
}

function main() {
  const base = siteUrl();
  const root = path.join(__dirname, '..');
  const buildDir = path.join(root, 'build');
  if (!fs.existsSync(buildDir)) {
    console.warn('[sitemap] build/ not found — run this via `npm run build` (postbuild). Skipping.');
    return;
  }
  const sitemap = buildSitemap(base);
  fs.writeFileSync(path.join(buildDir, 'sitemap.xml'), sitemap.xml);
  fs.writeFileSync(
    path.join(buildDir, 'robots.txt'),
    robotsWithSitemap(base, path.join(root, 'public'))
  );
  absolutizeHead(base, buildDir);
  console.log(
    `[sitemap] wrote build/sitemap.xml (${sitemap.count} urls) + robots.txt and absolutized head tags for ${base}` +
      (sitemap.collisions ? ` (${sitemap.collisions} slug collision(s) disambiguated)` : '')
  );
}

main();
