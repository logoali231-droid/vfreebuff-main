// questbook.js — the pack's OWN questbook system (canonical source of truth).
//
// Why: AI models reliably produce plain JSON, but frequently mangle FTB Quests
// SNBT (typed numbers, 16-hex ids, comma rules) — a single bad file breaks the
// whole pack. So the pipeline now asks the LLM for questbook JSON, validates
// and repairs it here, writes it as <instance>/config/modpackquestforge/
// questbook.json, and renders the questbook in the app itself (chapter tabs,
// quest tree, dependency-gated progress). FTB Quests .snbt export remains an
// OPTIONAL extra, derived from the validated questbook — never authored by AI.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { renderChapter, n } from './snbt.js';

export const QUESTBOOK_FORMAT = 'modpackquestforge/questbook@1';
export const CHAPTER_COUNT = 3;

/** Canonical questbook types — what the in-app reader renders and the SNBT export writes. */
export const QB_TASK_TYPES = Object.freeze(['item', 'kill', 'checkmark']);
export const QB_REWARD_TYPES = Object.freeze(['item', 'xp', 'command']);
/** Types accepted in RAW model output (FTB's `entity` alias is folded into `kill`). */
const RAW_TASK_TYPES = new Set([...QB_TASK_TYPES, 'entity']);
const MAX_DEPS = 4;

const ITEM_RE = /^[a-z0-9_.\-]+:[a-z0-9_./\-]+$/;
const ENTITY_RE = ITEM_RE; // entity ids share the namespace:path shape (minecraft:zombie)
const STR = (v, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);

function slugify(title, fallback) {
  const s = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return s || fallback;
}

/**
 * Validate + repair a raw LLM questbook into the canonical format.
 * Deterministic rules (no AI involved):
 *  - chapters trimmed/padded to 3, ordered, icons + descriptions validated
 *  - quests get stable ids; deps resolved by title (same chapter first, then
 *    pack-wide for cross-chapter gates), self/unknown deps dropped, cycles
 *    broken globally (a cycle = uncompletable quest)
 *  - layout repair: every quest sits to the RIGHT of its same-chapter deps,
 *    overlapping quests are shifted down (FTB-style grid cadence of 2)
 *  - tasks: item/kill/checkmark survive; empty task list -> checkmark
 *  - rewards: only item/xp/command survive
 *  - warn-only namespace sanity against the actually-installed mods
 */
