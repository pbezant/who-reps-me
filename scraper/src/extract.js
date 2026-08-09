// AI extraction. This is the core of the "works for any layout" approach: instead of
// per-site CSS selectors, we hand a page's visible text to Claude and ask for a strict
// JSON list of officials. Adding a new city = adding a URL, not writing a parser.
//
// Uses the Anthropic Messages API over raw fetch (no SDK dependency). Set ANTHROPIC_API_KEY.
// Model is configurable; default to a cheap/fast tier since we run this across tens of
// thousands of pages.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.SCRAPER_MODEL || "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You extract elected/appointed official records from the visible text of a US government web page.
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
      "address": "string or null, office address",
      "confidence": "number 0-1, how sure you are this is a real current official from this page"
    }
  ]
}
Rules:
- Only include people who are officials of THIS jurisdiction shown on the page. Do not invent data.
- If a field is not on the page, use null. Never guess phone numbers or emails.
- Convert relative photo/link URLs to absolute using the page URL provided.
- If the page has no officials (wrong page, navigation only), return {"officials": []}.`;

function extractJson(text) {
  // Model is instructed to return pure JSON, but be defensive about stray fencing.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return { officials: [] };
  return JSON.parse(raw.slice(start, end + 1));
}

export async function extractOfficials({ text, url, jurisdiction }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  // Cap page text so a huge page can't blow up token cost. Officials are almost always
  // near the top / in a roster block; 24k chars is plenty for a council page.
  const clipped = text.slice(0, 24000);

  const body = {
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Page URL: ${url}
Jurisdiction: ${jurisdiction.body} (${jurisdiction.city}, ${jurisdiction.state})

Page text:
"""
${clipped}
"""`,
      },
    ],
  };

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const modelText = data?.content?.map((c) => c.text || "").join("") || "";
  let parsed;
  try {
    parsed = extractJson(modelText);
  } catch {
    parsed = { officials: [] };
  }
  return Array.isArray(parsed.officials) ? parsed.officials : [];
}
