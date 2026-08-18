// Optional headless-browser fallback for pages the plain fetch can't read: client-rendered
// rosters (fetch returns an empty shell) and sites whose WAF rejects non-browser requests
// with a 403.
//
// Playwright is NOT required. It is loaded lazily via dynamic import, so when it isn't
// installed the scraper behaves exactly as before and simply reports the page as
// "needs-browser". To enable:
//
//   cd scraper && npm install playwright && npx playwright install chromium
//
// One browser instance is shared across the whole run (launching Chromium per page is slow);
// call closeBrowser() when the run finishes.

let browserPromise = null;
let unavailableReason = null;

async function getBrowser() {
  if (unavailableReason) return null;
  if (browserPromise) return browserPromise;

  browserPromise = (async () => {
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      unavailableReason = "playwright is not installed (npm install playwright)";
      return null;
    }
    // Honor an explicit binary path — needed when the browsers live outside the default
    // download location (e.g. a preinstalled image with PLAYWRIGHT_BROWSERS_PATH).
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
    try {
      return await chromium.launch({
        headless: true,
        executablePath,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
    } catch (err) {
      unavailableReason = `chromium failed to launch: ${err.message} ` +
        `(try: npx playwright install chromium)`;
      return null;
    }
  })();

  return browserPromise;
}

// Returns { ok, html, error }. Never throws — callers fall back to the static result.
export async function renderPage(url, { timeoutMs = 30000 } = {}) {
  const browser = await getBrowser();
  if (!browser) return { ok: false, error: unavailableReason || "browser unavailable" };

  let context;
  try {
    context = await browser.newContext({
      // A real browser UA plus project attribution, matching fetch.js.
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 " +
        "(who-reps-me civic data; +https://github.com/pbezant/who-reps-me; preston@structuresense.ai)",
      viewport: { width: 1280, height: 1400 },
    });
    const page = await context.newPage();
    // Don't pull images/fonts/media — we only need the DOM text.
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") return route.abort();
      return route.continue();
    });

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    // Give client-side rendering a moment to populate the roster, but never hang the run.
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    const html = await page.content();
    const status = response?.status() ?? null;
    return { ok: true, html, status };
  } catch (err) {
    return { ok: false, error: `browser render failed: ${err.message}` };
  } finally {
    await context?.close().catch(() => {});
  }
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  await browser?.close().catch(() => {});
  browserPromise = null;
}

export function browserStatus() {
  return unavailableReason ? { available: false, reason: unavailableReason } : { available: true };
}
