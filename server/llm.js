// llm.js — minimal LLM client for any OpenAI-compatible chat-completions
// endpoint (OpenAI, Groq, HuggingFace router, OpenRouter, Together, DeepSeek,
// Mistral, xAI, Ollama, custom) plus Google Gemini's native generateContent.
// Handles timeouts, transient-error retries, and robust JSON extraction.
export class LlmError extends Error {
  constructor(message, { status = 0, provider = '' } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.provider = provider;
  }
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function postJson(url, body, headers, timeoutMs, fetchImpl) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  return { res, text };
}

/**
 * Call the configured provider and return the raw text the model produced.
 * @param {object} o
 * @param {string} o.provider   provider id, for error messages
 * @param {'openai'|'gemini'} o.kind
 * @param {string} [o.baseUrl]  OpenAI-compatible base URL (no /chat/completions)
 * @param {string} [o.apiKey]
 * @param {string} o.model
 * @param {string} o.system
 * @param {string} o.user
 * @param {boolean} [o.json]     request JSON output when the provider supports it
 * @param {boolean} [o.jsonMode] whether this endpoint accepts response_format
 * @param {boolean} [o.noKey]    local endpoints (Ollama) — skip auth header
 * @param {number} [o.timeoutMs]
 * @param {typeof fetch} [o.fetchImpl]
 */
export async function callLlm({
  provider, kind = 'openai', baseUrl = '', apiKey = '', model,
  system, user, json = false, jsonMode = true, noKey = false,
  timeoutMs = 120000, fetchImpl = fetch,
}) {
  if (!model) throw new LlmError(`No model configured for ${provider}`, { provider });
  if (!apiKey && !noKey) throw new LlmError(`No API key configured for ${provider}`, { provider });

  const attempt = async () => {
    if (kind === 'gemini') {
      const root = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
      const url = `${root}/models/${encodeURIComponent(model)}:generateContent`;
      const body = {
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 8192 },
      };
      if (!system) delete body.systemInstruction;
      if (json) body.generationConfig.responseMimeType = 'application/json';
      const { res, text } = await postJson(url, body, { 'x-goog-api-key': apiKey }, timeoutMs, fetchImpl);
      if (!res.ok) {
        const snippet = text.slice(0, 400);
        throw new LlmError(`${provider} HTTP ${res.status}: ${snippet}`, { status: res.status, provider });
      }
      let data;
      try { data = JSON.parse(text); } catch {
        throw new LlmError(`${provider} returned a non-JSON response body`, { provider, status: res.status });
      }
      const parts = data?.candidates?.[0]?.content?.parts ?? [];
      const content = parts.map((p) => p.text ?? '').join('');
      if (!content.trim()) {
        const block = data?.promptFeedback?.blockReason ?? data?.candidates?.[0]?.finishReason ?? 'unknown';
        throw new LlmError(`${provider} returned an empty completion (${block})`, { provider });
      }
      return content;
    }

    // OpenAI-compatible chat completions (also Groq/HF/OpenRouter/etc.)
    const root = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const body = {
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user }],
      // OpenAI's newer models renamed the field; other endpoints want max_tokens.
      ...(provider === 'openai' ? { max_completion_tokens: 8192 } : { max_tokens: 8192 }),
    };
    if (json && jsonMode) body.response_format = { type: 'json_object' };
    const headers = {};
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const { res, text } = await postJson(`${root}/chat/completions`, body, headers, timeoutMs, fetchImpl);
    if (!res.ok) {
      const snippet = text.slice(0, 400);
      throw new LlmError(`${provider} HTTP ${res.status}: ${snippet}`, { status: res.status, provider });
    }
    let data;
    try { data = JSON.parse(text); } catch {
      throw new LlmError(`${provider} returned a non-JSON response body`, { provider, status: res.status });
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      const reason = data?.choices?.[0]?.finish_reason ?? 'unknown';
      throw new LlmError(`${provider} returned an empty completion (finish_reason=${reason})`, { provider });
    }
    return content;
  };

  // One retry for rate limits / transient server errors.
  try {
    return await attempt();
  } catch (err) {
    if (err instanceof LlmError && RETRYABLE.has(err.status)) {
      await sleep(1500);
      return attempt();
    }
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new LlmError(`${provider} request timed out after ${Math.round(timeoutMs / 1000)}s`, { provider });
    }
    if (err instanceof LlmError) throw err;
    throw new LlmError(`${provider} request failed: ${err.message}`, { provider });
  }
}

/**
 * Extract a JSON value from model output that may be wrapped in markdown
 * fences or surrounded by prose. Throws LlmError when nothing parses.
 */
export function extractJson(text) {
  const stripped = text
    .replace(/^\s*```(?:json|jsonc)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  const candidates = [stripped];
  const objStart = stripped.indexOf('{');
  const arrStart = stripped.indexOf('[');
  const start = [objStart, arrStart].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (start !== undefined) {
    const endObj = stripped.lastIndexOf('}');
    const endArr = stripped.lastIndexOf(']');
    const end = Math.max(endObj, endArr);
    if (end > start) candidates.push(stripped.slice(start, end + 1));
  }

  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  throw new LlmError('Model output did not contain parseable JSON');
}
