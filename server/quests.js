// quests.js — AI Questline Generator, now built around the app's OWN
// questbook format. The LLM produces questbook JSON (which models do
// reliably), questbook.js validates/repairs it, and it is written as
// <instance>/config/modpackquestforge/questbook.json — the source of truth
// the in-app questbook reader renders. FTB Quests .snbt export is OPTIONAL
// (cfg.exportFtbSnbt) and always derived from the validated questbook,
// never authored by the model.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { callLlm, extractJson, LlmError } from './llm.js';
import { resolveProvider } from './providers.js';
import {
  CHAPTER_COUNT, normalizeQuestbook, writeQuestbook, questbookToChapters,
  structuralViolations, certifyQuestbook,
} from './questbook.js';
import { parseSnbt } from './snbt.js';

const SYSTEM_PROMPT = `You are a senior Minecraft quest designer creating a campaign for a modpack.
You design quests as clean, strict JSON — never SNBT or any game-specific file format.

NON-NEGOTIABLE STRUCTURE (a machine validates your answer against these rules; violations are rejected and sent back to you for one retry):
1. Output ONE JSON object { "packTitle": string, "chapters": [ … ] } — exactly ${CHAPTER_COUNT} chapters in order, no markdown, no commentary, no extra keys.
2. Every chapter: unique non-empty "title", "icon" (a real item id, e.g. "minecraft:book"), a one-sentence "description", and 4-6 entries in "quests" — never fewer, never more.
3. Every quest: unique "title" (unique across the WHOLE book), "description" (1-3 friendly sentences telling the player WHY and HOW), integer "x"/"y", 1-4 "tasks", 0-3 "rewards", and a "dependencies" array (empty ONLY for chapter-1 entry quests).
4. Progression arc: nothing outside chapter 1 may be open at game start. The first quest of chapter 2 and the first quest of chapter 3 list in "dependencies" the EXACT title of the previous chapter's final quest; every other quest depends on quests in its own chapter (or an earlier one).
5. "dependencies" entries must EXACTLY match the title of a quest you wrote — copy-paste it. Never use a chapter title or mod name as a dependency, and never create circular dependencies.
6. Tasks, only these three shapes: {"type":"item","item":"ns:id","count":N,"title":"…"} / {"type":"kill","entity":"ns:id","count":N,"title":"…"} / {"type":"checkmark","title":"…"}.
7. Rewards, only these three shapes: {"type":"item","item":"ns:id","count":N} / {"type":"xp","xp":N} / {"type":"command","command":"/give @s …"}.
8. Item and entity ids are lowercase "namespace:path" and must exist in vanilla Minecraft or in the installed mod list below — never invent ids.
9. Layout: x/y on an even-numbered grid (0, 2, 4…); each quest sits to the RIGHT of its same-chapter dependencies, spacing 2, x grows right, y grows downward, no overlapping tiles.

Design goals — this is where you succeed or fail (structure itself cannot):
- Exactly ${CHAPTER_COUNT} chapters forming a progression arc: onboarding -> mid-game mastery of the pack's theme -> climactic endgame.
- Each chapter a progression tree of 4-6 quests; titles short and thematic; descriptions friendly and concrete; rewards modest and thematic.

Output format — NOTHING else. A single strict JSON object, no markdown fences, no commentary:
{
  "packTitle": "Name of the modpack",
  "chapters": [
    {
      "title": "Chapter Title",
      "icon": "minecraft:book",
      "description": "One sentence setting the chapter's theme.",
      "quests": [
        {
          "title": "Quest Title",
          "subtitle": "Optional short flavour line under the title",
          "x": 0, "y": 0,
          "description": "What the player does and why.",
          "dependencies": ["Title of the quest this depends on"],
          "tasks": [{ "type": "item", "item": "minecraft:oak_log", "count": 8, "title": "Collect oak logs" }],
          "rewards": [{ "type": "xp", "xp": 50 }]
        }
      ]
    }
  ]
}`;

export function buildQuestPrompt({ prompt, mods, minecraftVersion, modLoader }) {
  const modList = mods.map((m) => `- ${m.name} (${m.slug})${m.version ? ` ${m.version}` : ''}`).join('\n');
  return `Theme requested by the user:
"""
${prompt}
"""

Target: Minecraft ${minecraftVersion}, loader: ${modLoader}.
Mods installed in this pack (use THEIR item ids in tasks where fitting):
${modList || '(no mod list available — use minecraft: namespace items)'}

Design a full campaign in exactly ${CHAPTER_COUNT} logical progression chapters:
1. Chapter 1 — onboarding / early game (4-6 quests, gentle tutorials).
2. Chapter 2 — mid-game mastery of the pack's core theme (4-6 quests, real item sinks).
3. Chapter 3 — endgame / finale with a climactic final quest (4-6 quests).
Chain quests with dependencies so each chapter reads as a progression tree.
Gate the arc across chapters: the first quest of chapter 2 must depend on the LAST quest of chapter 1, and the first quest of chapter 3 on the LAST quest of chapter 2 — reference them by their exact titles.
Return ONLY the strict JSON questbook object described in your instructions.`;
}