export function normalizeQuestbook(raw, {
  prompt = '', minecraftVersion = '', modLoader = '',
  knownNamespaces = null, warn = () => {},
} = {}) {
  let rawChapters = null;
  if (Array.isArray(raw)) rawChapters = raw;
  else if (raw && Array.isArray(raw.chapters)) rawChapters = raw.chapters;
  if (!rawChapters || rawChapters.length === 0) {
    throw new Error('model returned no chapters');
  }
  if (rawChapters.length > CHAPTER_COUNT) {
    warn(`model returned ${rawChapters.length} chapters — only the first ${CHAPTER_COUNT} kept`);
  }

  const chapters = [];
  // raw dependency refs, keyed by the normalized quest — resolved in a second
  // pass once EVERY chapter's ids/titles exist (cross-chapter gates need that)
  const pendingDeps = new Map();
  for (let i = 0; i < CHAPTER_COUNT; i++) {
    const src = i < rawChapters.length ? rawChapters[i] : null;
    if (!src || typeof src !== 'object') {
      warn(`chapter ${i + 1} missing — padded with a placeholder quest`);
      chapters.push(padChapter(i));
      continue;
    }
    const title = STR(src.title, `Chapter ${i + 1}`);
    const icon = ITEM_RE.test(STR(src.icon)) ? STR(src.icon) : 'minecraft:book';
    const description = STR(src.description);
    const questsRaw = Array.isArray(src.quests) && src.quests.length > 0 ? src.quests : null;
    if (!questsRaw) {
      warn(`chapter "${title}" has no quests — padded with a placeholder quest`);
      chapters.push({ ...padChapter(i), title, icon, description });
      continue;
    }
    if (questsRaw.length < 4 || questsRaw.length > 6) {
      warn(`chapter "${title}" has ${questsRaw.length} quests (design target is 4-6)`);
    }
    if (questsRaw.length > 8) {
      warn(`chapter "${title}" returned ${questsRaw.length} quests — capped at 8`);
    }

    const quests = questsRaw.slice(0, 8).map((q, j) => normalizeQuest(q, j, i, { knownNamespaces, warn }));
    for (let j = 0; j < quests.length; j++) {
      pendingDeps.set(quests[j], Array.isArray(questsRaw[j]?.dependencies) ? questsRaw[j].dependencies : []);
    }
    chapters.push({ id: `c${i + 1}`, title, icon, description, orderIndex: i, quests });
  }

  uniquifyTitles(chapters, warn);

  // --- dependency resolution, pack-wide (FTB Quests resolves dependency ids
  // against the whole quest file, so a later chapter MAY be gated on an
  // earlier chapter's quest). Prefer a same-chapter title match, then fall
  // back to the earliest chapter that uses the title.
  const allQuests = chapters.flatMap((c) => c.quests);
  const globalByTitle = new Map();
  const globalById = new Map();
  for (const q of allQuests) {
    const key = q.title.toLowerCase();
    if (!globalByTitle.has(key)) globalByTitle.set(key, q.id);
    globalById.set(q.id, q.id);
  }
  for (const ch of chapters) {
    const localByTitle = new Map();
    for (const q of ch.quests) {
      const key = q.title.toLowerCase();
      if (!localByTitle.has(key)) localByTitle.set(key, q.id);
    }
    for (const q of ch.quests) {
      const rawDeps = pendingDeps.get(q) ?? [];
      const deps = [];
      for (const d of rawDeps) {
        if (typeof d !== 'string' || !d.trim()) continue;
        const key = d.trim();
        let targetId = ch.quests.find((x) => x.id === key)?.id
          ?? localByTitle.get(key.toLowerCase()) ?? null;
        if (!targetId) {
          const foreign = globalById.get(key) ?? globalByTitle.get(key.toLowerCase()) ?? null;
          if (foreign) {
            targetId = foreign;
            warn(`quest "${q.title}": "${key}" lives in another chapter — cross-chapter gate created`);
          }
        }
        if (!targetId) {
          warn(`quest "${q.title}": dependency "${key}" not found in the questbook (dropped)`);
          continue;
        }
        if (targetId === q.id) {
          warn(`quest "${q.title}": dependency "${key}" refers to itself (dropped)`);
          continue;
        }
        if (!deps.includes(targetId)) deps.push(targetId);
      }
      q.dependencies = deps;
    }
  }

  capDependencies(allQuests, warn);
  breakCycles(allQuests, warn);          // 1) model-authored cycles removed
  enforceChapterGating(chapters, warn);  // 2) pack-wide progression arc (safe: a gated
                                         //    quest has no deps, so no new cycle is possible)
  for (const ch of chapters) repairLayout(ch.quests, warn);
  fillDisplayText(chapters, warn);

  const book = {
    format: QUESTBOOK_FORMAT,
    packTitle: STR(raw?.packTitle) || firstLine(prompt) || 'Generated Modpack',
    prompt,
    minecraftVersion,
    modLoader,
    createdAt: new Date().toISOString(),
    chapters,
  };
  // Final gate: a structurally invalid questbook is NEVER returned or written.
  certifyQuestbook(book);
  return book;
}

function firstLine(s) {
  const l = String(s ?? '').split('\n')[0].trim();
  return l.length > 60 ? `${l.slice(0, 57)}…` : l;
}

function padChapter(i) {
  return {
    id: `c${i + 1}`,
    title: `Chapter ${i + 1}`,
    icon: 'minecraft:book',
    description: '',
    orderIndex: i,
    quests: [{
      id: `c${i + 1}q1`,
      title: 'Continue the journey',
      subtitle: '',
      description: 'This chapter was auto-padded — regenerate for full content.',
      x: 0, y: 0,
      tasks: [{ id: `c${i + 1}q1t1`, type: 'checkmark', title: 'Confirm' }],
      rewards: [],
      dependencies: [],
    }],
  };
}

