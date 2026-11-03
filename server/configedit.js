// configedit.js — AI-powered configuration editing with deterministic safety
// rails (spec feature 4 + the reversible-fixes half of feature 8).
//
// Flow:  propose  ->  preview diff  ->  apply (ONLY after user approval)
//                    -> automatic backup first  ->  one-click undo.
//
// Safety rules (never delegated to the AI):
//  - only files inside <instance>/config may be read or written;
//    worlds/saves/mods/options are structurally unreachable
//  - "replace" edits must quote an EXACT, UNIQUE substring of the current
//    file; if the file changed since the preview, the apply is refused
//  - every apply copies the originals into
//    config/modpackquestforge/backups/<id>/ with a manifest before writing
//  - all content is size-capped; binaries are never editable
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { callLlm, extractJson, LlmError } from './llm.js';
import { resolveProvider } from './providers.js';

export const EDITABLE_EXT = new Set([
  '.toml', '.json', '.cfg', '.conf', '.properties', '.txt', '.ini', '.yml', '.yaml', '.cfg',
]);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 10;            // files sent to the LLM per proposal
const MAX_CONTENT_CHARS = 6000;  // per file
const MAX_TOTAL_CHARS = 50000;   // all files together
const MAX_CHANGES = 20;

const SKIP_DIRS = new Set(['modpackquestforge']); // our own bookkeeping

/** Pending proposals, keyed by id. Lives in memory on purpose: a restart
 *  simply means "propose again", never "apply something stale". */
const pending = new Map();

/* --------------------------- path safety --------------------------- */

/**
 * Resolve a path RELATIVE TO <instance>/config. Throws on anything that
 * escapes the config tree (absolute paths, .., symlinks pointing out…).
 */
export function resolveConfigPath(instanceDir, relPath) {
  if (!instanceDir) throw new Error('instance directory is not set');
  const rel = String(relPath ?? '').replace(/\\/g, '/');
  if (!rel || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new Error(`unsafe path "${relPath}"`);
  }
  if (rel.split('/').includes('..')) throw new Error(`unsafe path "${relPath}"`);
  const base = path.resolve(instanceDir, 'config');
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`path escapes the config directory: "${relPath}"`);
  }
  return abs;
}

/* --------------------------- file listing --------------------------- */

function walk(dir, base, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= 400) return out;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(abs, base, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!EDITABLE_EXT.has(ext)) continue;
      let st = null;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) continue;
      out.push({
        path: path.relative(base, abs).split(path.sep).join('/'),
        size: st.size,
        mtime: st.mtimeMs,
      });
    }
  }
  return out;
}

/** Editable text files under <instance>/config (sorted, capped). */
export function listConfigFiles(instanceDir) {
  if (!instanceDir) return { files: [], error: 'instance directory is not set' };
  const base = path.resolve(instanceDir, 'config');
  if (!fs.existsSync(base)) return { files: [], error: 'no config/ directory in this instance yet' };
  const files = walk(base, base, [])
    .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
    .slice(0, 400);
  return { files };
}

export async function readConfigFile(instanceDir, relPath) {
  const abs = resolveConfigPath(instanceDir, relPath);
  const st = await fsp.stat(abs);
  if (st.size > MAX_FILE_BYTES) throw new Error('file too large to edit safely (>256 KB)');
  const content = await fsp.readFile(abs, 'utf8');
  if (content.includes('\u0000')) throw new Error('binary file — not editable');
  return { path: String(relPath).replace(/\\/g, '/'), content };
}

/* ------------------------------ line diff ------------------------------ */

/**
 * Line-level diff (LCS after common prefix/suffix trimming).
 * Returns [{ type: 'ctx'|'del'|'add', line, oldNo, newNo }] — enough for a
 * unified-style preview. Falls back to a block replacement for huge changes.
 */
