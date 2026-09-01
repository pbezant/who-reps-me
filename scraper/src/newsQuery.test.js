import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNewsQuery, hostnameFrom, parseNewsResults, trimSnippet, toIsoDate } from "./newsQuery.js";

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

test("parseNewsResults() trims to the rendered fields and derives the source from the URL", () => {
  const results = [
    { title: "Rep. Ellis introduces bill", url: "https://www.statesman.com/story", snippet: "A new bill..." },
  ];
  assert.deepEqual(parseNewsResults(results), [
    {
      title: "Rep. Ellis introduces bill",
      url: "https://www.statesman.com/story",
      source: "statesman.com",
      snippet: "A new bill...",
      image: "",
      favicon: "",
      publishedAt: "",
    },
  ]);
});

// The media fields are optional all the way down: a provider that never sends them (brave without
// a thumbnail, google at all) must still produce a well-formed article the UI can render.
test("parseNewsResults() carries image and favicon through when a provider supplies them", () => {
  const [article] = parseNewsResults([
    {
      title: "Story",
      url: "https://example.com/a",
      snippet: "Body",
      image: "https://img.example/hero.jpg",
      favicon: "https://example.com/favicon.png",
    },
  ]);
  assert.equal(article.image, "https://img.example/hero.jpg");
  assert.equal(article.favicon, "https://example.com/favicon.png");
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

// Guards the "wrong Erin" case: a live Tavily response for a Texas House member returned articles
// about two unrelated people who merely shared a first name, scoring 0.26 and 0.13.
test("parseNewsResults() drops weakly-scored results that are probably a different person", () => {
  const parsed = parseNewsResults([
    { title: "Right person", url: "https://example.com/good", score: 0.82 },
    { title: "Different Erin entirely", url: "https://example.com/bad", score: 0.26 },
    { title: "Also unrelated", url: "https://example.com/worse", score: 0.13 },
  ]);
  assert.deepEqual(parsed.map((a) => a.url), ["https://example.com/good"]);
});

// Score filtering must happen before the 5-item cap, or junk crowds out the good results behind it.
test("parseNewsResults() filters by score before capping the list", () => {
  const weak = Array.from({ length: 5 }, (_, i) => ({ title: `weak ${i}`, url: `https://example.com/w${i}`, score: 0.1 }));
  const strong = { title: "strong", url: "https://example.com/strong", score: 0.9 };
  assert.deepEqual(parseNewsResults([...weak, strong]).map((a) => a.url), ["https://example.com/strong"]);
});

// brave/google don't score results at all — a null score must never be read as a bad one.
test("parseNewsResults() keeps results from a provider that reports no score", () => {
  const parsed = parseNewsResults([
    { title: "Unscored", url: "https://example.com/a" },
    { title: "Explicit null", url: "https://example.com/b", score: null },
  ]);
  assert.equal(parsed.length, 2);
});

test("toIsoDate() normalizes Tavily's RFC 1123 timestamps and rejects junk", () => {
  assert.equal(toIsoDate("Thu, 30 Oct 2025 09:00:02 GMT"), "2025-10-30T09:00:02.000Z");
  assert.equal(toIsoDate("2025-10-30T09:00:02Z"), "2025-10-30T09:00:02.000Z");
  assert.equal(toIsoDate("last tuesday"), "");
  assert.equal(toIsoDate(""), "");
  assert.equal(toIsoDate(undefined), "");
});

test("parseNewsResults() normalizes publishedAt and leaves it empty when absent", () => {
  const [withDate, without] = parseNewsResults([
    { title: "A", url: "https://example.com/a", publishedAt: "Thu, 30 Oct 2025 09:00:02 GMT" },
    { title: "B", url: "https://example.com/b" },
  ]);
  assert.equal(withDate.publishedAt, "2025-10-30T09:00:02.000Z");
  assert.equal(without.publishedAt, "");
});
