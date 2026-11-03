// config.js — persistent local configuration (config.json, chmod 0600).
// API keys are stored here and are NEVER returned in full to the browser.
// Per-provider keys/models/base-URLs live under `api`:
//   api: { [providerId]: { apiKey, model, baseUrl } }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProviderId, PROVIDERS } from './providers.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(ROOT, 'config.json');

export const DEFAULTS = Object.freeze({
  provider: 'openai',
  api: {},                    // { [providerId]: { apiKey, model, baseUrl } }
  exportFtbSnbt: true,        // also export FTB Quests .snbt next to questbook.json
  minecraftVersion: '1.20.1',
  modLoader: 'forge',         // 'forge' | 'fabric' | 'neoforge' | 'quilt'
  instanceDir: '',            // Prism Launcher instance directory
  modCount: 18,               // target number of mods (15-20)
  requestTimeoutMs: 120000,   // per-LLM-call timeout
});

const KEYS = new Set(Object.keys(DEFAULTS));

/** Keep only known provider ids with string fields; drop everything else. */
function sanitizeApi(rawApi) {
  const out = {};
  if (!rawApi || typeof rawApi !== 'object') return out;
  for (const [id, v] of Object.entries(rawApi)) {
    if (!isProviderId(id) || !v || typeof v !== 'object') continue;
    const entry = {};
    for (const f of ['apiKey', 'model', 'baseUrl']) {
      if (typeof v[f] === 'string') entry[f] = v[f];
    }
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return out;
}

/** Fold the pre-multi-provider single-key fields into the `api` map. */
function migrateLegacy(raw) {
  const api = {};
  if (typeof raw.openaiApiKey === 'string' && raw.openaiApiKey) {
    api.openai = { apiKey: raw.openaiApiKey };
    if (typeof raw.openaiModel === 'string' && raw.openaiModel) api.openai.model = raw.openaiModel;
  }
  if (typeof raw.geminiApiKey === 'string' && raw.geminiApiKey) {
    api.gemini = { apiKey: raw.geminiApiKey };
    if (typeof raw.geminiModel === 'string' && raw.geminiModel) api.gemini.model = raw.geminiModel;
  }
  return api;
}

/** Read config from disk, merged over defaults. Missing/corrupt file -> defaults. */
export function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Corrupt config: keep going with defaults rather than crashing the app.
      console.warn(`[config] Could not read ${CONFIG_PATH} (${err.message}); using defaults.`);
    }
    raw = {};
  }
  const out = { ...DEFAULTS };
  for (const k of KEYS) {
    if (k === 'api') continue;
    if (raw[k] !== undefined && typeof raw[k] === typeof DEFAULTS[k]) out[k] = raw[k];
  }
  out.api = { ...migrateLegacy(raw), ...sanitizeApi(raw.api) };
  if (!isProviderId(out.provider)) out.provider = DEFAULTS.provider;
  return out;
}

/**
 * Merge a patch into the config and persist. Unknown keys are ignored.
 * `patch.api` merges per provider: { groq: { apiKey: 'gsk-…', model: '…' } }.
 * An empty apiKey string clears the saved key for that provider.
 */
export function saveConfig(patch = {}) {
  const current = loadConfig();
  for (const k of KEYS) {
    if (k === 'api' || k === 'provider') continue;
    if (patch[k] !== undefined && typeof patch[k] === typeof DEFAULTS[k]) {
      current[k] = patch[k];
    }
  }
  if (patch.provider !== undefined && isProviderId(patch.provider)) current.provider = patch.provider;
  if (patch.api !== undefined && patch.api !== null && typeof patch.api === 'object') {
    for (const [id, v] of Object.entries(patch.api)) {
      if (!isProviderId(id) || !v || typeof v !== 'object') continue;
      const entry = { ...(current.api[id] ?? {}) };
      if (typeof v.apiKey === 'string') {
        if (v.apiKey === '') delete entry.apiKey;
        else entry.apiKey = v.apiKey;
      }
      if (typeof v.model === 'string') entry.model = v.model.slice(0, 120);
      if (typeof v.baseUrl === 'string') entry.baseUrl = v.baseUrl.slice(0, 300);
      if (Object.keys(entry).length > 0) current.api[id] = entry;
      else delete current.api[id]; // last field cleared -> drop the provider entry
    }
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* best effort on exotic FS */ }
  return current;
}

/** Mask a secret for the UI: keeps shape without exposing the value. */
export function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

/** Config as safe-for-browser JSON (secrets masked, presence flags added). */
export function publicConfig() {
  const cfg = loadConfig();
  const api = {};
  for (const id of Object.keys(PROVIDERS)) {
    const v = cfg.api[id] ?? {};
    api[id] = {
      keyMasked: maskSecret(v.apiKey ?? ''),
      keySet: Boolean(v.apiKey),
      model: v.model ?? '',
      baseUrl: v.baseUrl ?? '',
    };
  }
  return {
    provider: cfg.provider,
    api,
    exportFtbSnbt: cfg.exportFtbSnbt,
    minecraftVersion: cfg.minecraftVersion,
    modLoader: cfg.modLoader,
    instanceDir: cfg.instanceDir,
    modCount: cfg.modCount,
    requestTimeoutMs: cfg.requestTimeoutMs,
  };
}
