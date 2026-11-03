// troubleshoot.js — crash-report and log analysis (spec feature 8).
//
// Two layers, in order:
//  1. DETERMINISTIC: known crash signatures + mod-id extraction run on every
//     paste, no AI required (free-first: the tool stays useful with no key).
//  2. OPTIONAL AI: if a provider key is configured, the model explains the
//     findings in plain language and may propose concrete file fixes — but a
//     fix is only ever a PROPOSAL (configedit.js), applied after user
//     approval with a backup, never directly.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { callLlm, extractJson } from './llm.js';
import { resolveProvider } from './providers.js';
import { listConfigFiles, validateChanges, registerExternalProposal } from './configedit.js';

const MAX_LOG_CHARS = 120_000;

/* ----------------------- deterministic signatures ----------------------- */

const SIGNATURES = [
  {
    code: 'oom',
    severity: 'error',
    test: /java\.lang\.OutOfMemoryError/i,
    subject: 'Out of memory',
    message: 'The JVM ran out of heap memory.',
    suggestion: 'Raise the instance Java heap (Prism: Instance → Settings → Java → Memory → max, e.g. 6-8 GB).',
  },
  {
    code: 'mixin-apply',
    severity: 'error',
    test: /Mixin apply failed|MixinTransformerError|Injection failed|@Inject annotation on .+ could not find/i,
    subject: 'Mixin injection failure',
    message: "A mod's mixin could not inject into a target — usually two mods patching the same class, or one mod outdated for this Minecraft/loader version.",
    suggestion: 'Update the mods named right above the "Mixin" lines; if two mods touch the same class, remove the one you need least.',
  },
  {
    code: 'mod-resolution',
    severity: 'error',
    test: /Mod resolution failed|failed to resolve|could not find required mod|Missing dependency|depends on .{0,40} but it is not installed/i,
    subject: 'Mod resolution / missing dependency',
    message: 'The loader could not resolve the mod graph — a required dependency is missing or pinned to a version that is not installed.',
    suggestion: "Install the missing dependency version named in the log (the compat validator's required-deps check catches this before launch).",
  },
  {
    code: 'duplicate-mod',
    severity: 'error',
    test: /Duplicate mod|duplicated mod|Multiple mods with the same id|Found duplicate/i,
    subject: 'Duplicate mod jar',
    message: 'Two jars provide the same mod id — typically the same mod present twice or two builds of it.',
    suggestion: 'Remove the duplicate jar from mods/ — keep the newest build for your Minecraft version.',
  },
  {
    code: 'java-version',
    severity: 'error',
    test: /Unsupported class file major version|compiled by a more recent Java Runtime|has been compiled by a more recent/i,
    subject: 'Java version mismatch',
    message: 'Class files were compiled for a newer Java runtime than the one the game launched with.',
    suggestion: 'Point the instance at the right Java (1.20.1 Forge → Java 17; 1.21.x → Java 21).',
  },
  {
    code: 'nosuchmethod',
    severity: 'error',
    test: /java\.lang\.NoSuchMethodError|java\.lang\.NoSuchFieldError/i,
    subject: 'API mismatch between mods',
    message: 'A mod called a method that no longer exists — two mods (or a mod and a library) are on incompatible versions.',
    suggestion: 'Update both mods named around the error to versions built for the same Minecraft version.',
  },
  {
    code: 'noclassdef',
    severity: 'error',
    test: /java\.lang\.NoClassDefFoundError|java\.lang\.ClassNotFoundException/i,
    subject: 'Missing class at runtime',
    message: 'A required class was not on the classpath — a library dependency is absent or a mod was half-removed.',
    suggestion: 'Reinstall the mod that throws (or the library it depends on) — check its required dependencies.',
  },
  {
    code: 'graphics',
    severity: 'warn',
    test: /GLFW error|OpenGL 1282|GL_INVALID_ENUM|org\.lwjgl\.LWJGLException|Shader compilation failed/i,
    subject: 'Graphics / driver problem',
    message: 'A GLFW/OpenGL or shader error — usually a driver issue or an incompatible shader pack.',
    suggestion: 'Update the GPU driver; if shaders are involved, disable the shader pack first to confirm.',
  },
];

