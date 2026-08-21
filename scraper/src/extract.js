// AI extraction. This is the core of the "works for any layout" approach: instead of
// per-site CSS selectors, we hand a page's visible text to an LLM and ask for a strict
// JSON list of officials. Adding a new city = adding a URL, not writing a parser.
//
// Provider config (presets, throttling, retry) lives in llm.js — this module only builds
// the extraction-specific prompt and parses the response.
//
// Config:
//   LLM_PRESET, LLM_API_KEY, LLM_MODEL, LLM_BASE_URL, LLM_RPM   — see llm.js
//   LLM_MAX_CHARS   how much of a page's text to send (default 24000)
//   LLM_MAX_OUTPUT  max response tokens (default 8192, less on tighter presets) — a jurisdiction
//                   with an unusually large council can still overflow this; callLLM() (llm.js)
//                   throws a clear "response truncated" error rather than silently returning
//                   nothing when that happens, so it shows up in problems.json, not as a
//                   quiet 0-officials result.

import { callLLM, extractJson, resolveLLMConfig } from "./llm.js";

const SYSTEM_PROMPT = `You extract elected/appointed official records from a US government web page.
Return ONLY valid JSON matching this schema, no prose:
{
  "officials": [
    {
      "name": "string, full name",
      "office": "string, e.g. 'Mayor', 'City Council Member', 'Council Member At-Large'",
      "district": "string or null, e.g. 'District 4', 'Ward 2', 'Place 5', 'Seat A'",
      "phone": "string or null, digits/format as shown",
      "email": "string or null, a real email address only — see the email rule below",
      "url": "string or null, their official page if present",
      "photo_url": "string or null, absolute URL if present",
      "social": {
        "twitter": "string or null, absolute profile URL",
        "facebook": "string or null, absolute profile URL",
        "instagram": "string or null, absolute profile URL",
        "linkedin": "string or null, absolute profile URL",
        "youtube": "string or null, absolute channel URL"
      },
      "address": "string or null, office address",
      "confidence": "number 0-1, how sure you are this is a real current official from this page"
    }
  ]
}
Rules:
- Only include people who are officials of THIS jurisdiction shown on the page. Do not invent data.
- If a field is not on the page, use null. Never guess phone numbers, emails, or social links.
- Convert relative photo/link URLs to absolute using the page URL provided.
- You are given a separate list of images, social links, emails, and other page links found on
  the page (with a short text snippet from around where each one appears) since the page text
  below has had all markup stripped out. Use those candidates plus their surrounding text to
  match a photo/social link/email/own-page link to the specific official it belongs to — do not
  invent a match with no supporting textual link.
- For the "url" field specifically: check the "Other page links" candidates for one whose own
  visible text (or nearby context) is that official's name, office, or district — a roster page
  commonly links each person's name or "District N" straight to their own page.
- For the "email" field specifically: only use an address from the "Emails" candidates (real
  mailto: links) — never substitute a contact-form URL, a profile/bio page link, or anything else
  from "Other page links" as someone's email. If no Emails candidate textually matches this
  official, leave email null rather than guessing.
- If the same photo or social link would apply to every official on the page (a shared city
  seal/logo, or a jurisdiction-wide "Follow us" account), it is NOT a personal photo/account —
  leave it null for everyone rather than attaching it to any one person.
- If the page has no officials (wrong page, navigation only), return {"officials": []}.`;

// Compact, token-light rendering of media.js's candidates for the prompt. Numbered so the
// model can reference "candidate 3" internally if useful, though we only need the final match.
function formatMediaBlock(media) {
  if (
    !media ||
    (!media.images?.length && !media.socialLinks?.length && !media.emails?.length && !media.links?.length)
  )
    return "(none found)";
  const lines = [];
  if (media.images?.length) {
    lines.push("Images:");
    media.images.forEach((img, i) => {
      lines.push(`${i + 1}. ${img.src} | alt="${img.alt}" | near: "${img.context}"`);
    });
  }
  if (media.socialLinks?.length) {
    lines.push("Social links:");
    media.socialLinks.forEach((link, i) => {
      lines.push(`${i + 1}. [${link.platform}] ${link.url} | text="${link.text}" | near: "${link.context}"`);
    });
  }
  if (media.emails?.length) {
    // Candidates for the `email` field — real mailto: addresses only. See media.js's own header
    // comment for why these are surfaced separately (the austintexas.gov/mayor / Kirk Watson case).
    lines.push("Emails (from mailto: links):");
    media.emails.forEach((email, i) => {
      lines.push(`${i + 1}. ${email.email} | text="${email.text}" | near: "${email.context}"`);
    });
  }
  if (media.links?.length) {
    // Candidates for the `url` field — an official's own page, same-origin, not a social
    // account or an email. See media.js's own header comment for why this list exists.
    lines.push("Other page links (not photos, social accounts, or emails):");
    media.links.forEach((link, i) => {
      lines.push(`${i + 1}. ${link.url} | text="${link.text}" | near: "${link.context}"`);
    });
  }
  return lines.join("\n");
}

