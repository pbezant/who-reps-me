import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPage } from "./fetch.js";

// fetchPage()/fetchStatic() must report the page's actual post-redirect address in `url`, not
// the originally-requested one — fetch(url, { redirect: "follow" }) already chases any 30x
// chain to get the page content, but resolves with whatever `url` string was passed in unless
// the Response's own res.url is read explicitly. Getting this wrong is silent, not a crash:
// confirmed for real against Wayne County, MI, whose seed URL (waynecounty.com) redirects to an
// entirely different domain (waynecountymi.gov) — code that trusted the requested url instead of
// the fetched page's own url resolved relative links, and checked same-origin, against the wrong
// address (see discover.js's findRosterPage() and pipeline.js's scrapeJurisdiction()).
//
// fetch.js calls the bare global `fetch`, so stubbing globalThis.fetch here reaches it without
// any refactor — no need to export fetchStatic() or inject a fetch implementation.
function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

function fakeResponse({ url, status = 200, body = `<html><body>${"hello world ".repeat(50)}</body></html>` }) {
  return { ok: status >= 200 && status < 300, status, url, text: async () => body };
}

test("fetchPage() reports the response's post-redirect url, not the requested url", async () => {
  const restore = stubFetch(async (requestedUrl) => {
    assert.equal(requestedUrl, "https://www.waynecounty.com");
    return fakeResponse({ url: "https://waynecountymi.gov/" });
  });
  try {
    const page = await fetchPage("https://www.waynecounty.com", { allowBrowser: false });
    assert.equal(page.ok, true);
    assert.equal(page.url, "https://waynecountymi.gov/");
  } finally {
    restore();
  }
});

test("fetchPage() reports the requested url unchanged when there is no redirect", async () => {
  const restore = stubFetch(async (requestedUrl) => fakeResponse({ url: requestedUrl }));
  try {
    const page = await fetchPage("https://example.gov/council", { allowBrowser: false });
    assert.equal(page.url, "https://example.gov/council");
  } finally {
    restore();
  }
});

test("fetchPage() reports the post-redirect url even on a non-OK final status", async () => {
  const restore = stubFetch(async () => fakeResponse({ url: "https://example.gov/moved", status: 404, body: "not found" }));
  try {
    const page = await fetchPage("https://example.gov/old-page", { allowBrowser: false });
    assert.equal(page.ok, false);
    assert.equal(page.url, "https://example.gov/moved");
    assert.equal(page.status, 404);
  } finally {
    restore();
  }
});

test("fetchPage() falls back to the requested url when fetch itself throws (no Response to read)", async () => {
  const restore = stubFetch(async () => {
    throw new Error("network unreachable");
  });
  try {
    const page = await fetchPage("https://example.gov/", { allowBrowser: false });
    assert.equal(page.ok, false);
    assert.equal(page.url, "https://example.gov/");
    assert.match(page.error, /network unreachable/);
  } finally {
    restore();
  }
});
