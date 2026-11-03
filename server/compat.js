// compat.js — deterministic compatibility validation of a built pack.
//
// This is the "never claim a modpack is compatible unless the checks were
// actually performed" rule from the spec, made executable: every claim in the
// report maps to a check over real data (Modrinth version metadata captured
// during download, file hashes, the launcher's mmc-pack.json, the written
// questbook). Nothing here is AI-generated, and the report is persisted next
// to the pack so it can be inspected later.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { validate } from './schema.js';
import { namespaceCandidates } from './quests.js';

const MIN_MODS = 10;

export function compatPathFor(instanceDir) {
  return path.join(instanceDir, 'config', 'modpackquestforge', 'compat-report.json');
}

const check = (code, label, status, detail) => ({ code, label, status, detail });

/** Namespaces used by quest items/rewards (e.g. "create", "minecraft"). */
function questNamespaces(questbook) {
  const ns = new Set();
  for (const ch of questbook?.chapters ?? []) {
    for (const q of ch?.quests ?? []) {
      for (const t of q?.tasks ?? []) if (typeof t.item === 'string' && t.item.includes(':')) ns.add(t.item.split(':')[0]);
      for (const r of q?.rewards ?? []) if (typeof r.item === 'string' && r.item.includes(':')) ns.add(r.item.split(':')[0]);
    }
  }
  return ns;
}

/**
 * Validate a built pack.
 *
 * @param {object} input
 * @param {string[]} input.requested  slugs the AI asked for
 * @param {object[]} input.mods       downloaded ModEntry records
 * @param {object[]} input.skipped    [{ slug, reason }]
 * @param {string} input.mcVersion    target Minecraft version
 * @param {string} input.loader       target loader id
 * @param {string|null} input.loaderVersion  loader version from mmc-pack.json
 * @param {string} input.instanceDir
 * @param {object|null} input.questbook  the written questbook, when available
 * @returns {{ok, generatedAt, target, stats, checks, issues}}
 */
