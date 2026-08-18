// AI extraction. This is the core of the "works for any layout" approach: instead of
// per-site CSS selectors, we hand a page's visible text to an LLM and ask for a strict
// JSON list of officials. Adding a new city = adding a URL, not writing a parser.
//
// PROVIDER-AGNOSTIC. Most free LLM APIs expose an OpenAI-compatible /chat/completions
// endpoint, so a single "openai" path covers Groq, Gemini, Mistral, Cerebras, GitHub
// Models, OpenRouter, NVIDIA NIM and more. Pick one with LLM_PRESET (see PRESETS below)
// or point LLM_BASE_URL/LLM_MODEL anywhere. Anthropic uses its own Messages API shape.
//
// Config:
//   LLM_PRESET    groq | gemini | mistral | cerebras | github | openrouter | nvidia |
//                 samba | llm7 | ovh | anthropic        (default: anthropic)
//   LLM_API_KEY   provider key. Falls back to ANTHROPIC_API_KEY / GITHUB_TOKEN.
//   LLM_MODEL     override the preset's default model
//   LLM_BASE_URL  override the preset's base URL (any OpenAI-compatible endpoint)
//   LLM_RPM       client-side throttle, requests/minute (free tiers are rate-limited)
//
// Free tiers are limited by REQUESTS, not dollars, so this module throttles and retries
// on 429/5xx with backoff (honoring Retry-After) rather than failing the run.

const PRESETS = {
  anthropic: {
    api: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-haiku-4-5-20251001",
    rpm: 0,
  },
  // --- free tiers, all OpenAI-compatible ---
  groq: {
    api: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    rpm: 25, // limit 30 RPM
  },
  gemini: {
    // Google's OpenAI-compatibility endpoint.
    api: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    rpm: 12, // limit 15 RPM
  },
  mistral: {
    api: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-small-latest",
    rpm: 50, // ~1 RPS
  },
  cerebras: {
    api: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    model: "gpt-oss-120b",
    rpm: 4, // limit 5 RPM, 30K TPM
  },
  github: {
    // Uses the GITHUB_TOKEN already present in Actions — no extra secret to configure.
    api: "openai",
    baseUrl: "https://models.github.ai/inference",
    model: "openai/gpt-4.1-mini",
    rpm: 12, // limit 15 RPM, 150 RPD
  },
  openrouter: {
    api: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-oss-20b:free",
    rpm: 15, // limit 20 RPM, 50 RPD
  },
  nvidia: {
    api: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "meta/llama-3.3-70b-instruct",
    rpm: 30, // ~40 RPM, no daily token cap
  },
  samba: {
    api: "openai",
    baseUrl: "https://api.sambanova.ai/v1",
    model: "Meta-Llama-3.3-70B-Instruct",
    rpm: 15, // 20 RPM, 20 RPD
  },
  llm7: {
    api: "openai",
    baseUrl: "https://api.llm7.io/v1",
    model: "gpt-4o-mini",
    rpm: 25,
  },
  ovh: {
    // Anonymous tier needs no API key at all (2 RPM per IP per model).
    api: "openai",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    model: "Mistral-Small-3.2-24B-Instruct-2506",
    rpm: 2,
  },
};

const presetName = process.env.LLM_PRESET || "anthropic";
const preset = PRESETS[presetName];
if (!preset) {
  throw new Error(
    `Unknown LLM_PRESET "${presetName}". Options: ${Object.keys(PRESETS).join(", ")}`
  );
}

const API = preset.api;
const BASE_URL = process.env.LLM_BASE_URL || preset.baseUrl;
// SCRAPER_MODEL kept for backwards compatibility with the original Anthropic-only version.
const MODEL = process.env.LLM_MODEL || process.env.SCRAPER_MODEL || preset.model;
const RPM = Number(process.env.LLM_RPM || preset.rpm || 0);
const API_KEY =
  process.env.LLM_API_KEY ||
  (API === "anthropic" ? process.env.ANTHROPIC_API_KEY : null) ||
  (presetName === "github" ? process.env.GITHUB_TOKEN : null) ||
  "";

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
  // Models are instructed to return pure JSON, but be defensive about stray fencing/prose.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return { officials: [] };
  return JSON.parse(raw.slice(start, end + 1));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Client-side throttle so we stay under the provider's requests/minute cap.
let lastCallAt = 0;
async function throttle() {
  if (!RPM) return;
  const minGap = 60000 / RPM;
  const wait = lastCallAt + minGap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

function buildRequest({ text, url, jurisdiction }) {
  const userContent = `Page URL: ${url}
Jurisdiction: ${jurisdiction.body} (${jurisdiction.city}, ${jurisdiction.state})

Page text:
"""
${text}
"""`;

  if (API === "anthropic") {
    return {
      endpoint: `${BASE_URL}/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      },
    };
  }

  // OpenAI-compatible (Groq, Gemini, Mistral, Cerebras, GitHub Models, OpenRouter, ...)
  const headers = { "content-type": "application/json" };
  // OVH's anonymous tier takes no key; everyone else uses a bearer token.
  if (API_KEY) headers.authorization = `Bearer ${API_KEY}`;
  return {
    endpoint: `${BASE_URL}/chat/completions`,
    headers,
    body: {
      model: MODEL,
      max_tokens: 4096,
      temperature: 0,
      // Ask for JSON where the provider supports it; harmless hint where it doesn't,
      // and extractJson() still handles prose-wrapped output.
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    },
  };
}

function readModelText(data) {
  if (API === "anthropic") {
    return data?.content?.map((c) => c.text || "").join("") || "";
  }
  return data?.choices?.[0]?.message?.content || "";
}

export async function extractOfficials({ text, url, jurisdiction }) {
  if (!API_KEY && presetName !== "ovh") {
    throw new Error(
      `No API key. Set LLM_API_KEY (or ANTHROPIC_API_KEY for the anthropic preset, ` +
        `GITHUB_TOKEN for the github preset).`
    );
  }

  // Cap page text so a huge page can't blow up token use. Officials are almost always in a
  // roster block near the top; 24k chars is plenty for a council page and stays under the
  // tighter free-tier per-request input limits (e.g. GitHub Models' 8K tokens).
  const clipped = text.slice(0, 24000);
  const { endpoint, headers, body } = buildRequest({ text: clipped, url, jurisdiction });

  const MAX_ATTEMPTS = 4;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    let res;
    try {
      res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (err) {
      lastErr = new Error(`network error: ${err.message}`);
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }

    // Rate limited or provider hiccup — back off and retry. Free tiers hit 429 routinely,
    // so this is the normal path, not an exceptional one.
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * 2 ** (attempt - 1);
      lastErr = new Error(`${presetName} HTTP ${res.status}`);
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`    ${presetName} ${res.status}; retrying in ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }
      throw lastErr;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`${presetName} HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    let parsed;
    try {
      parsed = extractJson(readModelText(data));
    } catch {
      parsed = { officials: [] };
    }
    return Array.isArray(parsed.officials) ? parsed.officials : [];
  }
  throw lastErr || new Error("extraction failed");
}
