import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSearchConfig, parseBraveResults, parseGoogleResults } from "./search.js";

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

test("resolveSearchConfig() defaults to the brave preset with no key set", () => {
  withEnv({ SEARCH_PRESET: undefined, SEARCH_API_KEY: undefined, SEARCH_CX: undefined }, () => {
    const cfg = resolveSearchConfig();
    assert.equal(cfg.presetName, "brave");
    assert.equal(cfg.apiKey, "");
  });
});

test("resolveSearchConfig() reads SEARCH_PRESET/SEARCH_API_KEY/SEARCH_CX", () => {
  withEnv({ SEARCH_PRESET: "google", SEARCH_API_KEY: "test-key", SEARCH_CX: "test-cx" }, () => {
    const cfg = resolveSearchConfig();
    assert.equal(cfg.presetName, "google");
    assert.equal(cfg.apiKey, "test-key");
    assert.equal(cfg.cx, "test-cx");
  });
});

test("resolveSearchConfig() throws a clear error on an unknown preset", () => {
  withEnv({ SEARCH_PRESET: "yahoo" }, () => {
    assert.throws(() => resolveSearchConfig(), /Unknown SEARCH_PRESET "yahoo"/);
  });
});

test("parseBraveResults() maps the API shape to {title, url, snippet}", () => {
  const data = {
    web: {
      results: [{ title: "City of Example", url: "https://cityofexample.gov", description: "Official site" }],
    },
  };
  assert.deepEqual(parseBraveResults(data), [
    { title: "City of Example", url: "https://cityofexample.gov", snippet: "Official site" },
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
