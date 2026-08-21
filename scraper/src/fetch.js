import { renderPage } from "./browser.js";

// Page fetching. Native fetch handles static/server-rendered gov pages, which is the
// majority and costs nothing. Two cases need a real browser: client-rendered rosters (fetch
// returns an almost-empty shell) and sites whose WAF answers non-browser requests with 403.
// For those we fall back to Playwright when it's available (see browser.js) — pass
// { allowBrowser: true }. Without Playwright installed the page is simply reported as
// needing a browser, exactly as before.

// Many municipal sites sit behind WAFs that reject unrecognized bot user-agents outright
// (a bare bot string 403s on most of them). We send a normal browser UA so ordinary public
// pages load, while still identifying the project and a contact address so site operators
// can reach us. Combined with sequential requests and a per-jurisdiction delay (run.js),
// this stays a polite, low-volume crawler of public records.
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 " +
  "(who-reps-me civic data; +https://github.com/pbezant/who-reps-me; preston@structuresense.ai)";

// Strip tags/scripts/styles down to visible text so we send the model signal, not markup.
// Keeps token cost low at nationwide scale.
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Statuses that usually mean "bot blocked" rather than "page missing" — worth a browser retry.
const WAF_STATUSES = new Set([403, 429, 503]);

async function fetchStatic(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
      redirect: "follow",
    });
    // `redirect: "follow"` above means fetch() already chased any 30x chain, but a Response
    // only tells you where it actually landed via res.url — the fetch() call still resolves
    // with whatever `url` string was passed in, not the post-redirect address, unless we read
    // it explicitly. Getting this right matters beyond diagnostics: callers use the returned
    // `url` to resolve relative links and check same-origin, and a stale pre-redirect value
    // makes both wrong. Confirmed concretely for Wayne County, MI: fetching
    // "https://www.waynecounty.com" actually lands on the unrelated domain
    // waynecountymi.gov, and code that trusted the requested url as the page's origin rejected
    // every genuinely-same-origin link on the real (rendered) page as "off-site" — see
    // discover.js's findRosterPage() for where that bit us. res.url costs nothing extra; the
    // Fetch API already computes it as part of following the redirect.
    if (!res.ok) {
      return { ok: false, url: res.url, status: res.status, error: `HTTP ${res.status}` };
    }
    const html = await res.text();
    const text = htmlToText(html);
    // Heuristic: very little text usually means a client-rendered SPA we couldn't read.
    const needsBrowser = text.length < 500;
    return { ok: true, url: res.url, status: res.status, html, text, needsBrowser };
  } catch (err) {
    // AbortError's own message ("This operation was aborted") hides the real cause, which is
    // almost always our own timeout on a slow municipal server.
    const error =
      err?.name === "AbortError" || /aborted/i.test(String(err?.message))
        ? `timeout after ${timeoutMs}ms`
        : String(err?.message || err);
    return { ok: false, url, status: null, error };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPage(url, { timeoutMs = 30000, allowBrowser = false } = {}) {
  const staticResult = await fetchStatic(url, timeoutMs);

  const blocked = !staticResult.ok && WAF_STATUSES.has(staticResult.status);
  const thin = staticResult.ok && staticResult.needsBrowser;
  if (!allowBrowser || (!blocked && !thin)) return staticResult;

  // Retry through a real browser: executes JS and gets past naive bot filters.
  const rendered = await renderPage(url, { timeoutMs: Math.max(timeoutMs, 30000) });
  if (!rendered.ok) {
    // Keep the original diagnosis, but note why the fallback didn't help.
    return { ...staticResult, browserError: rendered.error };
  }

  const text = htmlToText(rendered.html);
  if (text.length < 500) {
    return {
      ok: false,
      // rendered.url is the browser's post-navigation URL (see renderPage()'s own comment);
      // fall back to the requested url only for a renderPage() version too old to set it.
      url: rendered.url ?? url,
      status: rendered.status ?? staticResult.status,
      error: "needs-browser (empty even after browser render)",
      viaBrowser: true,
    };
  }
  return {
    ok: true,
    url: rendered.url ?? url,
    status: rendered.status ?? 200,
    html: rendered.html,
    text,
    needsBrowser: false,
    viaBrowser: true,
  };
}
