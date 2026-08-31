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
 * SCOPE — why only `/` is listed today: the /rep/:id profile pages render real content only when
 * reached in-session (the rep object arrives via router state; see src/RepProfile.js). A cold
 * crawl of /rep/:id hits the "search again" fallback, which we mark noindex. Listing those URLs
 * would just advertise thin pages. When deep-linking gains a static id->rep lookup (the local
 * officials in public/officials/*.json are already id-addressable), add them to ROUTES below and
 * they will flow straight into the sitemap.
 */
const fs = require('fs');
const path = require('path');

function siteUrl() {
  const raw =
    process.env.REACT_APP_SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}

// Static, cold-crawlable routes. `path` is appended to the base URL; `changefreq`/`priority` are
// hints only.
const ROUTES = [{ path: '/', changefreq: 'weekly', priority: '1.0' }];

function buildSitemap(base) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = ROUTES.map(
    (r) =>
      `  <url>\n` +
      `    <loc>${base}${r.path}</loc>\n` +
      `    <lastmod>${today}</lastmod>\n` +
      `    <changefreq>${r.changefreq}</changefreq>\n` +
      `    <priority>${r.priority}</priority>\n` +
      `  </url>`
  ).join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${urls}\n` +
    `</urlset>\n`
  );
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
  fs.writeFileSync(path.join(buildDir, 'sitemap.xml'), buildSitemap(base));
  fs.writeFileSync(
    path.join(buildDir, 'robots.txt'),
    robotsWithSitemap(base, path.join(root, 'public'))
  );
  absolutizeHead(base, buildDir);
  console.log(`[sitemap] wrote build/sitemap.xml + robots.txt and absolutized head tags for ${base}`);
}

main();
