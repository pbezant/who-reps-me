// "Suggest an official" — lets a visitor paste a URL pointing at an elected/appointed official
// (a roster page or a single official's own bio page) and have it validated + scraped on the
// spot, the same fetch → extract → normalize pipeline the batch scraper and the on-demand
// local-officials lookup (local-officials.mjs) both use. This is the ONE place in the project
// that fetches a URL supplied by an anonymous visitor rather than one an LLM recalled or a
// contributor hand-authored — see urlSafety.js's own header comment for why that makes it the
// only path needing an SSRF guard at all.
//
// This function does NOT write to the public shard directly — a single unauthenticated
// endpoint being able to inject arbitrary "officials" straight into the served dataset with no
// review step at all would be a bad trade for how rarely this gets used. Instead, like
// local-officials.mjs, it saves the (already fully scraped) result to Netlify Blobs, and
// scripts/promote-url-submissions.js — run daily alongside promote-blob-finds.js — is what
// actually promotes a confident, government-sourced, jurisdiction-resolved submission into
// public/officials/<STATE>.json and config/seeds.discovered.json. A submission that can't be
// resolved with confidence just sits in Blobs, visible in that script's "needs a human look"
// output, rather than silently corrupting the dataset.
//
// Requires an LLM_API_KEY (or ANTHROPIC_API_KEY) + LLM_PRESET set in the Netlify site's
// environment variables, same as local-officials.mjs — see scraper/README.md. Pick a FAST
// preset (groq/gemini/mistral): this runs synchronously inside the form submission.

import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import { checkSubmissionUrl } from "../../scraper/src/urlSafety.js";
import { fetchPage } from "../../scraper/src/fetch.js";
import { findMediaCandidates } from "../../scraper/src/media.js";
import { extractOfficialSubmission } from "../../scraper/src/extract.js";
import { normalize } from "../../scraper/src/normalize.js";