function normalizeQuest(q, j, chapterIdx, { knownNamespaces, warn }) {
  const id = `c${chapterIdx + 1}q${j + 1}`;
  const title = STR(q?.title, `Quest ${j + 1}`);
  const subtitle = STR(q?.subtitle);
  const x = Number(q?.x);
  const y = Number(q?.y);
  const descRaw = q?.description;
  const description = Array.isArray(descRaw)
    ? descRaw.map((d) => String(d)).join('\n')
    : STR(descRaw);

  // tasks
  const tasks = [];
  const rawTasks = Array.isArray(q?.tasks) ? q.tasks : [];
  for (let k = 0; k < rawTasks.length; k++) {
    const t = rawTasks[k];
    const type = STR(t?.type).toLowerCase();
    if (type === 'item' && ITEM_RE.test(STR(t?.item))) {
      const count = Math.max(1, Math.floor(Number(t?.count) || 1));
      tasks.push({
        id: `${id}t${k + 1}`, type: 'item',
        title: STR(t?.title) || `Collect ${count}\u00d7 ${humanizeId(STR(t?.item))}`,
        item: STR(t?.item), count,
      });
      checkNamespace(STR(t?.item), `quest "${title}" task`, knownNamespaces, warn);
    } else if (type === 'checkmark') {
      tasks.push({ id: `${id}t${k + 1}`, type: 'checkmark', title: STR(t?.title) || 'Confirm' });
    } else if ((type === 'kill' || type === 'entity') && ENTITY_RE.test(STR(t?.entity))) {
      // FTB Quests KillTask: entity registry id + long count (serialized as "value")
      const count = Math.max(1, Math.floor(Number(t?.count ?? t?.value) || 1));
      tasks.push({
        id: `${id}t${k + 1}`, type: 'kill',
        title: STR(t?.title) || `Defeat ${count}\u00d7 ${humanizeId(STR(t?.entity))}`,
        entity: STR(t?.entity), count,
      });
      checkNamespace(STR(t?.entity), `quest "${title}" kill task`, knownNamespaces, warn);
    } else {
      warn(`quest "${title}": task type "${type || '?'}" is not supported — replaced with checkmark`);
      tasks.push({ id: `${id}t${k + 1}`, type: 'checkmark', title: STR(t?.title) || 'Confirm' });
    }
    if (tasks.length >= 4) break;
  }
  if (tasks.length === 0) {
    warn(`quest "${title}" had no valid tasks — injected a checkmark task`);
    tasks.push({ id: `${id}t1`, type: 'checkmark', title: 'Confirm' });
  }

  // rewards (optional)
  const rewards = [];
  const rawRewards = Array.isArray(q?.rewards) ? q.rewards : [];
  for (let k = 0; k < rawRewards.length; k++) {
    const r = rawRewards[k];
    const type = STR(r?.type).toLowerCase();
    if (type === 'item' && ITEM_RE.test(STR(r?.item))) {
      const count = Math.max(1, Math.floor(Number(r?.count) || 1));
      rewards.push({ id: `${id}r${k + 1}`, type: 'item', item: STR(r?.item), count });
      checkNamespace(STR(r?.item), `quest "${title}" reward`, knownNamespaces, warn);
    } else if (type === 'xp' && Number.isFinite(Number(r?.xp))) {
      rewards.push({ id: `${id}r${k + 1}`, type: 'xp', xp: Math.max(0, Math.floor(Number(r.xp))) });
    } else if (type === 'command' && STR(r?.command)) {
      rewards.push({ id: `${id}r${k + 1}`, type: 'command', command: STR(r?.command) });
    } else if (type) {
      warn(`quest "${title}": reward type "${type}" dropped (valid: item, xp, command)`);
    }
  }

  return {
    id, title, subtitle, description,
    x: Number.isFinite(x) ? x : (j % 4) * 2,
    y: Number.isFinite(y) ? y : Math.floor(j / 4) * 2,
    tasks, rewards, dependencies: [],
  };
}

function checkNamespace(item, where, knownNamespaces, warn) {
  if (!knownNamespaces) return;
  const ns = String(item).split(':')[0];
  if (ns !== 'minecraft' && !knownNamespaces.has(ns)) {
    warn(`${where}: "${item}" uses namespace "${ns}:" which is not in the installed pack — fine in SNBT, but the item may be missing in-game`);
  }
}

/** Remove back-edges so dependencies always form a DAG. */
function breakCycles(quests, warn) {
  const byId = new Map(quests.map((q) => [q.id, q]));
  const state = new Map(); // id -> 'visiting' | 'done'
  const visit = (q) => {
    state.set(q.id, 'visiting');
    const kept = [];
    for (const depId of q.dependencies) {
      const dep = byId.get(depId);
      if (!dep) { kept.push(depId); continue; } // not in this list (cross-chapter) — keep as-is
      if (state.get(depId) === 'visiting') {
        warn(`quest "${q.title}": circular dependency on "${dep.title}" removed`);
        continue;
      }
      if (state.get(depId) !== 'done') visit(dep);
      kept.push(depId);
    }
    q.dependencies = kept;
    state.set(q.id, 'done');
  };
  for (const q of quests) if (!state.has(q.id)) visit(q);
}

