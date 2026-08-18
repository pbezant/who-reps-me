// Page fetching. Native fetch handles static/server-rendered gov pages, which is
// the majority. JS-heavy sites (SPAs) need a headless browser — that's a Playwright
// fallback we add in phase 2. For now we detect a suspiciously empty body and flag it
// so the pipeline can mark the jurisdiction for browser-based re-crawl later.

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

export async function fetchPage(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      return { ok: false, url, status: res.status, error: `HTTP ${res.status}` };
    }
    const html = await res.text();
    const text = htmlToText(html);
    // Heuristic: very little text usually means a client-rendered SPA we couldn't read.
    const needsBrowser = text.length < 500;
    return { ok: true, url, status: res.status, html, text, needsBrowser };
  } catch (err) {
    return { ok: false, url, status: null, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}
