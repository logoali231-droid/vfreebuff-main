// orchestrator.js — AI Orchestrator Module (mod selection).
// Asks the chosen LLM to act as a Minecraft Modpack Architect and return a
// strict JSON array of 15-20 Modrinth slugs matching the user's theme,
// then validates/dedupes the list before any Modrinth API call is made.
import { callLlm, extractJson, LlmError } from './llm.js';
import { resolveProvider } from './providers.js';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

const SYSTEM_PROMPT = `You are a Minecraft Modpack Architect with encyclopedic knowledge of mods distributed on Modrinth (https://modrinth.com).
You design cohesive, technically compatible mod selections for a given Minecraft version and mod loader.

OUTPUT CONTRACT (validated by machine — an invalid answer is rejected and sent back to you once):
- ONE strict JSON array, 15-20 objects, each with EXACTLY the keys "name" and "slug" — no other keys, no markdown, no commentary.
- Every "slug" is unique and every entry must support BOTH the requested Minecraft version AND the requested mod loader; entries that fail a deterministic Modrinth version/loader/dependency check are removed from the pack.

Rules:
- Only recommend mods that ACTUALLY EXIST on Modrinth and support the exact Minecraft version AND mod loader requested. Guessing a slug is worse than omitting the mod.
- The "slug" must be the exact Modrinth project slug (lowercase, as appears in modrinth.com/mod/<slug>). If you are unsure of the exact slug, do not include that mod.
- Exclude client-side performance mods unless the theme asks for them; exclude mods that duplicate each other.
- Library/API dependencies that are normally installed standalone (e.g. Fabric API, GeckoLib, FTB Libraries, FramedBlocks) ARE welcome as entries.
- Prefer a balanced core set: content/technology, world generation, utility, QoL, and performance fixes that work together.`;

export function buildModPrompt({ prompt, minecraftVersion, modLoader, modCount }) {
  return `Theme requested by the user (free-form):
"""
${prompt}
"""

Target: Minecraft ${minecraftVersion}, mod loader: ${modLoader}.

Return a strict JSON array of exactly ${modCount} mods (15-20) best matching this theme.
Output format — nothing but JSON, no markdown, no commentary:
[{"name": "Create", "slug": "create"}, {"name": "JEI", "slug": "jei"}]
- "name": human-readable mod name.
- "slug": exact Modrinth slug for that mod.
The array must contain between 15 and 20 objects and every slug must be unique.`;
}

/** Validate the LLM's mod list. Returns { mods, warnings } or throws. */
export function validateModList(raw) {
  const warnings = [];
  if (!Array.isArray(raw)) {
    if (raw && Array.isArray(raw.mods)) raw = raw.mods;   // tolerate {"mods": [...]}
    else throw new LlmError('LLM did not return a JSON array of mods');
  }
  const seen = new Set();
  const mods = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') { warnings.push(`skipped non-object entry ${JSON.stringify(entry)}`); continue; }
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const slug = typeof entry.slug === 'string' ? entry.slug.trim().toLowerCase() : '';
    if (!slug || !SLUG_RE.test(slug)) { warnings.push(`skipped invalid slug "${entry.slug ?? ''}"`); continue; }
    if (seen.has(slug)) { warnings.push(`duplicate slug "${slug}" removed`); continue; }
    seen.add(slug);
    mods.push({ name: name || slug, slug });
  }
  if (mods.length === 0) throw new LlmError('LLM returned zero valid mods');
  if (mods.length < 15) warnings.push(`only ${mods.length} valid mods returned (target 15-20)`);
  if (mods.length > 20) { warnings.push(`LLM returned ${mods.length} mods; capped at 20`); mods.length = 20; }
  return { mods, warnings };
}

/**
 * Run the AI orchestrator: prompt -> strict JSON mod list.
 * Retries once with the parse/validation error fed back to the model.
 */
export async function selectMods({ prompt, minecraftVersion, modLoader, modCount = 18, cfg, log, fetchImpl = fetch }) {
  const provider = cfg.provider;
  const rp = resolveProvider(cfg, provider);
  if (!rp) throw new LlmError(`Unknown provider "${provider}"`, { provider });
  const base = {
    provider: rp.id,
    kind: rp.kind,
    baseUrl: rp.baseUrl,
    apiKey: rp.apiKey,
    noKey: rp.noKey,
    jsonMode: rp.jsonMode,
    model: rp.model,
    system: SYSTEM_PROMPT,
    timeoutMs: cfg.requestTimeoutMs,
    fetchImpl,
  };

  const userPrompt = buildModPrompt({ prompt, minecraftVersion, modLoader, modCount });
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = attempt === 1
      ? userPrompt
      : `${userPrompt}\n\nYour previous answer was invalid: ${lastError.message}
Respond AGAIN with ONLY the raw JSON array (no fences, no prose) of 15-20 unique valid mods.`;

    log?.info(`Sending mod-selection prompt to ${provider} (${base.model}), attempt ${attempt}/2…`, 'mods');
    const raw = await callLlm({ ...base, user, json: true });
    try {
      const { mods, warnings } = validateModList(extractJson(raw));
      for (const w of warnings) log?.warn(w, 'mods');
      log?.success(`LLM selected ${mods.length} mods: ${mods.map((m) => m.slug).join(', ')}`, 'mods');
      return { mods, provider, model: base.model };
    } catch (err) {
      lastError = err;
      log?.warn(`Malformed LLM mod list: ${err.message}`, 'mods');
    }
  }
  throw lastError ?? new LlmError('mod selection failed');
}
