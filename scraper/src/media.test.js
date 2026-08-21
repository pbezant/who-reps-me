import { test } from "node:test";
import assert from "node:assert/strict";
import { findMediaCandidates, stripSharedMedia } from "./media.js";

const BASE = "https://www.example-city.gov/council";

test("findMediaCandidates() captures a same-origin plain link as a `url` candidate", () => {
  const html = `<a href="/council/district-1">District 1</a>`;
  const { links } = findMediaCandidates(html, BASE);
  assert.equal(links.length, 1);
  assert.equal(links[0].url, "https://www.example-city.gov/council/district-1");
  assert.equal(links[0].text, "District 1");
});

test("findMediaCandidates() routes a social-domain link to socialLinks, not links", () => {
  const html = `<a href="https://twitter.com/examplecity">Follow us</a>`;
  const { links, socialLinks } = findMediaCandidates(html, BASE);
  assert.equal(links.length, 0);
  assert.equal(socialLinks.length, 1);
  assert.equal(socialLinks[0].platform, "twitter");
});

test("findMediaCandidates() drops an off-origin plain link — never a bio-page candidate", () => {
  // e.g. a link to a neighboring jurisdiction's site, or a news article host — same shape of
  // mistake sameOriginNewLinks() already guards against in discover.js.
  const html = `<a href="https://otherdomain.example.com/about">About</a>`;
  const { links } = findMediaCandidates(html, BASE);
  assert.equal(links.length, 0);
});

test("findMediaCandidates() drops agenda/minutes/news noise the same way suggestLinks() does", () => {
  const html = `<a href="/council/meeting-minutes-2026">Minutes</a>`;
  const { links } = findMediaCandidates(html, BASE);
  assert.equal(links.length, 0);
});

test("findMediaCandidates() drops a same-page anchor (skip link / self link)", () => {
  const html = `<a href="#main-content">Skip to main content</a><a href="/council">Home</a>`;
  const { links } = findMediaCandidates(html, BASE);
  assert.equal(links.length, 0);
});

test("findMediaCandidates() prefers a later occurrence's text over an earlier empty one", () => {
  // The austintexas.gov/council pattern: a photo-only wrapper <a> to a member's page, then a
  // second sibling <a> to the same href wrapping their name.
  const html = `
    <a href="/council/district-1"><img src="/headshot.jpg" alt=""/></a>
    <a href="/council/district-1">Natasha Harper-Madison</a>
  `;
  const { links } = findMediaCandidates(html, BASE);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, "Natasha Harper-Madison");
});

test("findMediaCandidates() keeps an earlier occurrence's text when a later one is empty", () => {
  const html = `
    <a href="/council/district-1">Natasha Harper-Madison</a>
    <a href="/council/district-1"><img src="/icon.svg" alt=""/></a>
  `;
  const { links } = findMediaCandidates(html, BASE);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, "Natasha Harper-Madison");
});

test("findMediaCandidates() dedupes repeated identical links to one candidate", () => {
  const html = `<a href="/council/district-1">D1</a><a href="/council/district-1">D1</a>`;
  const { links } = findMediaCandidates(html, BASE);
  assert.equal(links.length, 1);
});

test("findMediaCandidates() respects linkLimit — the Cook County/Nashville-scale case", () => {
  // A large council page could have many same-origin candidates; confirm the cap actually caps
  // rather than silently growing unbounded.
  const html = Array.from({ length: 10 }, (_, i) => `<a href="/council/seat-${i}">Seat ${i}</a>`).join("");
  const { links } = findMediaCandidates(html, BASE, { linkLimit: 3 });
  assert.equal(links.length, 3);
});

test("findMediaCandidates() still finds photo candidates (regression: images unaffected by the links change)", () => {
  const html = `<img src="/photos/watson.jpg" alt="Mayor Kirk Watson"/>`;
  const { images } = findMediaCandidates(html, BASE);
  assert.equal(images.length, 1);
  assert.equal(images[0].alt, "Mayor Kirk Watson");
});