/** FTB-style flow: quests to the right of their deps, no overlapping tiles. */
function repairLayout(quests, warn) {
  const byId = new Map(quests.map((q) => [q.id, q]));
  const ordered = topoSort(quests);
  for (const q of ordered) {
    let min = -Infinity;
    for (const depId of q.dependencies) {
      const dep = byId.get(depId);
      if (dep) min = Math.max(min, dep.x);
    }
    if (min !== -Infinity && q.x <= min) {
      const target = min + 2;
      warn(`quest "${q.title}": moved from x=${q.x} to x=${target} (must sit right of its dependencies)`);
      q.x = target;
    }
    q.x = Math.max(0, Math.round(q.x / 2) * 2);
    q.y = Math.max(0, Math.round(q.y / 2) * 2);
  }
  // overlap: shift down by 2 until free
  for (const q of ordered) {
    let guard = 0;
    while (quests.some((o) => o !== q && o.x === q.x && o.y === q.y) && guard++ < 50) {
      q.y += 2;
      warn(`quest "${q.title}": shifted down to y=${q.y} (overlapped another quest)`);
    }
  }
}

function topoSort(quests) {
  const byId = new Map(quests.map((q) => [q.id, q]));
  const out = [];
  const seen = new Set();
  const visit = (q) => {
    if (seen.has(q.id)) return;
    seen.add(q.id);
    for (const d of q.dependencies) { const dep = byId.get(d); if (dep) visit(dep); }
    out.push(q);
  };
  for (const q of quests) visit(q);
  return out;
}

/* --------------------- structural guarantee layer ------------------------ */

function humanizeId(id) {
  return String(id ?? '').split(':').pop().replace(/[_.\/]+/g, ' ').trim();
}

/** Titles are the join key for dependencies — make them unique pack-wide. */
function uniquifyTitles(chapters, warn) {
  const seenChapters = new Map();
  for (const ch of chapters) {
    const times = (seenChapters.get(ch.title.toLowerCase()) ?? 0) + 1;
    seenChapters.set(ch.title.toLowerCase(), times);
    if (times > 1) {
      ch.title = `${ch.title} (${times})`;
      warn(`duplicate chapter title renamed to "${ch.title}"`);
    }
  }
  const seenQuests = new Map();
  for (const ch of chapters) {
    for (const q of ch.quests) {
      const times = (seenQuests.get(q.title.toLowerCase()) ?? 0) + 1;
      seenQuests.set(q.title.toLowerCase(), times);
      if (times > 1) {
        q.title = `${q.title} (${times})`;
        warn(`duplicate quest title renamed to "${q.title}" (titles must be unique pack-wide)`);
      }
    }
  }
}

/** Cap the fan-in of a quest — a wall of prerequisites is never the design intent. */
function capDependencies(quests, warn) {
  for (const q of quests) {
    if (q.dependencies.length > MAX_DEPS) {
      warn(`quest "${q.title}": ${q.dependencies.length} dependencies — kept the first ${MAX_DEPS}`);
      q.dependencies = q.dependencies.slice(0, MAX_DEPS);
    }
  }
}

/**
 * The progression arc is a STRUCTURAL invariant, not a prompt suggestion:
 * every quest outside chapter 1 must be locked behind the previous chapter's
 * finale, so a chapter can never open at game start. Runs after breakCycles,
 * and cannot introduce a cycle (a gated quest has zero deps, so it cannot
 * reach back into the graph).
 */
function enforceChapterGating(chapters, warn) {
  for (let i = 1; i < chapters.length; i++) {
    const prev = chapters[i - 1];
    const cur = chapters[i];
    const terminal = topoSort(prev.quests).at(-1);
    if (!terminal) continue;
    const curIds = new Set(cur.quests.map((q) => q.id));
    const linked = cur.quests.some((q) => q.dependencies.some((d) => !curIds.has(d)));
    const roots = cur.quests.filter((q) => q.dependencies.length === 0);
    if (roots.length > 0) {
      for (const q of roots) q.dependencies.push(terminal.id);
      warn(`chapter ${i + 1} "${cur.title}": ${roots.length} quest(s) had no prerequisites — auto-gated on chapter ${i} finale "${terminal.title}"`);
    } else if (!linked && cur.quests[0]) {
      cur.quests[0].dependencies.push(terminal.id);
      warn(`chapter ${i + 1} "${cur.title}": was not linked to chapter ${i} — gated via "${cur.quests[0].title}"`);
    }
  }
}

