import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSearchConfig, parseBraveResults, parseGoogleResults, parseTavilyResults, pickResultImage } from "./search.js";

// Snapshot/restore the handful of env vars resolveSearchConfig() reads, so a test that sets one
// can't leak into the next test in this file (node:test runs a file's tests in one process).
function withEnv(vars, fn) {
  const prev = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

// Cleared for every test below: a stray real key in the ambient environment (a developer with
// BRAVE_API_KEY exported, say) would otherwise satisfy an assertion that's checking the *absence*
// of a key.
const CLEARED = {
  SEARCH_PRESET: undefined,
  SEARCH_PRESET_NEWS: undefined,
  SEARCH_API_KEY: undefined,
  SEARCH_CX: undefined,
  BRAVE_API_KEY: undefined,
  TAVILY_API_KEY: undefined,
  GOOGLE_API_KEY: undefined,
};

test("resolveSearchConfig() defaults to the brave preset with no key set", () => {
  withEnv(CLEARED, () => {
    const cfg = resolveSearchConfig();
    assert.equal(cfg.presetName, "brave");
    assert.equal(cfg.apiKey, "");
  });
});

test("resolveSearchConfig() reads SEARCH_PRESET/SEARCH_API_KEY/SEARCH_CX", () => {
  withEnv({ ...CLEARED, SEARCH_PRESET: "google", SEARCH_API_KEY: "test-key", SEARCH_CX: "test-cx" }, () => {
    const cfg = resolveSearchConfig();
    assert.equal(cfg.presetName, "google");
    assert.equal(cfg.apiKey, "test-key");
    assert.equal(cfg.cx, "test-cx");
  });
});

test("resolveSearchConfig() accepts the tavily preset", () => {
  withEnv({ ...CLEARED, SEARCH_PRESET: "tavily", SEARCH_API_KEY: "tvly-test" }, () => {
    const cfg = resolveSearchConfig();
    assert.equal(cfg.presetName, "tavily");
    assert.equal(cfg.apiKey, "tvly-test");
  });
});

test("resolveSearchConfig() throws a clear error on an unknown preset", () => {
  withEnv({ ...CLEARED, SEARCH_PRESET: "yahoo" }, () => {
    assert.throws(() => resolveSearchConfig(), /Unknown SEARCH_PRESET "yahoo"/);
  });
});

// The two-provider split this project actually runs: brave for jurisdiction/roster discovery
// (it indexes the general web and honors findRosterPage()'s `site:` operators), tavily for the
// profile page's news section (first-class news topic). See search.js's header comment.
test("resolveSearchConfig() routes topic:news to SEARCH_PRESET_NEWS and its own key", () => {
  withEnv(
    { ...CLEARED, SEARCH_PRESET: "brave", SEARCH_PRESET_NEWS: "tavily", BRAVE_API_KEY: "bsa-test", TAVILY_API_KEY: "tvly-test" },
    () => {
      const news = resolveSearchConfig({ topic: "news" });
      assert.equal(news.presetName, "tavily");
      assert.equal(news.apiKey, "tvly-test");

      const general = resolveSearchConfig();
      assert.equal(general.presetName, "brave");
      assert.equal(general.apiKey, "bsa-test");
    }
  );
});

// Back-compat: a deployment that only ever set SEARCH_API_KEY must keep behaving exactly as it
// did before routing existed — one provider, one key, news included. SEARCH_PRESET_NEWS falls
// back to SEARCH_PRESET rather than defaulting to tavily precisely so this holds.
test("resolveSearchConfig() leaves a single-key setup unrouted, news included", () => {
  withEnv({ ...CLEARED, SEARCH_PRESET: "brave", SEARCH_API_KEY: "one-key" }, () => {
    for (const cfg of [resolveSearchConfig(), resolveSearchConfig({ topic: "news" })]) {
      assert.equal(cfg.presetName, "brave");
      assert.equal(cfg.apiKey, "one-key");
    }
  });
});

// A non-news topic must not pick up the news override — only "news" routes.
test("resolveSearchConfig() ignores SEARCH_PRESET_NEWS for a non-news topic", () => {
  withEnv({ ...CLEARED, SEARCH_PRESET: "brave", SEARCH_PRESET_NEWS: "tavily", SEARCH_API_KEY: "k" }, () => {
    assert.equal(resolveSearchConfig({ topic: "finance" }).presetName, "brave");
  });
});

// <PRESET>_API_KEY wins over SEARCH_API_KEY, so adding a second provider never requires moving
// the first one's key out of the var it's already in.
test("resolveSearchConfig() prefers <PRESET>_API_KEY over SEARCH_API_KEY", () => {
  withEnv({ ...CLEARED, SEARCH_PRESET: "brave", BRAVE_API_KEY: "specific", SEARCH_API_KEY: "shared" }, () => {
    assert.equal(resolveSearchConfig().apiKey, "specific");
  });
});

test("resolveSearchConfig() names SEARCH_PRESET_NEWS in the error when the bad preset came from it", () => {
  withEnv({ ...CLEARED, SEARCH_PRESET: "brave", SEARCH_PRESET_NEWS: "yahoo" }, () => {
    assert.throws(() => resolveSearchConfig({ topic: "news" }), /Unknown SEARCH_PRESET_NEWS "yahoo"/);
    // The general path is still fine — a broken news preset must not break discovery.
    assert.equal(resolveSearchConfig().presetName, "brave");
  });
});

test("parseBraveResults() maps the API shape to {title, url, snippet}", () => {
  const data = {
    web: {
      results: [{ title: "City of Example", url: "https://cityofexample.gov", description: "Official site" }],
    },
  };
  assert.deepEqual(parseBraveResults(data), [
    { title: "City of Example", url: "https://cityofexample.gov", snippet: "Official site", image: "", favicon: "", score: null, publishedAt: "" },
  ]);
});

test("parseBraveResults() drops a result with no url and tolerates a missing web.results", () => {
  assert.deepEqual(parseBraveResults({ web: { results: [{ title: "no url" }] } }), []);
  assert.deepEqual(parseBraveResults({}), []);
  assert.deepEqual(parseBraveResults(null), []);
});

test("parseGoogleResults() maps the Custom Search JSON shape to {title, url, snippet}", () => {
  const data = { items: [{ title: "City of Example", link: "https://cityofexample.gov", snippet: "Official site" }] };
  assert.deepEqual(parseGoogleResults(data), [
    { title: "City of Example", url: "https://cityofexample.gov", snippet: "Official site" },
  ]);
});

test("parseGoogleResults() drops a result with no link and tolerates a missing items list", () => {
  assert.deepEqual(parseGoogleResults({ items: [{ title: "no link" }] }), []);
  assert.deepEqual(parseGoogleResults({}), []);
  assert.deepEqual(parseGoogleResults(null), []);
});

test("parseTavilyResults() maps the API shape to {title, url, snippet}, using `content` as the snippet", () => {
  const data = { results: [{ title: "City of Example", url: "https://cityofexample.gov", content: "Official site" }] };
  assert.deepEqual(parseTavilyResults(data), [
    { title: "City of Example", url: "https://cityofexample.gov", snippet: "Official site", image: "", favicon: "", score: null, publishedAt: "" },
  ]);
});

test("parseTavilyResults() drops a result with no url and tolerates a missing results list", () => {
  assert.deepEqual(parseTavilyResults({ results: [{ title: "no url" }] }), []);
  assert.deepEqual(parseTavilyResults({}), []);
  assert.deepEqual(parseTavilyResults(null), []);
});

// Fixtures below are abridged from a real Tavily `topic: "news"` response (include_images +
// include_favicon) for a Texas House member — the exact mix of editorial photo and page furniture
// that pickResultImage() exists to tell apart.
test("pickResultImage() takes a real article image even with no file extension", () => {
  assert.equal(
    pickResultImage([
      "https://i.insider.com/68f7a9cf1c1f80efbec5f739?width=700",
      "https://www.businessinsider.com/public/assets/logos/placeholder.png",
    ]),
    "https://i.insider.com/68f7a9cf1c1f80efbec5f739?width=700"
  );
});

test("pickResultImage() rejects a page full of interface furniture rather than picking one", () => {
  assert.equal(
    pickResultImage([
      "https://news-cdn.bindg.com/indg/assets/icons/icon-search-white.svg",
      "https://news-cdn.bindg.com/indg/assets/news/images/logo-law-inline-white.svg",
      "https://news-cdn.bindg.com/indg/images/26_AUTO_icon-X-black.webp",
      "https://www.businessinsider.com/public/assets/badges/app-store-badge.svg",
      "https://www.businessinsider.com/public/assets/badges/google-play-badge.svg",
    ]),
    ""
  );
});

test("pickResultImage() skips an author thumbnail sized into the URL", () => {
  assert.equal(
    pickResultImage(["https://bwrite-static.bloombergindustry.com/dims4/default/a21f901/legacy_thumbnail/80x80%3E/quality/90/x.jpg"]),
    ""
  );
});

test("pickResultImage() keeps a large image whose dimensions are in the URL", () => {
  const url = "https://cdn.example.com/photos/1200x800/story.jpg";
  assert.equal(pickResultImage([url]), url);
});

test("pickResultImage() tolerates a missing, empty, or malformed list", () => {
  assert.equal(pickResultImage(undefined), "");
  assert.equal(pickResultImage([]), "");
  assert.equal(pickResultImage([null, 42, ""]), "");
});

test("parseTavilyResults() carries through one filtered image and the favicon", () => {
  const [r] = parseTavilyResults({
    results: [
      {
        url: "https://www.businessinsider.com/story",
        title: "A story",
        content: "Body text",
        images: ["https://www.businessinsider.com/public/assets/logos/stacked-black.svg", "https://i.insider.com/abc?width=700"],
        favicon: "https://www.businessinsider.com/public/assets/BI/US/favicons/apple-touch-icon-72x72.png",
      },
    ],
  });
  assert.equal(r.image, "https://i.insider.com/abc?width=700");
  assert.equal(r.favicon, "https://www.businessinsider.com/public/assets/BI/US/favicons/apple-touch-icon-72x72.png");
});

test("parseTavilyResults() yields empty media fields when the caller didn't request them", () => {
  const [r] = parseTavilyResults({ results: [{ url: "https://example.com/a", title: "T", content: "C" }] });
  assert.equal(r.image, "");
  assert.equal(r.favicon, "");
});

test("parseBraveResults() carries through brave's own per-result thumbnail", () => {
  const [r] = parseBraveResults({
    web: { results: [{ title: "T", url: "https://example.com/a", description: "D", thumbnail: { src: "https://img.example/t.jpg" } }] },
  });
  assert.equal(r.image, "https://img.example/t.jpg");
});
