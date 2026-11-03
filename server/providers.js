// providers.js — registry of supported LLM providers.
// Everything except Gemini uses the OpenAI-compatible chat-completions API,
// so any custom/local endpoint (LM Studio, vLLM, LiteLLM, …) also works via
// the per-provider base URL override.
export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyHint: 'sk-…',
    jsonMode: true,
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-mini', 'gpt-5'],
  },
  groq: {
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyHint: 'gsk-…',
    jsonMode: true,
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen/qwen3-32b'],
  },
  huggingface: {
    label: 'HuggingFace',
    kind: 'openai',
    baseUrl: 'https://router.huggingface.co/v1',
    keyHint: 'hf-…',
    jsonMode: false, // router rejects response_format on some models
    models: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3-0324'],
  },
  openrouter: {
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'sk-or-…',
    jsonMode: true,
    models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4', 'meta-llama/llama-3.3-70b-instruct'],
  },
  together: {
    label: 'Together AI',
    kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    keyHint: '…',
    jsonMode: true,
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3'],
  },
  deepseek: {
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    keyHint: 'sk-…',
    jsonMode: true,
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  mistral: {
    label: 'Mistral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    keyHint: '…',
    jsonMode: true,
    models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
  },
  xai: {
    label: 'xAI (Grok)',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    keyHint: 'xai-…',
    jsonMode: true,
    models: ['grok-4', 'grok-3-mini'],
  },
  ollama: {
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    keyHint: 'not needed',
    jsonMode: false,
    noKey: true,
    models: ['llama3.1:8b', 'qwen2.5:14b', 'mistral:7b'],
  },
  gemini: {
    label: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyHint: 'AIza…',
    jsonMode: true,
    models: ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  },
};

export function isProviderId(id) {
  return Object.hasOwn(PROVIDERS, id);
}

/** Resolve effective settings for one provider from saved config. */
export function resolveProvider(cfg, providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return null;
  const saved = cfg?.api?.[providerId] ?? {};
  return {
    id: providerId,
    kind: p.kind,
    label: p.label,
    noKey: Boolean(p.noKey),
    jsonMode: p.jsonMode !== false,
    apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : '',
    model: saved.model || p.models[0],
    baseUrl: String(saved.baseUrl || p.baseUrl).replace(/\/+$/, ''),
    defaultBaseUrl: p.baseUrl,
    keyHint: p.keyHint,
    models: p.models,
  };
}

/** Static registry for the UI (no secrets, no per-user state). */
export function publicRegistry() {
  return Object.fromEntries(
    Object.entries(PROVIDERS).map(([id, p]) => [id, {
      label: p.label,
      kind: p.kind,
      defaultBaseUrl: p.baseUrl,
      keyHint: p.keyHint,
      noKey: Boolean(p.noKey),
      models: p.models,
    }]),
  );
}
