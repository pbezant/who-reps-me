// Guards the one place in this project that fetches a URL a random visitor typed in, rather
// than one an LLM recalled (discover.js) or a human hand-authored (config/seeds.json): a link
// submitted through the site's "help us grow this map" form, scraped by
// scripts/scrape-reported-links.js. Everywhere else in the scraper, the fetched URL either came
// from our own LLM call or from a file only a contributor can edit — this is the only path where
// the URL itself is untrusted input, so it's the only place that needs an SSRF guard at all.
//
// Honest trade-off, same spirit as scraper/README.md's own "Honest trade-offs" section: this
// is a hostname/IP-literal allowlist-by-exclusion, not real SSRF protection. It blocks the
// obvious cases (someone pastes `http://169.254.169.254/...` or `http://localhost:1337/...`
// straight into the form) but does NOT resolve DNS and pin the result, so a hostname that
// *resolves* to a private address (DNS rebinding, or a public domain repointed at an internal
// IP after this check passes) gets through. Closing that gap needs a custom fetch dispatcher
// that resolves once and connects to the pinned IP — more than this low-traffic form justifies
// today. What this DOES reliably stop: the copy-paste and casual-abuse cases, which are the
// realistic threat model for a public form with no auth.

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Ranges that should never be fetched on a submitter's behalf: loopback, link-local (includes
// the cloud metadata endpoint 169.254.169.254), RFC1918 private space, carrier-grade NAT,
// documentation/test ranges, multicast, and the rest of the reserved space. Deliberately over-
// inclusive (e.g. the TEST-NET ranges can never be a legitimate government roster page anyway).
function isPrivateIPv4(host) {
  const m = IPV4_RE.exec(host);
  if (!m) return false;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return false; // not actually a valid IPv4 literal
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local, incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 (both start 192.0)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  return false;
}

// IPv6 has no single compact regex the way IPv4 does, but the addresses actually worth
// blocking (loopback, link-local, unique-local) all have simple fixed prefixes once the
// browser/URL parser has already normalized and bracket-stripped the literal.
function isPrivateIPv6(host) {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fe80:") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true; // fe80::/10 link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 unique-local
  // ::ffff:a.b.c.d — an IPv4-mapped IPv6 literal embedding a private v4 address. Node's own
  // URL parser normalizes the embedded address to two hex groups (`::ffff:7f00:1`, not
  // `::ffff:127.0.0.1`) rather than keeping the dotted form, so both are checked here.
  const dotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return isPrivateIPv4(dotted[1]);
  const hexPair = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexPair) {
    const hi = parseInt(hexPair[1], 16);
    const lo = parseInt(hexPair[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  return false;
}

const MAX_URL_LENGTH = 2000;

// Returns { ok: true } or { ok: false, reason } — a reason string safe to show back to the
// submitter (no internals), so the Netlify function can pass it straight through as the
// validation error.
export function checkSubmissionUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return { ok: false, reason: "Enter a URL." };
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: "That URL is too long." };

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "That doesn't look like a valid URL." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only http:// and https:// URLs are allowed." };
  }
  // Embedded credentials (http://user:pass@host/...) are never legitimate on a public roster
  // page and are a classic trick for smuggling a request past a naive host check.
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with a username/password aren't allowed." };
  }

  // strip a bracketed IPv6 literal's brackets for the private-range checks below.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const lower = hostname.toLowerCase();

  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local")) {
    return { ok: false, reason: "That host isn't reachable from here." };
  }
  if (isPrivateIPv4(hostname) || isPrivateIPv6(hostname)) {
    return { ok: false, reason: "That host isn't reachable from here." };
  }

  return { ok: true, url };
}