test("findMediaCandidates() captures a mailto: link as an `emails` candidate", () => {
  const html = `<a href="mailto:kwatson@austintexas.gov">Send email</a>`;
  const { emails } = findMediaCandidates(html, BASE);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].email, "kwatson@austintexas.gov");
  assert.equal(emails[0].text, "Send email");
});

test("findMediaCandidates() strips a `?subject=...` query from a mailto: href", () => {
  const html = `<a href="mailto:kwatson@austintexas.gov?subject=Constituent%20Question">Email the Mayor</a>`;
  const { emails } = findMediaCandidates(html, BASE);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].email, "kwatson@austintexas.gov");
});

test("findMediaCandidates() never routes a mailto: link into `links` — the same-origin-null bug this fixes", () => {
  // Regression for the real-world symptom this change fixes: a mailto: URL's origin is the
  // string "null", so before `emails` existed this link was silently dropped by the `links`
  // same-origin check instead of being surfaced anywhere for the LLM to use.
  const html = `<a href="mailto:kwatson@austintexas.gov">Send email</a>`;
  const { links, emails } = findMediaCandidates(html, BASE);
  assert.equal(links.length, 0);
  assert.equal(emails.length, 1);
});

test("findMediaCandidates() dedupes a repeated identical mailto: link to one candidate", () => {
  const html = `<a href="mailto:kwatson@austintexas.gov">Email</a><a href="mailto:kwatson@austintexas.gov">Contact</a>`;
  const { emails } = findMediaCandidates(html, BASE);
  assert.equal(emails.length, 1);
});

test("findMediaCandidates() drops a mailto: link with no address", () => {
  const html = `<a href="mailto:">Email</a>`;
  const { emails } = findMediaCandidates(html, BASE);
  assert.equal(emails.length, 0);
});

test("findMediaCandidates() respects `limit` for emails, same cap as images/social", () => {
  const html = Array.from({ length: 5 }, (_, i) => `<a href="mailto:person${i}@example.gov">Email ${i}</a>`).join("");
  const { emails } = findMediaCandidates(html, BASE, { limit: 2 });
  assert.equal(emails.length, 2);
});

test("findMediaCandidates() carries a context snippet for an email candidate, same signal as images/social", () => {
  const html = `<p>Contact Mayor Watson:</p><a href="mailto:kwatson@austintexas.gov">Send email</a>`;
  const { emails } = findMediaCandidates(html, BASE);
  assert.match(emails[0].context, /Contact Mayor Watson/);
});

test("findMediaCandidates() extracts images, social links, plain links, and emails together without cross-contamination — the austintexas.gov/mayor case", () => {
  const html = `
    <img src="/photos/watson.jpg" alt="Mayor Kirk Watson"/>
    <a href="https://twitter.com/mayorwatson">Twitter</a>
    <a href="/mayor/bio">Bio</a>
    <a href="/email/14286">Contact form</a>
    <a href="mailto:kwatson@austintexas.gov">Send email</a>
  `;
  const { images, socialLinks, links, emails } = findMediaCandidates(html, BASE);
  assert.equal(images.length, 1);
  assert.equal(socialLinks.length, 1);
  assert.equal(links.length, 2); // /mayor/bio and /email/14286 — same-origin plain links
  assert.equal(emails.length, 1);
  assert.equal(emails[0].email, "kwatson@austintexas.gov");
});

test("stripSharedMedia() is untouched by the `links` field (no url-sharing check — pipeline.js's selectEnrichmentCandidates already guards that)", () => {
  const officials = [
    { id: "a", url: "https://www.example-city.gov/contact" },
    { id: "b", url: "https://www.example-city.gov/contact" },
  ];
  const stripped = stripSharedMedia(officials);
  assert.equal(stripped[0].url, "https://www.example-city.gov/contact");
  assert.equal(stripped[1].url, "https://www.example-city.gov/contact");
});