export function validateCompatibility({
  requested = [], mods = [], skipped = [], mcVersion = '', loader = '',
  loaderVersion = null, instanceDir = '', questbook = null,
} = {}) {
  const checks = [];
  const issues = [];
  const add = (severity, code, subject, message) => issues.push({ severity, code, subject, message });

  // 1) instance directory --------------------------------------------------
  let dirOk = false;
  try { dirOk = Boolean(instanceDir) && fs.statSync(instanceDir).isDirectory(); } catch { dirOk = false; }
  checks.push(check('instance-dir', 'Instance directory exists', dirOk ? 'pass' : 'fail', instanceDir || 'not set'));
  if (!dirOk) add('error', 'instance-dir', instanceDir || '(unset)', 'instance directory is missing');

  // 2) Minecraft version support of every chosen build ---------------------
  const noMcMeta = mods.filter((m) => !Array.isArray(m.gameVersions) || m.gameVersions.length === 0);
  const badMc = mods.filter((m) => Array.isArray(m.gameVersions) && m.gameVersions.length > 0 && mcVersion && !m.gameVersions.includes(mcVersion));
  if (badMc.length) {
    checks.push(check('minecraft-version', `All builds support Minecraft ${mcVersion}`, 'fail', badMc.map((m) => m.slug).join(', ')));
    for (const m of badMc) add('error', 'minecraft-version', `${m.slug} ${m.version}`, `chosen build does not list Minecraft ${mcVersion} (supports: ${m.gameVersions.join(', ')})`);
  } else if (noMcMeta.length === mods.length && mods.length > 0) {
    checks.push(check('minecraft-version', `All builds support Minecraft ${mcVersion}`, 'info', 'version metadata not captured for these builds'));
  } else {
    checks.push(check('minecraft-version', `All builds support Minecraft ${mcVersion}`, 'pass', `${mods.length - noMcMeta.length}/${mods.length} builds carry version metadata`));
  }

  // 3) Loader support ------------------------------------------------------
  const badLoader = mods.filter((m) => Array.isArray(m.loaders) && m.loaders.length > 0 && loader && !m.loaders.includes(loader));
  if (badLoader.length) {
    checks.push(check('loader', `All builds support ${loader}`, 'fail', badLoader.map((m) => m.slug).join(', ')));
    for (const m of badLoader) add('error', 'loader', `${m.slug} ${m.version}`, `chosen build does not list ${loader} (supports: ${m.loaders.join(', ')})`);
  } else {
    checks.push(check('loader', `All builds support ${loader}`, 'pass', 'filtered at resolve time by Modrinth loader facets'));
  }

  // 4) Required dependencies present in the pack ---------------------------
  const present = new Set(mods.map((m) => m.projectId).filter(Boolean));
  const missingDeps = [];
  for (const m of mods) {
    for (const dep of m.requiredDeps ?? []) {
      if (dep && !present.has(dep)) missingDeps.push({ mod: m.slug, dep });
    }
  }
  checks.push(check('required-deps', 'Required dependencies included', missingDeps.length ? 'fail' : 'pass',
    missingDeps.length ? missingDeps.map((d) => `${d.mod} needs ${d.dep}`).join('; ') : 'dependency closure complete'));
  for (const d of missingDeps) add('error', 'required-deps', d.mod, `required dependency ${d.dep} is not in the pack`);

  // 5) Duplicates ----------------------------------------------------------
  const seenFiles = new Set();
  const dupes = [];
  for (const m of mods) {
    if (m.file && seenFiles.has(m.file)) dupes.push(m.file);
    seenFiles.add(m.file);
  }
  checks.push(check('unique-jars', 'No duplicate jars', dupes.length ? 'fail' : 'pass', dupes.length ? dupes.join(', ') : `${mods.length} unique files`));
  for (const f of dupes) add('error', 'unique-jars', f, 'two mods resolve to the same jar filename');

  // 6) Hash integrity ------------------------------------------------------
  const verified = mods.filter((m) => m.hashVerified === true).length;
  const unverified = mods.length - verified;
  checks.push(check('hash-integrity', 'sha512 verified during download', unverified === 0 ? 'pass' : 'warn',
    unverified === 0 ? `${verified}/${mods.length} jars hash-verified` : `${unverified} jar(s) had no sha512 to verify`));
  if (unverified > 0) add('warn', 'hash-integrity', `${unverified} jar(s)`, 'no sha512 hash available to verify');

  // 7) Requested coverage --------------------------------------------------
  const failedRequested = skipped.filter((s) => requested.includes(s.slug) || !s.slug);
  if (mods.length === 0) {
    checks.push(check('coverage', 'Requested mods resolved', 'fail', 'nothing was downloaded'));
    add('error', 'coverage', 'downloads', 'no mods could be downloaded — the pack is empty');
  } else if (failedRequested.length) {
    checks.push(check('coverage', 'Requested mods resolved', 'warn',
      `${mods.length}/${requested.length} requested resolved; skipped: ${failedRequested.map((s) => s.slug).join(', ')}`));
    for (const s of failedRequested) add('warn', 'coverage', s.slug, s.reason || 'skipped during resolution');
  } else {
    checks.push(check('coverage', 'Requested mods resolved', 'pass', `${mods.length}/${requested.length} resolved (incl. dependencies)`));
  }

  // 8) Mod count sanity ----------------------------------------------------
  const depCount = mods.filter((m) => m.fromDependency).length;
  checks.push(check('mod-count', `Pack size (${MIN_MODS}+ mods)`, mods.length >= MIN_MODS ? 'pass' : 'warn',
    `${mods.length} mods (${mods.length - depCount} chosen, ${depCount} dependencies)`));
  if (mods.length < MIN_MODS) add('warn', 'mod-count', `${mods.length} mods`, `fewer than ${MIN_MODS} mods — the theme may be too narrow`);

  // 9) Loader version from the launcher ------------------------------------
  checks.push(check('loader-version', 'Loader version known', loaderVersion ? 'pass' : 'warn',
    loaderVersion ? `${loader} ${loaderVersion} (mmc-pack.json)` : 'mmc-pack.json not found — manifest omits the loader dependency'));
  if (!loaderVersion) add('warn', 'loader-version', loader, 'loader version unknown — modrinth.index.json will not pin the loader');

  // 10) Quest item references vs installed mods -----------------------------
  if (questbook) {
    const known = namespaceCandidates(mods);
    const used = questNamespaces(questbook);
    const unknown = [...used].filter((ns) => !known.has(ns));
    checks.push(check('quest-refs', 'Quest items exist in the pack', unknown.length ? 'warn' : 'pass',
      unknown.length ? `unknown namespace(s): ${unknown.join(', ')}` : `${used.size} namespace(s) all resolve`));
    for (const ns of unknown) add('warn', 'quest-refs', ns, `quests reference "${ns}:" items — not among the installed mods`);
  } else {
    checks.push(check('quest-refs', 'Quest items exist in the pack', 'info', 'no questbook available for this run'));
  }

  const report = {
    ok: !checks.some((c) => c.status === 'fail'),
    generatedAt: new Date().toISOString(),
    target: { minecraftVersion: mcVersion, modLoader: loader, loaderVersion: loaderVersion || null },
    stats: {
      requested: requested.length,
      downloaded: mods.length,
      dependencies: depCount,
      skipped: skipped.length,
    },
    checks,
    issues,
  };

  const { ok, errors } = validate('CompatReport', report);
  if (!ok) throw new Error(`compat report failed schema validation: ${errors.join('; ')}`);
  return report;
}

/** Persist the report next to the pack; returns { report, file }. */
export async function writeCompatReport(instanceDir, report) {
  if (!instanceDir) return { report, file: null };
  const file = compatPathFor(instanceDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const withPath = { ...report, reportPath: file };
  await fsp.writeFile(file, JSON.stringify(withPath, null, 2) + '\n', 'utf8');
  return { report: withPath, file };
}

/** Read the last written report for an instance (null when none). */
export async function readCompatReport(instanceDir) {
  if (!instanceDir) return null;
  try {
    return JSON.parse(await fsp.readFile(compatPathFor(instanceDir), 'utf8'));
  } catch {
    return null;
  }
}