/** Every quest must tell the player what to do — never render an empty body. */
function fillDisplayText(chapters, warn) {
  for (const ch of chapters) {
    for (const q of ch.quests) {
      if (!q.description) {
        q.description = `Complete the objectives to progress through ${ch.title}.`;
        warn(`quest "${q.title}" had no description — placeholder written`);
      }
    }
  }
}

/**
 * Pre-check of the RAW model answer (strict attempt 1). Returns actionable
 * messages that are fed back to the model for one retry; attempt 2 skips this
 * and repairs deterministically instead, so the run can never fail on structure.
 */
export function structuralViolations(raw) {
  const chs = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.chapters) ? raw.chapters : null);
  if (!chs || chs.length === 0) {
    return ['no chapters found — expected { "packTitle": "…", "chapters": [ … ] }'];
  }
  const out = [];
  if (chs.length !== CHAPTER_COUNT) {
    out.push(`returned ${chs.length} chapter(s) — exactly ${CHAPTER_COUNT} required`);
  }
  const questsPer = chs.map((ch) => (Array.isArray(ch?.quests) ? ch.quests : []));
  const allTitles = questsPer.flat().map((q) => STR(q?.title)).filter(Boolean);
  const globalKeys = new Set(allTitles.map((t) => t.toLowerCase()));
  const seenTitles = new Set();
  for (const t of allTitles) {
    const key = t.toLowerCase();
    if (seenTitles.has(key)) out.push(`duplicate quest title "${t}" — quest titles must be unique across the whole book`);
    seenTitles.add(key);
  }
  const seenChapters = new Set();
  chs.forEach((ch, i) => {
    const ct = STR(ch?.title, `Chapter ${i + 1}`);
    if (seenChapters.has(ct.toLowerCase())) out.push(`duplicate chapter title "${ct}"`);
    seenChapters.add(ct.toLowerCase());

    const qs = questsPer[i];
    if (qs.length < 4 || qs.length > 6) {
      out.push(`chapter ${i + 1} "${ct}" has ${qs.length} quest(s) — exactly 4-6 required`);
    }
    for (const q of qs) {
      const label = STR(q?.title, `quest ${qs.indexOf(q) + 1} of chapter ${i + 1}`);
      if (!STR(q?.title)) out.push(`chapter ${i + 1}: a quest is missing its "title"`);
      if (!STR(q?.description) && !Array.isArray(q?.description)) {
        out.push(`quest "${label}" is missing its "description" (1-3 friendly sentences)`);
      }
      if (q?.dependencies !== undefined && !Array.isArray(q.dependencies)) {
        out.push(`quest "${label}": "dependencies" must be an array of exact quest titles`);
      } else if (Array.isArray(q?.dependencies)) {
        for (const d of q.dependencies) {
          if (typeof d !== 'string' || !globalKeys.has(d.trim().toLowerCase())) {
            out.push(`quest "${label}": dependency "${d}" does not match any quest title you wrote`);
          }
        }
      }
      const tasks = Array.isArray(q?.tasks) ? q.tasks : [];
      if (tasks.length === 0) out.push(`quest "${label}": needs at least one task`);
      for (const t of tasks) {
        const type = STR(t?.type).toLowerCase();
        if (!RAW_TASK_TYPES.has(type)) out.push(`quest "${label}": unsupported task type "${type || '?'}" (use item, kill or checkmark)`);
      }
      for (const r of (Array.isArray(q?.rewards) ? q.rewards : [])) {
        const type = STR(r?.type).toLowerCase();
        if (!QB_REWARD_TYPES.includes(type)) out.push(`quest "${label}": unsupported reward type "${type || '?'}" (use item, xp or command)`);
      }
    }
  });
  // The progression arc: each chapter after the first must be gated by title.
  for (let i = 1; i < questsPer.length; i++) {
    const earlier = new Set(questsPer.slice(0, i).flat()
      .map((q) => STR(q?.title).toLowerCase()).filter(Boolean));
    const linked = questsPer[i].some((q) => Array.isArray(q?.dependencies)
      && q.dependencies.some((d) => typeof d === 'string' && earlier.has(d.trim().toLowerCase())));
    if (!linked) {
      out.push(`chapter ${i + 1} is not gated on chapter ${i} — the first quest of chapter ${i + 1} must list chapter ${i}'s final quest title in "dependencies"`);
    }
  }
  return out;
}

