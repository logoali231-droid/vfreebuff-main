// pipeline.js — ties the three modules together for one generation run:
// AI orchestrator -> Modrinth downloader -> AI questline generator.
// Emits structured run events (phase/status/done/failed) alongside log lines.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { loadConfig } from './config.js';
import { resolveProvider } from './providers.js';
import { runLogger } from './logger.js';
import { selectMods } from './orchestrator.js';
import { downloadModpack } from './modrinth.js';
import { generateQuests } from './quests.js';
import { buildManifest, writeManifest, readLauncherMeta, LOADER_DEPENDENCY_KEY } from './manifest.js';
import { validateCompatibility, writeCompatReport } from './compat.js';

export const runs = new EventEmitter();
runs.setMaxListeners(50);

let active = null;          // { runId, startedAt, phase, prompt }
let lastResult = null;      // summary of the most recent completed run

export function getStatus() {
  return {
    running: Boolean(active),
    runId: active?.runId ?? null,
    phase: active?.phase ?? null,
    startedAt: active?.startedAt ?? null,
    lastResult,
  };
}

function emit(event) {
  runs.emit('event', event);
}

class PipelineError extends Error {}

/** Validate preconditions, then run the full pipeline asynchronously. */
export function startRun({ prompt, fetchImpl = fetch }) {
  if (active) throw new PipelineError('A generation run is already in progress');
  const cfg = loadConfig();
  const trimmed = String(prompt ?? '').trim();

  if (trimmed.length < 10) throw new PipelineError('Prompt is too short — describe the modpack theme (min 10 chars).');
  const rp = resolveProvider(cfg, cfg.provider);
  if (!rp) throw new PipelineError(`Unknown provider "${cfg.provider}".`);
  if (!rp.apiKey && !rp.noKey) throw new PipelineError(`No API key configured for provider "${rp.label}". Add it in Settings.`);
  if (!cfg.instanceDir) throw new PipelineError('Prism Launcher instance directory is not set.');
  if (!fs.existsSync(cfg.instanceDir) || !fs.statSync(cfg.instanceDir).isDirectory()) {
    throw new PipelineError(`Instance directory does not exist: ${cfg.instanceDir}`);
  }

  const runId = crypto.randomUUID();
  active = { runId, startedAt: new Date().toISOString(), phase: 'init', prompt: trimmed };
  emit({ type: 'status', ...getStatus() });

  void execute(runId, cfg, trimmed, fetchImpl);
  return { runId };
}

