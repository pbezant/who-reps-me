import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSubmissionUrl } from "./urlSafety.js";

test("accepts an ordinary https government page", () => {
  const result = checkSubmissionUrl("https://www.elgintx.com/149/City-Council");
  assert.equal(result.ok, true);
  assert.equal(result.url.hostname, "www.elgintx.com");
});

test("accepts plain http too", () => {
  assert.equal(checkSubmissionUrl("http://example.gov/council").ok, true);
});

test("rejects an empty/whitespace URL", () => {
  assert.equal(checkSubmissionUrl("").ok, false);
  assert.equal(checkSubmissionUrl("   ").ok, false);
});

test("rejects a URL over the length cap", () => {
  const long = "https://example.com/" + "a".repeat(2000);
  assert.equal(checkSubmissionUrl(long).ok, false);
});

test("rejects unparseable input", () => {
  assert.equal(checkSubmissionUrl("not a url at all").ok, false);
});

test("rejects non-http(s) schemes", () => {
  assert.equal(checkSubmissionUrl("ftp://example.com/file").ok, false);
  assert.equal(checkSubmissionUrl("file:///etc/passwd").ok, false);
  assert.equal(checkSubmissionUrl("javascript:alert(1)").ok, false);
  assert.equal(checkSubmissionUrl("gopher://internal:70/").ok, false);
});

test("rejects embedded credentials", () => {
  assert.equal(checkSubmissionUrl("https://user:pass@example.com/").ok, false);
});

test("rejects localhost and its variants", () => {
  assert.equal(checkSubmissionUrl("http://localhost/").ok, false);
  assert.equal(checkSubmissionUrl("http://LOCALHOST:8080/").ok, false);
  assert.equal(checkSubmissionUrl("http://foo.localhost/").ok, false);
  assert.equal(checkSubmissionUrl("http://printer.local/").ok, false);
});

test("rejects loopback and link-local IPv4 literals, including the cloud metadata address", () => {
  assert.equal(checkSubmissionUrl("http://127.0.0.1/").ok, false);
  assert.equal(checkSubmissionUrl("http://127.1.2.3/").ok, false);
  assert.equal(checkSubmissionUrl("http://169.254.169.254/latest/meta-data/").ok, false);
});

test("rejects RFC1918 private IPv4 ranges", () => {
  assert.equal(checkSubmissionUrl("http://10.0.0.5/").ok, false);
  assert.equal(checkSubmissionUrl("http://172.16.0.1/").ok, false);
  assert.equal(checkSubmissionUrl("http://172.31.255.255/").ok, false);
  assert.equal(checkSubmissionUrl("http://192.168.1.1/").ok, false);
});

test("does not block a public 172.x address outside the private /12", () => {
  assert.equal(checkSubmissionUrl("http://172.15.0.1/").ok, true);
  assert.equal(checkSubmissionUrl("http://172.32.0.1/").ok, true);
});

test("rejects CGNAT, benchmarking, and documentation/test IPv4 ranges", () => {
  assert.equal(checkSubmissionUrl("http://100.64.0.1/").ok, false);
  assert.equal(checkSubmissionUrl("http://198.18.0.1/").ok, false);
  assert.equal(checkSubmissionUrl("http://192.0.2.1/").ok, false);
  assert.equal(checkSubmissionUrl("http://198.51.100.1/").ok, false);
  assert.equal(checkSubmissionUrl("http://203.0.113.1/").ok, false);
});

test("rejects multicast/reserved and the broadcast address", () => {
  assert.equal(checkSubmissionUrl("http://224.0.0.1/").ok, false);
  assert.equal(checkSubmissionUrl("http://255.255.255.255/").ok, false);
});

test("rejects IPv6 loopback, link-local, and unique-local literals", () => {
  assert.equal(checkSubmissionUrl("http://[::1]/").ok, false);
  assert.equal(checkSubmissionUrl("http://[fe80::1]/").ok, false);
  assert.equal(checkSubmissionUrl("http://[fc00::1]/").ok, false);
  assert.equal(checkSubmissionUrl("http://[fd12:3456::1]/").ok, false);
});

test("rejects an IPv4-mapped IPv6 literal embedding a private address", () => {
  assert.equal(checkSubmissionUrl("http://[::ffff:127.0.0.1]/").ok, false);
});

test("accepts a public IPv6 literal", () => {
  assert.equal(checkSubmissionUrl("http://[2606:4700:4700::1111]/").ok, true);
});