/**
 * Final structural certification. Every invariant the reader, the SNBT export
 * and FTB Quests rely on is asserted HERE, after all repairs — if anything is
 * still wrong, normalization throws instead of returning/writing a broken book.
 * @returns {{assertions:number, violations:number}}
 */
export function certifyQuestbook(book) {
  const problems = [];
  let assertions = 0;
  const assert = (cond, msg) => { assertions++; if (!cond) problems.push(msg); };

  assert(book?.format === QUESTBOOK_FORMAT, `format must be ${QUESTBOOK_FORMAT}`);
  assert(typeof book?.packTitle === 'string' && book.packTitle.trim().length > 0, 'packTitle must be non-empty');
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  assert(chapters.length === CHAPTER_COUNT, `exactly ${CHAPTER_COUNT} chapters required (got ${chapters.length})`);

  const chapterTitles = new Set();
  const questTitles = new Set();
  const byId = new Map();
  const owner = new Map();   // quest id -> chapter index
  const allQuests = [];

  chapters.forEach((ch, i) => {
    const qs = Array.isArray(ch?.quests) ? ch.quests : [];
    assert(ch?.orderIndex === i, `chapter ${i + 1}: orderIndex must be ${i}`);
    const ct = String(ch?.title ?? '').trim();
    assert(ct.length > 0, `chapter ${i + 1}: title must be non-empty`);
    assert(!chapterTitles.has(ct.toLowerCase()), `duplicate chapter title "${ct}"`);
    chapterTitles.add(ct.toLowerCase());
    assert(ITEM_RE.test(String(ch?.icon ?? '')), `chapter ${i + 1}: icon "${ch?.icon}" must be a valid item id`);
    assert(qs.length >= 1, `chapter ${i + 1} "${ct}": must contain at least one quest`);

    qs.forEach((q, j) => {
      const at = `chapter ${i + 1}, quest ${j + 1}`;
      const label = String(q?.title ?? '').trim() || at;
      assert(typeof q?.id === 'string' && q.id.length > 0, `${at}: missing id`);
      assert(!byId.has(q?.id), `${at}: duplicate quest id "${q?.id}"`);
      byId.set(q?.id, q); owner.set(q?.id, i); allQuests.push(q);
      assert(String(q?.title ?? '').trim().length > 0, `${at}: title must be non-empty`);
      assert(!questTitles.has(String(q?.title ?? '').trim().toLowerCase()),
        `duplicate quest title "${label}" (titles must be unique pack-wide)`);
      questTitles.add(String(q?.title ?? '').trim().toLowerCase());
      assert(typeof q?.description === 'string' && q.description.trim().length > 0,
        `"${label}": description must be non-empty`);
      assert(Number.isInteger(q?.x) && q.x >= 0 && q.x % 2 === 0,
        `"${label}": x must be a non-negative even integer (got ${q?.x})`);
      assert(Number.isInteger(q?.y) && q.y >= 0 && q.y % 2 === 0,
        `"${label}": y must be a non-negative even integer (got ${q?.y})`);

      const tasks = Array.isArray(q?.tasks) ? q.tasks : [];
      assert(tasks.length >= 1, `"${label}": needs at least one task`);
      assert(tasks.length <= 4, `"${label}": at most 4 tasks`);
      for (const t of tasks) {
        assert(QB_TASK_TYPES.includes(t?.type), `"${label}": unsupported task type "${t?.type}"`);
        assert(typeof t?.title === 'string' && t.title.trim().length > 0, `"${label}": every task needs a title`);
        if (t?.type === 'item') assert(ITEM_RE.test(String(t?.item)), `"${label}": bad item id "${t?.item}"`);
        if (t?.type === 'kill') assert(ENTITY_RE.test(String(t?.entity)), `"${label}": bad entity id "${t?.entity}"`);
        if (t?.type !== 'checkmark') assert(Number.isInteger(t?.count) && t.count >= 1,
          `"${label}": task count must be a positive integer (got ${t?.count})`);
      }

      const rewards = Array.isArray(q?.rewards) ? q.rewards : [];
      assert(rewards.length <= 8, `"${label}": at most 8 rewards`);
      for (const r of rewards) {
        assert(QB_REWARD_TYPES.includes(r?.type), `"${label}": unsupported reward type "${r?.type}"`);
        if (r?.type === 'item') {
          assert(ITEM_RE.test(String(r?.item)), `"${label}": bad reward item id "${r?.item}"`);
          assert(Number.isInteger(r?.count) && r.count >= 1, `"${label}": reward count must be a positive integer`);
        }
        if (r?.type === 'xp') assert(Number.isInteger(r?.xp) && r.xp >= 0, `"${label}": reward xp must be a non-negative integer`);
        if (r?.type === 'command') assert(typeof r?.command === 'string' && r.command.trim().length > 0, `"${label}": reward command must be non-empty`);
      }
    });
  });

  // Second pass — dependency graph, layout and the progression arc.
  chapters.forEach((ch, i) => {
    const qs = Array.isArray(ch?.quests) ? ch.quests : [];
    const placed = new Set();
    for (const q of qs) {
      const label = String(q?.title ?? '').trim() || q?.id;
      const tile = `${q.x},${q.y}`;
      assert(!placed.has(tile), `"${label}": overlaps another quest at (${tile})`);
      placed.add(tile);
      const deps = Array.isArray(q?.dependencies) ? q.dependencies : [];
      assert(!Array.isArray(q?.dependencies) || deps.length === new Set(deps).size,
        `"${label}": duplicate dependency entries`);
      assert(!deps.includes(q?.id), `"${label}": depends on itself`);
      for (const d of deps) {
        assert(byId.has(d), `"${label}": dependency "${d}" does not exist in the questbook`);
        if (byId.has(d) && owner.get(d) === i) {
          assert(q.x > byId.get(d).x,
            `"${label}" must sit to the RIGHT of "${byId.get(d).title}" (${q.x} <= ${byId.get(d).x})`);
        }
      }
      if (i > 0) assert(deps.length >= 1,
        `"${label}": quests outside chapter 1 must be gated (empty dependencies)`);
    }
    if (i > 0) {
      assert(qs.some((q) => (q.dependencies ?? []).some((d) => byId.has(d) && owner.get(d) < i)),
        `chapter ${i + 1} "${ch.title}": not gated on an earlier chapter`);
    }
  });

  // The graph must be a DAG (Kahn) — a cycle means an uncompletable quest.
  const indeg = new Map(allQuests.map((q) => [q?.id, 0]));
  for (const q of allQuests) {
    for (const d of (q?.dependencies ?? [])) {
      if (byId.has(d) && d !== q?.id) indeg.set(q.id, indeg.get(q.id) + 1);
    }
  }
  const queue = allQuests.filter((q) => indeg.get(q?.id) === 0).map((q) => q?.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited++;
    for (const q of allQuests) {
      if ((q?.dependencies ?? []).includes(id)) {
        const left = indeg.get(q.id) - 1;
        indeg.set(q.id, left);
        if (left === 0) queue.push(q.id);
      }
    }
  }
  assert(visited === allQuests.length,
    `dependency graph must be acyclic (${allQuests.length - visited} quest(s) stuck in a cycle)`);

  if (problems.length > 0) {
    throw new Error(`questbook failed structural certification (${problems.length}/${assertions} checks failed):\n- ${problems.join('\n- ')}`);
  }
  return { assertions, violations: 0 };
}