/** Mod ids explicitly named in common crash-report/log lines. */
export function extractModMentions(text) {
  const out = new Set();
  const patterns = [
    /Mod File:\s*"?([^"\n]+?)\.jar"?/gi,
    /modid["'\s:=]+["']?([a-z][a-z0-9_.-]{2,})["']?/gi,
    /failed to load Mod Config data for Mod ([a-z0-9_.-]+)/gi,
    /\b(?:Mod|mod)\s+['"]([a-z0-9_.-]{3,})['"]/g,
    /\b([a-z][a-z0-9_.-]{2,})-\d+\.\d+\.\d+.*\.jar\b/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const id = (m[1] ?? '').trim().toLowerCase();
      if (/^[a-z][a-z0-9_.-]{2,}$/.test(id) && id !== 'minecraft') out.add(id);
    }
  }
  return [...out];
}

/** Mod ids known to be in the pack (mods/*.jar names + the manifest). */
export function installedModIds(instanceDir) {
  const ids = new Set();
  if (!instanceDir) return ids;
  try {
    const entries = fs.readdirSync(path.join(instanceDir, 'mods'));
    for (const f of entries) {
      if (!f.endsWith('.jar')) continue;
      const base = f.replace(/\.jar$/, '');
      const m = /^(.+?)-\d/.exec(base);
      if (m) ids.add(m[1].toLowerCase().replace(/[_\s]+/g, '-'));
      ids.add(base.toLowerCase());
    }
  } catch { /* no mods dir yet */ }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(instanceDir, 'modrinth.index.json'), 'utf8'));
    for (const f of manifest.files ?? []) {
      const name = String(f.path ?? '').split('/').pop()?.replace(/\.jar$/, '');
      if (name) ids.add(name.toLowerCase());
    }
  } catch { /* no manifest */ }
  return ids;
}

/**
 * Deterministic analysis: known signatures, deepest root cause, and mod
 * mentions matched against the pack's actual jars.
 * @returns {{ findings: Array, mentions: string[], matched: string[] }}
 */
export function analyzeLog(logText, instanceDir = null) {
  const text = String(logText ?? '').slice(0, MAX_LOG_CHARS);
  if (!text.trim()) throw new Error('paste a crash report or log first');

  const findings = [];
  for (const sig of SIGNATURES) {
    if (sig.test.test(text)) {
      findings.push({
        code: sig.code, severity: sig.severity, subject: sig.subject,
        message: sig.message, suggestion: sig.suggestion,
      });
    }
  }

  // the deepest "Caused by" is the root cause — surfaced deterministically
  const causedBy = [...text.matchAll(/Caused by:\s*([^\n]+)/g)].map((m) => m[1].trim());
  if (causedBy.length > 0) {
    findings.push({
      code: 'root-cause',
      severity: 'info',
      subject: 'Root cause (deepest "Caused by")',
      message: causedBy[causedBy.length - 1].slice(0, 300),
      suggestion: 'Fix the deepest cause first; the lines above it are knock-on effects.',
    });
  }

  const mentions = extractModMentions(text);
  const installed = [...installedModIds(instanceDir)];
  const matched = mentions.filter((id) => installed.some((i) => i.includes(id) || id.includes(i)));
  if (matched.length > 0) {
    findings.push({
      code: 'mod-mentioned',
      severity: 'info',
      subject: 'Pack mods named in the crash',
      message: `Mentioned in the report: ${matched.join(', ')}`,
      suggestion: 'These mods are actually present in this instance — suspect their versions first.',
    });
  }
  if (findings.length === 0) {
    findings.push({
      code: 'unknown',
      severity: 'warn',
      subject: 'No known signature matched',
      message: 'The report does not match any known failure pattern.',
      suggestion: 'Enable the AI explanation for a full read-through, or search the deepest error line verbatim.',
    });
  }
  return { findings, mentions, matched };
}

/* ----------------------------- AI explanation ----------------------------- */

const SYSTEM_PROMPT = `You are a Minecraft crash-log analyst for a modpack builder.
You receive a crash report/log, deterministic findings from static analysis, and the pack's config file list.

Return ONLY a strict JSON object, no fences, no prose:
{
  "summary": "2-3 friendly sentences: what happened and the most likely root cause",
  "causes": [ { "subject": "short label", "explanation": "why this mod/thing is suspect", "confidence": "high|medium|low" } ],
  "fixes": [ {
     "label": "short action name",
     "explanation": "what this fix does and why it should help",
     "change": { "path": "config-relative/file", "find": "exact unique text from that file", "replace": "new text" }
  } ]
}

Rules:
- "change" is ONLY for configuration-file fixes; set it to null for anything else (updating/removing a jar, changing Java memory, updating drivers).
- Never propose touching worlds/saves. Only files under config/.
- If a change is provided, "find" must be copied EXACTLY from the file contents you were given and occur exactly once.
- Be honest about uncertainty — mark confidence low when the log is ambiguous.`;