export async function extractOfficials({ text, url, jurisdiction, media }) {
  // Retired/missing-key presets fail fatally inside callLLM(); resolveLLMConfig() here is
  // only to read the preset's maxChars, so no need to duplicate that check.
  const cfg = resolveLLMConfig();

  // Cap page text so a huge page can't blow up token use, and so we stay under the selected
  // provider's per-request input limit. Officials are almost always in a roster block near the
  // top of the page, so a clip rarely loses anything that matters.
  const maxChars = Number(process.env.LLM_MAX_CHARS || cfg.preset.maxChars || 24000);
  const clipped = text.slice(0, maxChars);
  const user = `Page URL: ${url}
Jurisdiction: ${jurisdiction.body} (${jurisdiction.city}, ${jurisdiction.state})

Images, social links, emails, and other page links found on this page:
${formatMediaBlock(media)}

Page text:
"""
${clipped}
"""`;

  const raw = await callLLM({ system: SYSTEM_PROMPT, user });
  const parsed = extractJson(raw) || { officials: [] };
  return Array.isArray(parsed.officials) ? parsed.officials : [];
}

// Narrower single-official prompt for the bio-page follow-up crawl (pipeline.js): the roster
// pass above extracts every official from ONE shared listing page, which usually shows an
// address/district but rarely a photo or personal social link. This second pass instead visits
// the one page an already-known official's own `url` points to and asks for just their own
// details — see scraper/README.md's "Photos and social links" section for why the roster pass
// alone stays at 0% photo coverage without this.
const DETAIL_SYSTEM_PROMPT = `You are looking at a single elected/appointed official's own bio or contact page.
Return ONLY valid JSON matching this schema, no prose:
{
  "photo_url": "string or null, absolute URL if present",
  "address": "string or null, office address",
  "phone": "string or null",
  "email": "string or null, a real email address only — see the email rule below",
  "hours": "string or null, office hours if stated",
  "bio": "string or null, a short 1-3 sentence biographical summary if the page has one",
  "offices": [
    {
      "classification": "string, e.g. 'district', 'main'",
      "name": "string or null",
      "city": "string or null",
      "address": "string or null",
      "phone": "string or null",
      "fax": "string or null",
      "hours": "string or null"
    }
  ],
  "social": {
    "twitter": "string or null, absolute profile URL",
    "facebook": "string or null, absolute profile URL",
    "instagram": "string or null, absolute profile URL",
    "linkedin": "string or null, absolute profile URL",
    "youtube": "string or null, absolute channel URL"
  }
}
Rules:
- You are told which official's page this is. Only extract fields that are actually about THIS
  person — if the page is not clearly about them (wrong person, a general contact page not
  specific to any one official, navigation only), return every field null and an empty offices
  list rather than guessing.
- If a field is not on the page, use null. Never guess phone numbers, emails, or social links.
- Convert relative photo/link URLs to absolute using the page URL provided.
- You are given a separate list of images, social links, and emails found on the page (with a
  short text snippet from around where each one appears) since the page text below has had all
  markup stripped out. Use those candidates plus their surrounding text to find this specific
  person's photo/social links/email — do not invent a match with no supporting textual link.
- For the "email" field specifically: only use an address from the "Emails" candidates (real
  mailto: links) — never substitute a contact-form URL or any other link as this person's email.
  If no Emails candidate matches, leave email null rather than guessing.
- "offices" is for any ADDITIONAL office beyond the page's own main contact info that this
  official's page separately lists (e.g. a district or field office). Leave it an empty list if
  the page only shows one office's worth of contact info — that belongs in the top-level
  phone/address/hours fields, not duplicated into offices.`;

export async function extractOfficialDetail({ text, url, name, office, media }) {
  const cfg = resolveLLMConfig();
  const maxChars = Number(process.env.LLM_MAX_CHARS || cfg.preset.maxChars || 24000);
  const clipped = text.slice(0, maxChars);
  const user = `Page URL: ${url}
Official this page should be about: ${name}${office ? ` (${office})` : ""}

Images, social links, emails, and other page links found on this page:
${formatMediaBlock(media)}

Page text:
"""
${clipped}
"""`;

  const raw = await callLLM({ system: DETAIL_SYSTEM_PROMPT, user });
  const parsed = extractJson(raw);
  return parsed && typeof parsed === "object" ? parsed : null;
}
