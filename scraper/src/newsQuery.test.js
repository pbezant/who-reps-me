import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNewsQuery, hostnameFrom, parseNewsResults, trimSnippet } from "./newsQuery.js";

test("buildNewsQuery() disambiguates a federal rep by office title + state", () => {
  const q = buildNewsQuery({ name: "Jordan Ellis", area: "US House", state: "TX" });
  assert.equal(q, `"Jordan Ellis" U.S. Representative TX news`);
});

test("buildNewsQuery() disambiguates a US Senator distinctly from a US Representative", () => {
  const q = buildNewsQuery({ name: "Jordan Ellis", area: "US Senate", state: "TX" });
  assert.match(q, /U\.S\. Senator/);
});

test("buildNewsQuery() disambiguates a state legislator by chamber + state", () => {
  const upper = buildNewsQuery({ name: "Pat Rivera", area: "StateUpper", state: "TX" });
  const lower = buildNewsQuery({ name: "Pat Rivera", area: "StateLower", state: "TX" });
  assert.match(upper, /TX Senate/);
  assert.match(lower, /TX House/);
});

test("buildNewsQuery() prefers the governing body over the bare office title for a local official", () => {
  const q = buildNewsQuery({ name: "Kirk Watson", area: "Mayor", state: "TX", body: "Austin City Council" });
  assert.match(q, /Austin City Council/);
});

test("buildNewsQuery() falls back to the office title when a local official has no body", () => {
  const q = buildNewsQuery({ name: "Kirk Watson", area: "Mayor", state: "TX" });
  assert.match(q, /Mayor/);
});

test("buildNewsQuery() returns an empty string with no name rather than a garbage query", () => {
  assert.equal(buildNewsQuery({ area: "US House", state: "TX" }), "");
  assert.equal(buildNewsQuery(), "");
});

test("hostnameFrom() strips the www. prefix", () => {
  assert.equal(hostnameFrom("https://www.nytimes.com/2026/08/24/us/story.html"), "nytimes.com");
});

test("hostnameFrom() tolerates a malformed URL instead of throwing", () => {
  assert.equal(hostnameFrom("not a url"), "");
});

test("parseNewsResults() trims to title/url/source/snippet and derives the source from the URL", () => {
  const results = [
    { title: "Rep. Ellis introduces bill", url: "https://www.statesman.com/story", snippet: "A new bill..." },
  ];
  assert.deepEqual(parseNewsResults(results), [
    { title: "Rep. Ellis introduces bill", url: "https://www.statesman.com/story", source: "statesman.com", snippet: "A new bill..." },
  ]);
});

test("parseNewsResults() drops entries with no url and caps the list at 5", () => {
  const results = [
    { title: "no url", snippet: "x" },
    ...Array.from({ length: 8 }, (_, i) => ({ title: `Article ${i}`, url: `https://example.com/${i}` })),
  ];
  const parsed = parseNewsResults(results);
  assert.equal(parsed.length, 5);
  assert.ok(parsed.every((a) => a.url.startsWith("https://example.com/")));
});

test("parseNewsResults() tolerates a missing/empty list", () => {
  assert.deepEqual(parseNewsResults(undefined), []);
  assert.deepEqual(parseNewsResults([]), []);
});

// Tavily's extractive `content` is what made the profile panel a wall of text — these cover the
// trimming that keeps each result to a taste of the story.
test("trimSnippet() cuts a long snippet at a word boundary with an ellipsis", () => {
  const long = "word ".repeat(100).trim();
  const out = trimSnippet(long);
  assert.ok(out.length <= 241, `expected <=241 chars, got ${out.length}`);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.includes("wor…"), "must not cut mid-word");
});

test("trimSnippet() replaces Tavily's [...] joiner with an ellipsis and collapses whitespace", () => {
  assert.equal(trimSnippet("First passage. [...] Second passage."), "First passage. … Second passage.");
  assert.equal(trimSnippet("ragged\n   spacing\there"), "ragged spacing here");
});

test("trimSnippet() strips a leading or trailing joiner rather than opening with an ellipsis", () => {
  assert.equal(trimSnippet("[...] Mid-sentence start"), "Mid-sentence start");
  assert.equal(trimSnippet("Trailing off [...]"), "Trailing off");
});

test("trimSnippet() leaves a short snippet untouched and tolerates missing input", () => {
  assert.equal(trimSnippet("Short and sweet."), "Short and sweet.");
  assert.equal(trimSnippet(undefined), "");
  assert.equal(trimSnippet(null), "");
});

test("trimSnippet() does not leave dangling punctuation before the ellipsis", () => {
  const out = trimSnippet(`${"a".repeat(235)}, tail tail tail`);
  assert.ok(!/[,;:.]…$/.test(out), `dangling punctuation in ${JSON.stringify(out.slice(-12))}`);
});

test("parseNewsResults() trims each snippet it passes through", () => {
  const [article] = parseNewsResults([
    { title: "T", url: "https://example.com/a", snippet: `x ${"y ".repeat(300)}` },
  ]);
  assert.ok(article.snippet.length <= 241);
  assert.ok(article.snippet.endsWith("…"));
});