/**
 * Full analysis: deterministic findings + optional AI explanation.
 * AI fixes that carry a file change become configedit PROPOSALS — they are
 * still unapplied and require an explicit approve + backup, like every other
 * config edit.
 */
export async function troubleshoot({ log, cfg, instanceDir, logger, fetchImpl = fetch }) {
  const analysis = analyzeLog(log, instanceDir);

  const rp = resolveProvider(cfg, cfg.provider);
  const canAsk = rp && (rp.apiKey || rp.noKey) && rp.model;
  if (!canAsk) {
    return {
      findings: analysis.findings,
      mentions: analysis.mentions,
      matched: analysis.matched,
      ai: null,
      note: 'Deterministic analysis only — add an AI provider (or run local Ollama) for a written explanation.',
    };
  }

  const { files } = listConfigFiles(instanceDir);
  const fileList = files.slice(0, 40).map((f) => `config/${f.path}`).join('\n') || '(no config files yet)';

  const user = `Pack instance: ${instanceDir || '(not set)'}
Minecraft ${cfg.minecraftVersion} / ${cfg.modLoader}.
Editable config files:
${fileList}

Deterministic findings:
${analysis.findings.map((f) => `- [${f.code}] ${f.subject}: ${f.message}`).join('\n')}

Crash report / log:
"""
${String(log ?? '').slice(0, MAX_LOG_CHARS)}
"""`;

  try {
    const raw = await callLlm({
      provider: rp.id, kind: rp.kind, baseUrl: rp.baseUrl, apiKey: rp.apiKey,
      noKey: rp.noKey, jsonMode: rp.jsonMode, model: rp.model,
      system: SYSTEM_PROMPT, user, json: true,
      timeoutMs: cfg.requestTimeoutMs, fetchImpl,
    });
    const data = extractJson(raw);
    const fixes = [];
    let proposalsUsed = 0;

    for (const fix of (Array.isArray(data.fixes) ? data.fixes : []).slice(0, 8)) {
      if (!fix || typeof fix !== 'object') continue;
      const entry = {
        label: String(fix.label ?? 'Fix').slice(0, 120),
        explanation: String(fix.explanation ?? '').slice(0, 500),
        proposalId: null,
      };
      const change = fix.change;
      if (change && typeof change === 'object' && change.path) {
        try {
          const { changes, rejected } = validateChanges(instanceDir, [
            { ...change, action: 'replace', reason: entry.label },
          ], { knownPaths: new Set(files.map((f) => f.path)) });
          if (changes.length > 0) {
            const id = crypto.randomUUID();
            registerExternalProposal(id, instanceDir, entry.label, changes);
            entry.proposalId = id;
            proposalsUsed++;
          } else if (rejected[0]) {
            entry.explanation += ` (file change rejected: ${rejected[0].reason})`;
          }
        } catch (err) {
          entry.explanation += ` (file change rejected: ${err.message})`;
        }
      }
      fixes.push(entry);
    }

    logger?.info(`AI analysis: ${(data.causes ?? []).length} cause(s), ${fixes.length} fix(es) (${proposalsUsed} file change(s) staged for approval)`, 'troubleshoot');
    return {
      findings: analysis.findings,
      mentions: analysis.mentions,
      matched: analysis.matched,
      ai: {
        summary: String(data.summary ?? '').slice(0, 1200),
        causes: (Array.isArray(data.causes) ? data.causes : []).slice(0, 6).map((c) => ({
          subject: String(c?.subject ?? '').slice(0, 160),
          explanation: String(c?.explanation ?? '').slice(0, 500),
          confidence: ['high', 'medium', 'low'].includes(c?.confidence) ? c.confidence : 'low',
        })),
        fixes,
      },
      note: null,
    };
  } catch (err) {
    // Transparency: never pretend the AI ran. Deterministic findings still stand.
    return {
      findings: analysis.findings,
      mentions: analysis.mentions,
      matched: analysis.matched,
      ai: null,
      note: `AI explanation unavailable: ${err.message}`,
    };
  }
}
