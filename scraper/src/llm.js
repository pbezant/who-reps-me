// Shared LLM plumbing: provider presets, config resolution, and the throttled/retried HTTP
// call itself. Split out of extract.js so discover.js (site lookup) can reuse the exact same
// provider config instead of a second copy of the PRESETS table drifting out of sync.
//
// PROVIDER-AGNOSTIC. Most free LLM APIs expose an OpenAI-compatible /chat/completions
// endpoint, so a single "openai" path covers Groq, Gemini, Mistral, Cerebras, OpenRouter,
// NVIDIA NIM and more. Pick one with LLM_PRESET (see PRESETS below) or point
// LLM_BASE_URL/LLM_MODEL anywhere. Anthropic uses its own Messages API shape.
//
// Config:
//   LLM_PRESET    groq | gemini | mistral | cerebras | github | openrouter | nvidia |
//                 samba | llm7 | ovh | anthropic        (default: ovh)
//   LLM_API_KEY   provider key. Falls back to ANTHROPIC_API_KEY / GITHUB_TOKEN.
//   LLM_MODEL     override the preset's default model
//   LLM_BASE_URL  override the preset's base URL (any OpenAI-compatible endpoint)
//   LLM_RPM       client-side throttle, requests/minute (free tiers are rate-limited)

export const PRESETS = {
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
    // RETIRED: GitHub Models is being shut down and now answers with
    // HTTP 410 github_models_retirement_brownout. Kept only so an existing
    // LLM_PRESET=github fails with a clear message instead of an unknown-preset error.
    retired: "GitHub Models has been retired by GitHub and returns HTTP 410.",
    api: "openai",
    baseUrl: "https://models.github.ai/inference",
    model: "openai/gpt-4.1-mini",
    rpm: 12, // limit 15 RPM, 150 RPD
    maxChars: 18000,
    maxOutput: 4000,
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
    // Anonymous tier needs no API key at all (2 RPM per IP per model). Fine for the batch
    // cron; too slow for a synchronous request from a live user (see discover.js/local
    // Netlify function) — pick a faster preset via LLM_PRESET for that path.
    api: "openai",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    model: "Mistral-Small-3.2-24B-Instruct-2506",
    rpm: 2,
  },
};

export function resolveLLMConfig() {
  const presetName = process.env.LLM_PRESET || "ovh";
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(
      `Unknown LLM_PRESET "${presetName}". Options: ${Object.keys(PRESETS).join(", ")}`
    );
  }

  const api = preset.api;
  const baseUrl = process.env.LLM_BASE_URL || preset.baseUrl;
  // SCRAPER_MODEL kept for backwards compatibility with the original Anthropic-only version.
  const model = process.env.LLM_MODEL || process.env.SCRAPER_MODEL || preset.model;
  const rpm = Number(process.env.LLM_RPM || preset.rpm || 0);
  const maxOutput = Number(process.env.LLM_MAX_OUTPUT || preset.maxOutput || 4096);
  const apiKey =
    process.env.LLM_API_KEY ||
    (api === "anthropic" ? process.env.ANTHROPIC_API_KEY : null) ||
    (presetName === "github" ? process.env.GITHUB_TOKEN : null) ||
    "";

  return { presetName, preset, api, baseUrl, model, rpm, maxOutput, apiKey };
}

function extractJson(text) {
  // Models are instructed to return pure JSON, but be defensive about stray fencing/prose.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A provider that is retired, unauthorized or missing will fail identically on every call.
// Marking those errors fatal lets callers stop after the first one instead of grinding
// through retries that can't possibly succeed.
const FATAL_STATUSES = new Set([401, 403, 404, 410]);

export function fatalError(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

// Client-side throttle so we stay under the provider's requests/minute cap. One shared
// timestamp per process — fine for both the batch scraper (single-threaded loop) and a
// Netlify Function invocation (one call per invocation).
let lastCallAt = 0;
async function throttle(rpm) {
  if (!rpm) return;
  const minGap = 60000 / rpm;
  const wait = lastCallAt + minGap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

function buildRequest({ system, user, maxOutput, jsonMode }, cfg) {
  if (cfg.api === "anthropic") {
    return {
      endpoint: `${cfg.baseUrl}/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: cfg.model,
        max_tokens: maxOutput,
        system,
        messages: [{ role: "user", content: user }],
      },
    };
  }

  // OpenAI-compatible (Groq, Gemini, Mistral, Cerebras, OpenRouter, ...)
  const headers = { "content-type": "application/json" };
  // OVH's anonymous tier takes no key; everyone else uses a bearer token.
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  return {
    endpoint: `${cfg.baseUrl}/chat/completions`,
    headers,
    body: {
      model: cfg.model,
      max_tokens: maxOutput,
      temperature: 0,
      // Only force JSON-object output when the caller actually wants JSON (extract.js). Most
      // providers 400 (or otherwise misbehave) if json_object mode is requested but the prompt
      // doesn't ask the model for JSON — discover.js asks for a bare URL, not an object.
      ...(jsonMode !== false ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
  };
}

function readModelText(data, api) {
  if (api === "anthropic") {
    return data?.content?.map((c) => c.text || "").join("") || "";
  }
  return data?.choices?.[0]?.message?.content || "";
}

// Low-level call: system + user text in, raw model text out. Retries on 429/5xx with backoff
// (honoring Retry-After), throttled to the preset's RPM. Callers parse the response shape
// they expect (extract.js wants JSON officials, discover.js wants a bare URL).
export async function callLLM({ system, user, maxOutput, jsonMode = true, maxAttempts = 4 } = {}) {
  const cfg = resolveLLMConfig();
  if (cfg.preset.retired) {
    throw fatalError(
      `LLM_PRESET="${cfg.presetName}" is no longer usable: ${cfg.preset.retired} ` +
        `Pick another preset (ovh needs no key; groq/gemini/mistral need LLM_API_KEY).`
    );
  }
  if (!cfg.apiKey && cfg.presetName !== "ovh") {
    throw fatalError(
      `No API key. Set LLM_API_KEY (or ANTHROPIC_API_KEY for the anthropic preset).`
    );
  }

  const { endpoint, headers, body } = buildRequest(
    { system, user, maxOutput: maxOutput || cfg.maxOutput, jsonMode },
    cfg
  );

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await throttle(cfg.rpm);
    let res;
    try {
      res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (err) {
      lastErr = new Error(`network error: ${err.message}`);
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
      lastErr = new Error(`${cfg.presetName} HTTP ${res.status}`);
      if (attempt < maxAttempts) {
        await sleep(waitMs);
        continue;
      }
      throw lastErr;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const message = `${cfg.presetName} HTTP ${res.status}: ${errText.slice(0, 300)}`;
      throw FATAL_STATUSES.has(res.status) ? fatalError(message) : new Error(message);
    }

    const data = await res.json();
    return readModelText(data, cfg.api);
  }
  throw lastErr || new Error("LLM call failed");
}

export { extractJson };
