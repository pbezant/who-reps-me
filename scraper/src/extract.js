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
//   LLM_MAX_OUTPUT  max response tokens (default 4096, less on tighter presets)

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
      "email": "string or null",
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
- You are given a separate list of images and social links found on the page (with a short text
  snippet from around where each one appears) since the page text below has had all markup
  stripped out. Use those candidates plus their surrounding text to match a photo/social link to
  the specific official it belongs to — do not invent a match with no supporting textual link.
- If the same photo or social link would apply to every official on the page (a shared city
  seal/logo, or a jurisdiction-wide "Follow us" account), it is NOT a personal photo/account —
  leave it null for everyone rather than attaching it to any one person.
- If the page has no officials (wrong page, navigation only), return {"officials": []}.`;

// Compact, token-light rendering of media.js's candidates for the prompt. Numbered so the
// model can reference "candidate 3" internally if useful, though we only need the final match.
function formatMediaBlock(media) {
  if (!media || (!media.images?.length && !media.socialLinks?.length)) return "(none found)";
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

Images and social links found on this page:
${formatMediaBlock(media)}

Page text:
"""
${clipped}
"""`;

  const raw = await callLLM({ system: SYSTEM_PROMPT, user });
  const parsed = extractJson(raw) || { officials: [] };
  return Array.isArray(parsed.officials) ? parsed.officials : [];
}