/* ------------------------------ persistence ------------------------------ */

export function questbookPathFor(instanceDir) {
  return path.join(instanceDir, 'config', 'modpackquestforge', 'questbook.json');
}

export async function writeQuestbook(instanceDir, questbook) {
  const file = questbookPathFor(instanceDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(questbook, null, 2) + '\n', 'utf8');
  return file;
}

export async function readQuestbook(instanceDir) {
  if (!instanceDir) return null;
  const file = questbookPathFor(instanceDir);
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (raw?.format !== QUESTBOOK_FORMAT) return { file, questbook: raw, warning: 'unknown questbook format' };
    return { file, questbook: raw };
  } catch {
    return null;
  }
}

/* --------------------- optional FTB Quests SNBT export ------------------- */

/**
 * Export the validated questbook as FTB Quests .snbt chapter files.
 * Every chapter passes through the snbt.js validator (the same safety net
 * used before) — the AI never authors SNBT directly. Dependency ids are
 * validated pack-wide (chapter subtitle = our chapter description, quest
 * subtitle passes through, kill tasks serialize as FTB's kill fields).
 */
export function questbookToChapters(questbook, { warn = () => {}, knownNamespaces = null } = {}) {
  const hexFor = (id) => crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 16).toUpperCase();
  const usedStems = new Set();
  const out = [];

  // Every quest's hex id across ALL chapters: FTB Quests resolves dependencies
  // pack-wide, so chapter B's file may legally depend on chapter A's quest.
  const allChapterHexIds = new Set();
  for (const ch of questbook.chapters) for (const q of ch.quests) allChapterHexIds.add(hexFor(q.id));

  for (const ch of questbook.chapters) {
    const i = ch.orderIndex;
    const stem0 = `ch${i + 1}_${slugify(ch.title, 'chapter')}`;
    let stem = stem0; let bump = 2;
    while (usedStems.has(stem)) stem = `${stem0.slice(0, 36)}_${bump++}`;
    usedStems.add(stem);

    const questNodes = ch.quests.map((q) => {
      const entries = new Map();
      entries.set('id', n.str(hexFor(q.id)));
      entries.set('title', n.str(q.title));
      if (q.subtitle) entries.set('subtitle', n.str(q.subtitle));
      entries.set('x', n.d(Number(q.x) || 0));
      entries.set('y', n.d(Number(q.y) || 0));
      if (q.description) {
        entries.set('description', n.list(String(q.description).split('\n').map((line) => n.str(line))));
      }
      entries.set('dependencies', n.list(q.dependencies.map((depId) => n.str(hexFor(depId)))));
      entries.set('tasks', n.list(q.tasks.map((t) => {
        const node = n.compound({ id: n.str(hexFor(t.id)), type: n.str(t.type) });
        if (t.title) node.entries.set('title', n.str(t.title));
        if (t.type === 'item') {
          node.entries.set('item', n.str(t.item));
          node.entries.set('count', n.l(Math.max(1, Math.floor(Number(t.count) || 1))));
        } else if (t.type === 'kill') {
          // KillTask.writeData: entity string + long "value"
          node.entries.set('entity', n.str(t.entity));
          node.entries.set('value', n.l(Math.max(1, Math.floor(Number(t.count) || 1))));
        }
        return node;
      })));
      if (q.rewards.length > 0) {
        entries.set('rewards', n.list(q.rewards.map((r) => {
          const node = n.compound({ id: n.str(hexFor(r.id)), type: n.str(r.type) });
          if (r.type === 'item') {
            node.entries.set('item', n.str(r.item));
            node.entries.set('count', n.i(Math.max(1, Math.floor(Number(r.count) || 1))));
          } else if (r.type === 'xp') {
            node.entries.set('xp', n.i(Math.max(0, Math.floor(Number(r.xp) || 0))));
          } else if (r.type === 'command') {
            node.entries.set('command', n.str(r.command));
            node.entries.set('player_command', n.bool(false));
          }
          return node;
        })));
      }
      return { k: 'compound', entries };
    });

    const chapter = n.compound({
      id: n.str(hexFor(`chapter-${i}-${ch.title}`)),
      order_index: n.i(i),
      filename: n.str(stem),
      title: n.str(ch.title),
      icon: n.str(ITEM_RE.test(ch.icon ?? '') ? ch.icon : 'minecraft:book'),
      default_hide_dependency_lines: n.bool(false),
      default_quest_shape: n.str(''),
      quest_links: n.list([]),
      quests: n.list(questNodes),
    });

    // FTB Chapter has a `subtitle` (list of lines), no `description` — map ours.
    const descLines = String(ch.description ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (descLines.length > 0) {
      chapter.entries.set('subtitle', n.list(descLines.map((line) => n.str(line))));
    }

    // Final safety: the same validator used when SNBT was the primary format.
    const { snbt } = renderChapter(chapter, {
      orderIndex: i,
      filename: stem,
      knownNamespaces,
      allowedIds: allChapterHexIds,
      warn: (msg) => warn(`chapter ${i + 1}: ${msg}`),
    });
    out.push({ index: i, stem, title: ch.title, snbt, questCount: ch.quests.length });
  }
  return out;
}