const SUBMISSIONS_STORE = "official-url-submissions";
const RATE_LIMIT_STORE = "official-url-submissions-ratelimit";
const MAX_NOTE_LENGTH = 500;
// A visitor with something genuinely useful to add rarely has more than a handful of URLs in
// one sitting; this is about capping the cost of abuse (each submission spends one real fetch
// + one real LLM call), not about normal use.
const DAILY_LIMIT_PER_IP = 15;
// Local/county officials only — this is the same scope the batch scraper and
// public/officials/<STATE>.json cover. State legislators/executives come from Open States and
// federal reps from 5calls, both already covered elsewhere; a submission for either is
// acknowledged but not eligible for promotion into this dataset (see promote-url-submissions.js).
const PROMOTABLE_LEVELS = new Set(["local", "county"]);
// Below this self-reported extraction confidence, an official is kept in the stored submission
// (so a human reviewing it can still see it) but excluded from what promote-url-submissions.js
// will write into the public shard automatically.
const MIN_PROMOTABLE_CONFIDENCE = 0.6;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Netlify sets this on every function invocation; x-forwarded-for is the fallback for local
// `netlify dev`. Hashed (not stored raw) — this is only ever used as an abuse-rate counter key,
// never displayed or matched back to a person.
function hashedClientIp(req) {
  const ip =
    req.headers.get("x-nf-client-connection-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

function submissionKey(url) {
  return createHash("sha256").update(url).digest("hex");
}

export default async (req) => {
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const check = checkSubmissionUrl(body.url);
  if (!check.ok) return jsonResponse({ error: check.reason }, 400);
  const url = check.url.href;
  const note = String(body.note || "").trim().slice(0, MAX_NOTE_LENGTH);

  // Rate limit before spending a fetch + LLM call on this request. One counter per IP per UTC
  // day — coarse on purpose (no separate TTL bookkeeping needed, it just ages out the next day).
  const rateLimitStore = getStore(RATE_LIMIT_STORE);
  const today = new Date().toISOString().slice(0, 10);
  const rateLimitKey = `${today}:${hashedClientIp(req)}`;
  const usedToday = (await rateLimitStore.get(rateLimitKey, { type: "json" }).catch(() => null)) || 0;
  if (usedToday >= DAILY_LIMIT_PER_IP) {
    return jsonResponse({ error: "You've submitted a lot of URLs today — try again tomorrow." }, 429);
  }
  await rateLimitStore.setJSON(rateLimitKey, usedToday + 1);

  const submissionsStore = getStore(SUBMISSIONS_STORE);
  const key = submissionKey(url);
  const now = new Date().toISOString();

  const page = await fetchPage(url, { timeoutMs: 20000, allowBrowser: false });
  if (!page.ok) {
    await submissionsStore.setJSON(key, { url, note, ok: false, error: page.error, checked_at: now });
    return jsonResponse({ status: "error", message: `Couldn't load that page (${page.error}).` });
  }

  const media = findMediaCandidates(page.html, url);
  let extraction;
  try {
    extraction = await extractOfficialSubmission({ text: page.text, url, media });
  } catch (err) {
    await submissionsStore.setJSON(key, { url, note, ok: false, error: err.message, checked_at: now });
    return jsonResponse({ status: "error", message: "Couldn't analyze that page right now — try again in a bit." });
  }

  const { isGovernmentSource, jurisdiction, officials: rawOfficials } = extraction;

  const jurisdictionResolved = Boolean(jurisdiction.city && jurisdiction.state);
  const promotable = isGovernmentSource && jurisdictionResolved && PROMOTABLE_LEVELS.has(jurisdiction.level);

  const normalizedJurisdiction = {
    city: jurisdiction.city,
    state: jurisdiction.state,
    level: jurisdiction.level || "local",
    body: jurisdiction.body,
  };
  // Normalize even when the jurisdiction couldn't be resolved (city/state null) — this keeps
  // whatever was found visible in the stored submission for a human to review, rather than
  // discarding a real extraction just because normalize() can't build a clean id for it. Those
  // records simply never pass isPromotableSubmission()'s city/state check in
  // promote-url-submissions.js, so an unresolved jurisdiction can be seen but never promoted.
  const normalized = rawOfficials
    .map((o) => normalize(o, { jurisdiction: normalizedJurisdiction, sourceUrl: url, extractedAt: now }))
    .filter(Boolean);

  await submissionsStore.setJSON(key, {
    url,
    note,
    ok: true,
    is_government_source: isGovernmentSource,
    jurisdiction,
    officials: normalized,
    promotable: promotable && normalized.some((o) => (o.confidence ?? 0) >= MIN_PROMOTABLE_CONFIDENCE),
    checked_at: now,
    promoted: false,
  });

  if (!normalized.length) {
    return jsonResponse({
      status: "not-found",
      message: "We couldn't confidently identify any current officials on that page. Thanks for trying!",
    });
  }

  const names = normalized.map((o) => `${o.name}${o.office ? ` (${o.office})` : ""}`);
  let message;
  if (!isGovernmentSource) {
    message = `Found ${names.join(", ")} — but this doesn't look like an official government source, so it'll need a manual look before it's added.`;
  } else if (!jurisdictionResolved) {
    message = `Found ${names.join(", ")} — but we couldn't tell which city/county this is for, so it'll need a manual look before it's added.`;
  } else if (jurisdiction.level === "state" || jurisdiction.level === "federal") {
    message = `Found ${names.join(", ")} — this looks like a state or federal official, which we already source elsewhere, so it won't be added from here.`;
  } else if (!PROMOTABLE_LEVELS.has(jurisdiction.level)) {
    message = `Found ${names.join(", ")} — but we couldn't tell what level of government this is, so it'll need a manual look before it's added.`;
  } else {
    message = `Thanks! Found ${names.join(", ")} for ${jurisdiction.city || jurisdiction.county}, ${jurisdiction.state}. This will be reviewed and added to the map soon.`;
  }

  return jsonResponse({ status: "found", message, officials: names, jurisdiction });
};

export const config = { path: "/api/submit-official" };