/**
 * Item namespaces (modids) that are known to exist in this pack.
 * Derived from downloaded Modrinth slugs: slug, de-dashed, and first segment
 * (covers e.g. farmers-delight -> farmersdelight, ftb-quests -> ftbquests).
 * Used for WARN-ONLY sanity checks — slug != modid often enough that we
 * never reject an item on this basis, only flag likely hallucinations.
 */
export function namespaceCandidates(mods) {
  const s = new Set(['minecraft', 'ftbquests', 'ftbteams', 'ftblibrary', 'ftbedit']);
  for (const m of mods ?? []) {
    const slug = String(m?.slug ?? '').toLowerCase();
    if (!slug) continue;
    s.add(slug);
    s.add(slug.replace(/[-_]/g, ''));
    s.add(slug.split(/[-_]/)[0]);
  }
  return s;
}

const SCHEMA_REMINDER = `Reply with ONLY the strict JSON object (single { "packTitle": ..., "chapters": [...] } structure, no fences, no prose). Exactly ${CHAPTER_COUNT} chapters, 4-6 quests each, dependencies by quest title.`;

/**
 * Generate, validate and write the pack questbook (+ optional SNBT export).
 * Two LLM attempts with the validation error fed back, then a hard failure —
 * no partially-written output is ever left behind.
 * @returns {Promise<{questbookFile:string, questbook:object, files:string[], chapters:Array}>}
 */
export async function generateQuests({ prompt, mods, minecraftVersion, modLoader, cfg, log, fetchImpl = fetch }) {
  const knownNs = namespaceCandidates(mods);
  const rp = resolveProvider(cfg, cfg.provider);
  if (!rp) throw new LlmError(`Unknown provider "${cfg.provider}"`, { provider: cfg.provider });
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
  const userPrompt = buildQuestPrompt({ prompt, mods, minecraftVersion, modLoader });
  const normOpts = {
    prompt,
    minecraftVersion,
    modLoader,
    knownNamespaces: knownNs,
    warn: (msg) => log?.warn(msg, 'quests'),
  };

  let lastError = null;
  let questbook = null;

  for (let attempt = 1; attempt <= 2 && !questbook; attempt++) {
    const user = attempt === 1
      ? userPrompt
      : `${userPrompt}\n\nYour previous answer was rejected: ${lastError.message}\n${SCHEMA_REMINDER}`;
    log?.info(`Requesting questbook JSON from ${rp.id} (${rp.model}), attempt ${attempt}/2…`, 'quests');
    try {
      const raw = await callLlm({ ...base, user, json: true });
      const data = extractJson(raw);
      if (attempt === 1) {
        // Strict pre-check of the RAW answer: violations are fed back for one retry.
        const violations = structuralViolations(data);
        if (violations.length > 0) {
          throw new LlmError(`structurally invalid questbook:\n- ${violations.join('\n- ')}`);
        }
      } else {
        log?.warn('second attempt: strict pre-check skipped — structural repair is applied deterministically instead', 'quests');
      }
      questbook = normalizeQuestbook(data, normOpts);
      log?.success(`LLM returned a valid questbook: ${questbook.chapters.length} chapters, ` +
        `${questbook.chapters.reduce((a, c) => a + c.quests.length, 0)} quests`, 'quests');
    } catch (err) {
      lastError = err;
      log?.warn(`Questbook attempt ${attempt} failed validation: ${err.message}`, 'quests');
    }
  }

  if (!questbook) {
    throw lastError ?? new LlmError('questbook generation failed');
  }

  // Re-certify the exact object that is about to be persisted (belt and braces:
  // normalizeQuestbook already certified it — this proves the round trip too).
  const certified = certifyQuestbook(questbook);
  log?.success(`structure certified: ${certified.assertions} invariants hold (chapters chained, DAG acyclic, ` +
    `ids unique, tasks/rewards/layout valid)`, 'quests');

  // Persist the canonical questbook (source of truth for the in-app reader).
  const questbookFile = await writeQuestbook(cfg.instanceDir, questbook);
  log?.success(`wrote ${path.relative(cfg.instanceDir, questbookFile)} (questbook v1)`, 'quests');

  // Optional FTB Quests export, derived from the validated questbook.
  const files = [];
  const chapters = [];
  if (cfg.exportFtbSnbt !== false) {
    const exported = questbookToChapters(questbook, {
      knownNamespaces: knownNs,
      warn: (msg) => log?.warn(msg, 'quests'),
    });
    const chaptersDir = path.join(cfg.instanceDir, 'config', 'ftbquests', 'quests', 'chapters');
    await fsp.mkdir(chaptersDir, { recursive: true });
    for (const ch of exported) {
      const file = path.join(chaptersDir, `${ch.stem}.snbt`);
      await fsp.writeFile(file, ch.snbt, 'utf8');
      parseSnbt(await fsp.readFile(file, 'utf8')); // round-trip proof
      files.push(file);
      log?.success(`wrote ${path.relative(cfg.instanceDir, file)} (${ch.title})`, 'quests');
    }
  } else {
    log?.info('FTB Quests SNBT export disabled — questbook.json is the only output.', 'quests');
  }

  return {
    questbookFile,
    questbook,
    files,
    chapters: questbook.chapters.map((c) => ({
      title: c.title,
      questCount: c.quests.length,
    })),
  };
}
