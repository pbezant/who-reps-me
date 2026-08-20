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
  "email": "string or null",
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
- You are given a separate list of images and social links found on the page (with a short text
  snippet from around where each one appears) since the page text below has had all markup
  stripped out. Use those candidates plus their surrounding text to find this specific person's
  photo/social links — do not invent a match with no supporting textual link.
- "offices" is for any ADDITIONAL office beyond the page's own main contact info that this
  official's page separately lists (e.g. a district or field office). Leave it an empty list if
  the page only shows one office's worth of contact info — that belongs in the top-level
  phone/address/hours fields, not duplicated into offices.`;

// Third variant, for scripts/scrape-reported-links.js (the daily-pipeline phase that scrapes a
// URL a visitor dropped into the "help us grow this map" form, see that script's own header
// comment): unlike extractOfficials() above, the jurisdiction is NOT known ahead of time — a
// visitor just linked a page, so this has to figure out both "who is this" AND "what
// jurisdiction/level are they part of" from the page itself in one call, rather than being told
// the jurisdiction up front. Kept as its own prompt/function (not a mode flag on
// extractOfficials()) since the two have genuinely different jobs: one extracts a roster already
// scoped to a known city, the other first has to decide whether the page is even a legitimate
// government source at all before extracting anything from it.
//
// This is also the one extraction prompt in this file with an explicit English-output rule.
// Everywhere else, the batch scraper only ever visits English-language US government sites
// picked from config/seeds.json or discover-jurisdictions.js's own English-biased search, so the
// question doesn't come up. A visitor-submitted link has no such guarantee (e.g. a bilingual
// county site's Spanish-language page), so this prompt is told explicitly to translate rather
// than pass through non-English text verbatim.
const SUBMISSION_SYSTEM_PROMPT = `You look at a web page a member of the public linked, claiming it shows one or more current US
elected/appointed government officials, and extract what's really there.
Return ONLY valid JSON matching this schema, no prose:
{
  "is_government_source": "boolean — true only if this looks like an official government site/page (a city/county/state/federal government domain or a page clearly published by one), or another clearly authoritative source (e.g. an official press release). False for a news article, blog, campaign site, Wikipedia, or anything else that isn't the official's own government source.",
  "jurisdiction": {
    "city": "string or null — the city/town/village name, if this is a municipal or county official (do not include 'County' here if county-level; put that in county below)",
    "county": "string or null — the county name, when this is a county-level office or the page states the county",
    "state": "string or null, 2-letter USPS code",
    "level": "one of 'local', 'county', 'state', 'federal', or null if you can't tell",
    "body": "string or null, the governing body, e.g. 'Austin City Council' or 'Travis County Commissioners Court'"
  },
  "officials": [
    {
      "name": "string, full name",
      "office": "string, e.g. 'Mayor', 'City Council Member', 'County Commissioner'",
      "district": "string or null",
      "phone": "string or null",
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
- Only include people who are CURRENT officials clearly shown on this page. Do not invent data,
  and do not include a former official, a candidate who hasn't taken office, or someone merely
  mentioned in passing (e.g. quoted in a news story about someone else).
- If a field is not on the page, use null. Never guess phone numbers, emails, or social links.
- Convert relative photo/link URLs to absolute using the page URL provided.
- Use the images/social links list the same way extractOfficials() does elsewhere in this
  project: as candidates to match to a specific named official via their surrounding text, never
  attaching a shared jurisdiction-wide logo/account to any one person.
- If the page is not in English, still extract normally, but write every text field (office,
  body, district, address) in English — translate it rather than passing through the source
  language. The one exception is "name": always transcribe an official's name exactly as printed
  on the page, in its original script/spelling — never translate or anglicize a person's name.
- If the page is not a legitimate government (or otherwise clearly authoritative) source, set
  is_government_source to false. You may still report what you see, but a lower confidence is
  appropriate for anything sourced from a non-government page.
- If you cannot determine the jurisdiction with reasonable confidence, leave the unclear
  jurisdiction fields null rather than guessing.
- If the page has no officials at all (wrong page, navigation only, a general news topic page),
  return an empty officials list.`;

export async function extractOfficialSubmission({ text, url, media }) {
  const cfg = resolveLLMConfig();
  const maxChars = Number(process.env.LLM_MAX_CHARS || cfg.preset.maxChars || 24000);
  const clipped = text.slice(0, maxChars);
  const user = `Page URL: ${url}

Images and social links found on this page:
${formatMediaBlock(media)}

Page text:
"""
${clipped}
"""`;

  const raw = await callLLM({ system: SUBMISSION_SYSTEM_PROMPT, user });
  const parsed = extractJson(raw);
  const officials = Array.isArray(parsed?.officials) ? parsed.officials : [];
  const jurisdiction = parsed?.jurisdiction && typeof parsed.jurisdiction === "object" ? parsed.jurisdiction : {};
  return {
    isGovernmentSource: parsed?.is_government_source === true,
    jurisdiction: {
      city: jurisdiction.city || null,
      county: jurisdiction.county || null,
      state: jurisdiction.state || null,
      level: jurisdiction.level || null,
      body: jurisdiction.body || null,
    },
    officials,
  };
}

export async function extractOfficialDetail({ text, url, name, office, media }) {
  const cfg = resolveLLMConfig();
  const maxChars = Number(process.env.LLM_MAX_CHARS || cfg.preset.maxChars || 24000);
  const clipped = text.slice(0, maxChars);
  const user = `Page URL: ${url}
Official this page should be about: ${name}${office ? ` (${office})` : ""}

Images and social links found on this page:
${formatMediaBlock(media)}

Page text:
"""
${clipped}
"""`;

  const raw = await callLLM({ system: DETAIL_SYSTEM_PROMPT, user });
  const parsed = extractJson(raw);
  return parsed && typeof parsed === "object" ? parsed : null;
}