export function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }

  const out = [];
  const headEnd = start;
  const tailStart = endA + 1;
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);

  const push = (type, text, oldNo, newNo) => out.push({ type, line: text, oldNo, newNo });

  // leading context (up to 3 lines before the change)
  const ctxStart = Math.max(0, headEnd - 3);
  for (let i = ctxStart; i < headEnd; i++) push('ctx', a[i], i + 1, i + 1);

  if (midA.length * midB.length > 4_000_000) {
    // too big for LCS — report as a block replacement
    midA.forEach((l, i) => push('del', l, start + i + 1, null));
    midB.forEach((l, i) => push('add', l, null, start + i + 1));
  } else if (midA.length === 0 || midB.length === 0) {
    midA.forEach((l, i) => push('del', l, start + i + 1, null));
    midB.forEach((l, i) => push('add', l, null, start + i + 1));
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] = midA[i] === midB[j]
          ? dp[(i + 1) * (m + 1) + (j + 1)] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { push('ctx', midA[i], start + i + 1, start + j + 1); i++; j++; }
      else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + (j + 1)]) { push('del', midA[i], start + i + 1, null); i++; }
      else { push('add', midB[j], null, start + j + 1); j++; }
    }
    while (i < n) { push('del', midA[i], start + i + 1, null); i++; }
    while (j < m) { push('add', midB[j], null, start + j + 1); j++; }
  }

  // trailing context
  const tailEnd = b.length;
  const tailFrom = endB + 1;
  for (let k = tailFrom; k < Math.min(tailFrom + 3, tailEnd); k++) {
    push('ctx', b[k], null, k + 1);
  }
  void tailStart;
  return out;
}

function diffStats(diff) {
  let added = 0;
  let removed = 0;
  for (const d of diff) {
    if (d.type === 'add') added++;
    else if (d.type === 'del') removed++;
  }
  return { added, removed };
}

/* ------------------------ proposal validation ------------------------ */

/**
 * Deterministically validate LLM-proposed changes against the real files.
 * @returns {{ changes: Array, rejected: Array }}
 */