async function execute(runId, cfg, prompt, fetchImpl) {
  const log = runLogger(runId);
  const t0 = Date.now();
  const setPhase = (phase) => {
    if (active) active.phase = phase;
    emit({ type: 'status', ...getStatus() });
    log.info(`——— phase: ${phase} ———`, phase);
  };

  try {
    log.info(`run ${runId} started (provider=${cfg.provider}, MC ${cfg.minecraftVersion}, ${cfg.modLoader})`, 'init');
    log.info(`instance: ${cfg.instanceDir}`, 'init');

    // ---- 1) AI Orchestrator: pick mods -------------------------------
    setPhase('mods');
    const selection = await selectMods({
      prompt, minecraftVersion: cfg.minecraftVersion, modLoader: cfg.modLoader,
      modCount: cfg.modCount, cfg, log, fetchImpl,
    });

    // ---- 2) Modrinth downloader -------------------------------------
    setPhase('download');
    const dl = await downloadModpack(selection.mods, {
      mcVersion: cfg.minecraftVersion,
      loader: cfg.modLoader,
      instanceDir: cfg.instanceDir,
      log, fetchImpl,
    });
    if (dl.downloaded.length === 0) {
      const reasons = dl.skipped.map((s) => `${s.slug} (${s.reason})`).join('; ');
      throw new PipelineError(`No compatible mods could be downloaded. ${reasons}`);
    }
    if (dl.downloaded.length < 10) {
      log.warn(`only ${dl.downloaded.length} mods survived Modrinth compatibility filtering (<10) — the theme may be too narrow or the version/loader combo is rare; quests were still generated`, 'download');
    }

    // ---- 3) AI questline from the FINAL downloaded mod list ----------
    setPhase('quests');
    const quests = await generateQuests({
      prompt,
      mods: dl.downloaded,
      minecraftVersion: cfg.minecraftVersion,
      modLoader: cfg.modLoader,
      cfg, log, fetchImpl,
    });

    // ---- 4) Manifest + deterministic compatibility validation ----------
    setPhase('validate');
    const meta = readLauncherMeta(cfg.instanceDir);
    const loaderVersion = meta.loaderKey === LOADER_DEPENDENCY_KEY[cfg.modLoader] ? meta.loaderVersion : null;
    const packTitle = quests.questbook?.packTitle || 'VFreeBuff Pack';
    const manifest = buildManifest({
      name: packTitle,
      summary: String(prompt).split('\n')[0].slice(0, 190),
      versionId: runId,
      mcVersion: cfg.minecraftVersion,
      loader: cfg.modLoader,
      loaderVersion,
      mods: dl.downloaded,
    });
    const manifestFile = await writeManifest(cfg.instanceDir, manifest);
    log.info(`manifest written → ${manifestFile} (${manifest.files.length} files, ` +
      `${Object.keys(manifest.dependencies).join(' + ')})`, 'validate');
    if (!loaderVersion) log.warn('loader version unknown (no mmc-pack.json) — manifest does not pin the loader', 'validate');

    const { report } = await writeCompatReport(cfg.instanceDir, validateCompatibility({
      requested: dl.requested ?? [],
      mods: dl.downloaded,
      skipped: dl.skipped,
      mcVersion: cfg.minecraftVersion,
      loader: cfg.modLoader,
      loaderVersion,
      instanceDir: cfg.instanceDir,
      questbook: quests.questbook,
    }));
    for (const c of report.checks) {
      const line = `${c.status.toUpperCase().padEnd(4)} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`;
      if (c.status === 'fail') log.error(line, 'validate');
      else if (c.status === 'warn') log.warn(line, 'validate');
      else log.info(line, 'validate');
    }
    log.info(`compatibility ${report.ok ? 'PASS' : 'FAIL'} — ${report.checks.length} checks, ${report.issues.length} issue(s)`, 'validate');

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    lastResult = {
      runId,
      ok: true,
      finishedAt: new Date().toISOString(),
      elapsedSec: Number(elapsed),
      modsDownloaded: dl.downloaded.length,
      mods: dl.downloaded,
      skipped: dl.skipped,
      modsDir: dl.modsDir,
      chapters: quests.chapters,
      chapterFiles: quests.files,
      questbookPath: quests.questbookFile,
      manifestPath: manifestFile,
      compat: {
        ok: report.ok,
        path: report.reportPath ?? null,
        checks: report.checks,
        issues: report.issues,
        stats: report.stats,
      },
      exportFtbSnbt: cfg.exportFtbSnbt !== false,
      provider: cfg.provider,
      model: resolveProvider(cfg, cfg.provider)?.model ?? cfg.provider,
    };
    log.success(`run complete in ${elapsed}s — ${dl.downloaded.length} mods, ${quests.chapters.length} chapters`, 'done');
    emit({ type: 'done', summary: lastResult });
  } catch (err) {
    const message = err?.message ?? String(err);
    log.error(`run failed: ${message}`, active?.phase ?? 'error');
    if (err?.stack && !(err.name === 'LlmError' || err.name === 'ModrinthError')) {
      log.debug(err.stack.split('\n').slice(1, 4).join(' | '), active?.phase ?? 'error');
    }
    lastResult = { runId, ok: false, error: message, finishedAt: new Date().toISOString() };
    emit({ type: 'failed', error: message, runId });
  } finally {
    if (active?.runId === runId) active = null;
    emit({ type: 'status', ...getStatus() });
  }
}