export function validateChanges(instanceDir, rawChanges, { knownPaths = null } = {}) {
  const changes = [];
  const rejected = [];
  if (!Array.isArray(rawChanges)) return { changes, rejected: [{ path: '(none)', reason: 'no changes array' }] };

  for (const raw of rawChanges.slice(0, MAX_CHANGES)) {
    if (!raw || typeof raw !== 'object') { rejected.push({ path: '(unknown)', reason: 'not an object' }); continue; }
    const rel = String(raw.path ?? '').replace(/\\/g, '/').replace(/^config\//, '');
    try {
      const abs = resolveConfigPath(instanceDir, rel);
      const action = raw.action === 'create' ? 'create' : 'replace';
      const reason = String(raw.reason ?? '').slice(0, 300);

      if (action === 'replace') {
        if (knownPaths && !knownPaths.has(rel)) {
          rejected.push({ path: rel, reason: 'not an editable file in this instance' });
          continue;
        }
        if (!fs.existsSync(abs)) {
          rejected.push({ path: rel, reason: 'file does not exist (use action "create" for new files)' });
          continue;
        }
        const before = fs.readFileSync(abs, 'utf8');
        if (before.includes('\u0000')) { rejected.push({ path: rel, reason: 'binary file' }); continue; }
        const find = String(raw.find ?? '');
        if (!find) { rejected.push({ path: rel, reason: 'replace action without "find" text' }); continue; }
        const occurrences = before.split(find).length - 1;
        if (occurrences === 0) {
          rejected.push({ path: rel, reason: '"find" text not found in the file (model hallucinated content)' });
          continue;
        }
        if (occurrences > 1) {
          rejected.push({ path: rel, reason: `"find" text occurs ${occurrences}× — must be unique to edit safely` });
          continue;
        }
        const after = before.replace(find, String(raw.replace ?? ''));
        if (after === before) { rejected.push({ path: rel, reason: '"replace" would change nothing' }); continue; }
        if (Buffer.byteLength(after) > MAX_FILE_BYTES) { rejected.push({ path: rel, reason: 'result would exceed 256 KB' }); continue; }
        const diff = lineDiff(before, after);
        changes.push({ path: rel, action: 'replace', find, replace: String(raw.replace ?? ''), reason, before, after, diff, ...diffStats(diff) });
      } else {
        // create
        if (fs.existsSync(abs)) {
          rejected.push({ path: rel, reason: 'file already exists — propose a "replace" edit instead' });
          continue;
        }
        const content = String(raw.content ?? '');
        if (!content.trim()) { rejected.push({ path: rel, reason: 'create action without content' }); continue; }
        if (Buffer.byteLength(content) > MAX_FILE_BYTES) { rejected.push({ path: rel, reason: 'content exceeds 256 KB' }); continue; }
        const diff = lineDiff('', content);
        changes.push({ path: rel, action: 'create', reason, before: '', after: content, diff, ...diffStats(diff) });
      }
    } catch (err) {
      rejected.push({ path: rel || '(unknown)', reason: err.message });
    }
  }
  return { changes, rejected };
}

/* ------------------------------ prompting ------------------------------ */

function pickFiles(files, instruction, paths) {
  if (Array.isArray(paths) && paths.length > 0) {
    const wanted = new Set(paths.map((p) => String(p).replace(/^config\//, '')));
    return files.filter((f) => wanted.has(f.path)).slice(0, MAX_FILES);
  }
  const words = String(instruction ?? '').toLowerCase().match(/[a-z0-9_.-]{4,}/g) ?? [];
  const scored = files.map((f) => {
    const p = f.path.toLowerCase();
    return { f, score: words.filter((w) => p.includes(w)).length };
  });
  scored.sort((x, y) => y.score - x.score || y.f.mtime - x.f.mtime);
  const hits = scored.filter((s) => s.score > 0).map((s) => s.f);
  return (hits.length > 0 ? hits : scored.map((s) => s.f)).slice(0, MAX_FILES);
}

const SYSTEM_PROMPT = `You are a Minecraft modpack configuration expert editing config files (TOML, JSON, .properties, .cfg…).
You receive the user's requested change and the pack's actual config file contents.

Return ONLY a strict JSON object, no fences, no prose:
{ "changes": [ { "path": "exact path from the provided list", "action": "replace",
   "find": "exact unique substring of the current file", "replace": "replacement text",
   "reason": "one sentence: what this changes and why" } ] }

Rules:
- Make the SMALLEST change that fulfils the request. Never touch unrelated settings.
- "find" must be copied EXACTLY from the provided file content (including whitespace and quotes) and occur exactly ONCE in that file.
  To change a value, quote its FULL line in "find" and give the FULL replacement line in "replace" — never quote a fragment.
- Keep the file's syntax valid (valid TOML/JSON/INI/properties after the edit).
- Only use paths from the provided list. To add a brand-new file use {"action":"create","content":"<full file>"}.
- If the request cannot be done through these files, return {"changes":[],"note":"<why>"} — do not invent files.`;

/**
 * Propose configuration changes for a natural-language instruction.
 * Validates everything deterministically, stores the proposal server-side and
 * returns a preview — NOTHING is written at this stage.
 * @returns {Promise<{proposalId, changes, rejected, filesUsed, note?}>}
 */
export async function proposeChanges({ instanceDir, instruction, paths, cfg, log, fetchImpl = fetch }) {
  if (!instanceDir) throw new Error('instance directory is not set');
  const text = String(instruction ?? '').trim();
  if (text.length < 3) throw new Error('describe the configuration change first (min 3 chars)');

  const { files } = listConfigFiles(instanceDir);
  if (files.length === 0) throw new Error('no editable config files found in this instance');

  const chosen = pickFiles(files, text, paths);
  let budget = MAX_TOTAL_CHARS;
  const sections = [];
  for (const f of chosen) {
    let content = '';
    try { content = await fsp.readFile(path.join(instanceDir, 'config', f.path), 'utf8'); } catch { continue; }
    if (content.includes('\u0000')) continue;
    if (content.length > MAX_CONTENT_CHARS) {
      content = `${content.slice(0, MAX_CONTENT_CHARS)}\n… (truncated, ${content.length} chars total)`;
    }
    if (content.length > budget) {
      content = `${content.slice(0, Math.max(0, budget))}\n… (truncated)`;
    }
    budget -= content.length;
    sections.push(`--- FILE: config/${f.path} ---\n${content}`);
    if (budget <= 0) break;
  }
  if (sections.length === 0) throw new Error('could not read any of the selected config files');

  const rp = resolveProvider(cfg, cfg.provider);
  if (!rp) throw new Error(`Unknown provider "${cfg.provider}"`);
  if (!rp.apiKey && !rp.noKey) throw new Error(`No API key configured for provider "${rp.label}" — add one in Settings (or use local Ollama).`);

  const user = `User's requested change:
"""
${text}
"""

Editable config files (${files.length} in this instance, ${sections.length} provided):
${files.map((f) => `config/${f.path} (${f.size} B)`).join('\n')}

${sections.join('\n\n')}`;

  const base = {
    provider: rp.id, kind: rp.kind, baseUrl: rp.baseUrl, apiKey: rp.apiKey,
    noKey: rp.noKey, jsonMode: rp.jsonMode, model: rp.model,
    system: SYSTEM_PROMPT, timeoutMs: cfg.requestTimeoutMs, fetchImpl,
  };

  const knownPaths = new Set(files.map((f) => f.path));
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1
      ? user
      : `${user}\n\nYour previous answer was rejected: ${lastError.message}\nReply AGAIN with ONLY the strict JSON object.`;
    log?.info(`Requesting config change proposal from ${rp.id} (${rp.model}), attempt ${attempt}/2…`, 'config');
    try {
      const raw = await callLlm({ ...base, user: prompt, json: true });
      const data = extractJson(raw);
      const { changes, rejected } = validateChanges(instanceDir, data.changes, { knownPaths });
      for (const r of rejected) log?.warn(`rejected change to ${r.path}: ${r.reason}`, 'config');
      if (changes.length === 0) {
        const note = typeof data.note === 'string' ? data.note : 'the model proposed no valid changes';
        throw new LlmError(note);
      }
      const id = crypto.randomUUID();
      const proposal = {
        id, instanceDir, instruction: text, changes,
        note: typeof data.note === 'string' ? data.note.slice(0, 300) : null,
        createdAt: new Date().toISOString(),
      };
      pending.set(id, proposal);
      prunePending();
      log?.success(`proposal ${id.slice(0, 8)}: ${changes.length} change(s), ${rejected.length} rejected`, 'config');
      return publicProposal(proposal, rejected, chosen.length);
    } catch (err) {
      lastError = err;
      log?.warn(`config proposal attempt ${attempt} failed: ${err.message}`, 'config');
    }
  }
  throw lastError ?? new LlmError('config proposal failed');
}

function prunePending() {
  if (pending.size <= 25) return;
  const sorted = [...pending.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const p of sorted.slice(0, pending.size - 25)) pending.delete(p.id);
}

function publicProposal(proposal, rejected = [], filesUsed = 0) {
  return {
    proposalId: proposal.id,
    instruction: proposal.instruction,
    note: proposal.note,
    filesUsed,
    changes: proposal.changes.map((c) => ({
      path: c.path, action: c.action, reason: c.reason,
      added: c.added, removed: c.removed, diff: c.diff,
    })),
    rejected,
  };
}

export function getProposal(id) {
  return pending.get(id) ?? null;
}

/** Preview shape for the UI (diffs included, nothing applied). */
export function proposalPreview(id) {
  const p = pending.get(id);
  if (!p) return null;
  return publicProposal(p, [], 0);
}

/** Register an already-validated set of changes as a pending proposal.
 *  Used by troubleshoot.js so AI-proposed crash fixes flow through exactly
 *  the same preview -> approve -> backup -> apply path as config edits. */
export function registerExternalProposal(id, instanceDir, instruction, changes) {
  pending.set(id, {
    id, instanceDir,
    instruction: String(instruction ?? '').slice(0, 300),
    changes,
    note: null,
    createdAt: new Date().toISOString(),
  });
  prunePending();
  return id;
}

/* --------------------------- apply / undo --------------------------- */

function backupsRoot(instanceDir) {
  return path.join(instanceDir, 'config', 'modpackquestforge', 'backups');
}

/**
 * Apply a previously previewed proposal: re-verify every file is unchanged
 * since the preview, back up the originals, then write. All-or-nothing.
 */
export async function applyProposal(proposalId) {
  const proposal = pending.get(proposalId);
  if (!proposal) throw new Error('proposal not found (it expires on server restart — propose again)');

  // 1) drift check: refuse to overwrite anything that changed since preview
  for (const c of proposal.changes) {
    const abs = resolveConfigPath(proposal.instanceDir, c.path);
    if (c.action === 'replace') {
      if (!fs.existsSync(abs)) throw new Error(`${c.path} disappeared since the preview — propose again`);
      const now = fs.readFileSync(abs, 'utf8');
      if (now !== c.before) throw new Error(`${c.path} changed since the preview — propose again to see the new diff`);
    } else if (fs.existsSync(abs)) {
      throw new Error(`${c.path} now exists — propose again`);
    }
  }

  // 2) backup originals (before ANY write)
  const backupId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const backupDir = path.join(backupsRoot(proposal.instanceDir), backupId);
  const manifest = {
    id: backupId,
    createdAt: new Date().toISOString(),
    instruction: proposal.instruction,
    undone: false,
    files: proposal.changes.map((c) => ({ path: c.path, action: c.action, existed: c.action === 'replace' })),
  };
  await fsp.mkdir(backupDir, { recursive: true });
  try {
    for (const c of proposal.changes) {
      if (c.action !== 'replace') continue;
      const src = resolveConfigPath(proposal.instanceDir, c.path);
      const dst = path.join(backupDir, 'files', c.path);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(src, dst);
    }
    await fsp.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  } catch (err) {
    await fsp.rm(backupDir, { recursive: true, force: true });
    throw new Error(`backup failed — nothing was written (${err.message})`);
  }

  // 3) write, rolling back from the backup on any failure
  const written = [];
  try {
    for (const c of proposal.changes) {
      const abs = resolveConfigPath(proposal.instanceDir, c.path);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, c.after, 'utf8');
      written.push(c.path);
    }
  } catch (err) {
    for (const p of written) {
      try {
        const abs = resolveConfigPath(proposal.instanceDir, p);
        const bak = path.join(backupDir, 'files', p);
        if (fs.existsSync(bak)) await fsp.copyFile(bak, abs);
        else await fsp.rm(abs, { force: true });
      } catch { /* best effort */ }
    }
    await fsp.rm(backupDir, { recursive: true, force: true });
    throw new Error(`apply failed and was rolled back (${err.message})`);
  }

  pending.delete(proposalId);
  return { backupId, files: proposal.changes.map((c) => c.path) };
}

export async function listBackups(instanceDir) {
  if (!instanceDir) return [];
  const root = backupsRoot(instanceDir);
  let ids = [];
  try { ids = await fsp.readdir(root); } catch { return []; }
  const out = [];
  for (const id of ids) {
    try {
      const m = JSON.parse(await fsp.readFile(path.join(root, id, 'manifest.json'), 'utf8'));
      out.push({
        id: m.id ?? id,
        createdAt: m.createdAt ?? null,
        instruction: m.instruction ?? '',
        files: (m.files ?? []).map((f) => f.path),
        undone: Boolean(m.undone),
      });
    } catch { /* skip corrupt manifest */ }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Restore a backup: originals come back, created files are removed. */
export async function undoBackup(instanceDir, backupId) {
  if (!instanceDir) throw new Error('instance directory is not set');
  const id = String(backupId ?? '');
  if (!/^[A-Za-z0-9-]{5,64}$/.test(id)) throw new Error('bad backup id');
  const backupDir = path.join(backupsRoot(instanceDir), id);
  const manifestPath = path.join(backupDir, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')); } catch {
    throw new Error('backup not found');
  }
  if (manifest.undone) throw new Error('this backup has already been undone');

  const restored = [];
  for (const f of manifest.files ?? []) {
    const abs = resolveConfigPath(instanceDir, f.path);
    if (f.action === 'replace' || f.existed) {
      const src = path.join(backupDir, 'files', f.path);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.copyFile(src, abs);
      restored.push(f.path);
    } else {
      await fsp.rm(abs, { force: true });
      restored.push(`${f.path} (removed)`);
    }
  }
  manifest.undone = true;
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { restored };
}
