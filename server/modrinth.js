// modrinth.js — Modrinth Automated Downloader Module.
// Maps AI-selected slugs to concrete .jar files compatible with the requested
// Minecraft version + loader via the public Modrinth API (api.modrinth.com/v2),
// resolves required dependencies recursively, verifies sha512 hashes, and
// writes everything into <instance>/mods.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const API = 'https://api.modrinth.com/v2';
const UA = 'VFreeBuff/1.0 (local PWA; AI modpack + questbook generator; contact: local-user)';
const MAX_DEPTH = 4;

export class ModrinthError extends Error {
  constructor(message, { status = 0, slug = '' } = {}) {
    super(message);
    this.name = 'ModrinthError';
    this.status = status;
    this.slug = slug;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET a Modrinth endpoint with User-Agent, timeout and a single retry. */
export async function apiGet(pathname, { timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const url = `${API}${pathname}`;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt === 1 && (err.name === 'TimeoutError' || err.name === 'AbortError' || /fetch failed/i.test(err.message))) {
        await sleep(800);
        continue;
      }
      throw new ModrinthError(`Modrinth request failed (${err.message})`);
    }
    if (res.status === 404) return null;                 // caller decides how to report
    if (res.status === 429 && attempt === 1) {           // rate limit (300/min/IP)
      await sleep(2000);
      continue;
    }
    if (res.status >= 500 && attempt === 1) {
      await sleep(1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ModrinthError(`Modrinth HTTP ${res.status} for ${pathname}: ${body.slice(0, 200)}`, { status: res.status });
    }
    try {
      return await res.json();
    } catch {
      throw new ModrinthError(`Modrinth returned invalid JSON for ${pathname}`);
    }
  }
}

export const encFilters = (mcVersion, loader) =>
  `?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}`;

/** Required dependency projectIds declared by a Modrinth version payload. */
const requiredDepIds = (version) =>
  (Array.isArray(version?.dependencies) ? version.dependencies : [])
    .filter((d) => d?.dependency_type === 'required')
    .map((d) => d.project_id ?? d.version_id ?? '')
    .filter(Boolean);

/** Newest release (fallback: any) version for a project under the given filters. */
function pickVersion(versions, { preferRelease = true } = {}) {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const sorted = [...versions].sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
  if (preferRelease) {
    const rel = sorted.find((v) => v.version_type === 'release');
    if (rel) return rel;
  }
  return sorted[0];
}

function pickJarFile(version) {
  const files = Array.isArray(version?.files) ? version.files : [];
  const jar = files.filter((f) => /\.jar$/i.test(f.filename ?? ''));
  const primary = jar.find((f) => f.primary) ?? jar[0];
  return primary ?? null;
}

/**
 * Resolve one slug to a downloadable jar (no download yet).
 * @returns {Promise<{slug,name,projectId,versionId,file,fromDependency}|{slug,error}>}
 */
export async function resolveProject(slug, mcVersion, loader, { fetchImpl = fetch, log } = {}) {
  const project = await apiGet(`/project/${encodeURIComponent(slug)}`, { fetchImpl });
  if (!project) return { slug, error: 'not found on Modrinth (404)' };
  if (project.project_type && project.project_type !== 'mod') {
    log?.warn(`${slug}: project type is "${project.project_type}", expected "mod" — continuing anyway`);
  }

  const versions = await apiGet(`/project/${encodeURIComponent(project.id)}/version${encFilters(mcVersion, loader)}`, { fetchImpl });
  if (!versions || versions.length === 0) {
    return { slug, error: `no version supports Minecraft ${mcVersion} + ${loader}` };
  }
  const version = pickVersion(versions);
  const file = pickJarFile(version);
  if (!file) return { slug, error: `version ${version.version_number ?? version.id} has no .jar file` };

  return {
    slug: project.slug ?? slug,
    name: project.title ?? slug,
    projectId: project.id,
    versionId: version.id,
    versionNumber: version.version_number ?? '',
    file,
    fromDependency: false,
    // compatibility metadata (for the manifest + deterministic validation):
    gameVersions: Array.isArray(version.game_versions) ? version.game_versions : [],
    loaders: Array.isArray(version.loaders) ? version.loaders : [],
    requiredDeps: requiredDepIds(version),
  };
}

/** Resolve a "required" dependency entry from a Modrinth version payload. */
async function resolveDependency(dep, mcVersion, loader, { fetchImpl, log, depth }) {
  if (dep.version_id) {
    const v = await apiGet(`/version/${encodeURIComponent(dep.version_id)}`, { fetchImpl });
    if (v) {
      const okMc = !Array.isArray(v.game_versions) || v.game_versions.includes(mcVersion);
      const okLoader = !Array.isArray(v.loaders) || v.loaders.includes(loader);
      if (okMc && okLoader) {
        const file = pickJarFile(v);
        if (file) {
          return {
            slug: v.project_id, name: v.name ?? v.project_id,
            projectId: v.project_id, versionId: v.id,
            versionNumber: v.version_number ?? '', file, fromDependency: true,
            gameVersions: Array.isArray(v.game_versions) ? v.game_versions : [],
            loaders: Array.isArray(v.loaders) ? v.loaders : [],
            requiredDeps: requiredDepIds(v),
          };
        }
      }
      log?.warn(`dependency version ${dep.version_id} not compatible with ${mcVersion}/${loader}; resolving by filters instead`);
    }
  }
  if (dep.project_id) {
    const versions = await apiGet(`/project/${encodeURIComponent(dep.project_id)}/version${encFilters(mcVersion, loader)}`, { fetchImpl });
    const version = pickVersion(versions ?? []);
    if (version) {
      const file = pickJarFile(version);
      if (file) {
        const proj = await apiGet(`/project/${encodeURIComponent(dep.project_id)}`, { fetchImpl }).catch(() => null);
        return {
          slug: proj?.slug ?? dep.project_id,
          name: proj?.title ?? dep.file_name ?? dep.project_id,
          projectId: dep.project_id, versionId: version.id,
          versionNumber: version.version_number ?? '', file, fromDependency: true,
          gameVersions: Array.isArray(version.game_versions) ? version.game_versions : [],
          loaders: Array.isArray(version.loaders) ? version.loaders : [],
          requiredDeps: requiredDepIds(version),
        };
      }
    }
    log?.warn(`no ${mcVersion}/${loader} build for dependency project ${dep.file_name ?? dep.project_id}; skipped`);
  }
  return null;
}

async function sha512File(file) {
  const hash = crypto.createHash('sha512');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Download one resolved file into modsDir (atomic .part -> rename, hash-verified).
 * @returns {Promise<{size:number, hashVerified:boolean}>}
 */
async function downloadFile(resolved, modsDir, { fetchImpl = fetch, log } = {}) {
  const dest = path.join(modsDir, resolved.file.filename);
  const tmp = `${dest}.part-${process.pid}`;
  const res = await fetchImpl(resolved.file.url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok || !res.body) throw new ModrinthError(`download failed (HTTP ${res.status}) for ${resolved.file.filename}`);

  const ws = fs.createWriteStream(tmp);
  try {
    await pipeline(res.body, ws);
    const expected = resolved.file.hashes?.sha512;
    if (expected) {
      const actual = await sha512File(tmp);
      if (actual !== expected) throw new ModrinthError(`sha512 mismatch for ${resolved.file.filename}`);
    }
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  const size = (await fsp.stat(dest)).size;
  log?.success(`downloaded ${resolved.file.filename} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  return { size, hashVerified: Boolean(resolved.file.hashes?.sha512) };
}

/**
 * Full pipeline for a list of AI-chosen slugs: resolve -> dependency closure
 * -> download into <instance>/mods.
 *
 * @returns {Promise<{downloaded:[], skipped:[], modsDir:string}>}
 */
export async function downloadModpack(mods, { mcVersion, loader, instanceDir, log, fetchImpl = fetch }) {
  const modsDir = path.join(instanceDir, 'mods');
  await fsp.mkdir(modsDir, { recursive: true });

  const resolvedById = new Map();     // projectId -> resolved (dedupe across slugs+deps)
  const skipped = [];
  const requested = mods.map((m) => m.slug);

  // 1) resolve top-level selections
  for (const mod of mods) {
    try {
      log?.info(`resolving "${mod.slug}" for MC ${mcVersion} + ${loader}…`, 'download');
      const r = await resolveProject(mod.slug, mcVersion, loader, { fetchImpl, log });
      if (r.error) {
        skipped.push({ slug: mod.slug, reason: r.error });
        log?.warn(`skipped ${mod.slug}: ${r.error}`, 'download');
        continue;
      }
      if (resolvedById.has(r.projectId)) continue;
      resolvedById.set(r.projectId, r);
      log?.info(`  -> ${r.name} ${r.versionNumber} [${r.file.filename}]`, 'download');
    } catch (err) {
      skipped.push({ slug: mod.slug, reason: err.message });
      log?.error(`failed to resolve ${mod.slug}: ${err.message}`, 'download');
    }
  }

  // 2) dependency closure (required deps only), breadth-first with depth cap
  let frontier = [...resolvedById.values()].map((r) => ({ resolved: r, depth: 0 }));
  let depChecks = 0;
  while (frontier.length > 0) {
    const next = [];
    for (const item of frontier) {
      if (item.depth >= MAX_DEPTH) continue;
      const deps = Array.isArray(item.resolved.file.versionDependencies)
        ? item.resolved.file.versionDependencies
        : Array.isArray(item.resolved.versionDependencies)
          ? item.resolved.versionDependencies
          : null;
      // Dependencies come from the *version* payload; re-fetch if we don't have them.
      let versionDeps = deps;
      if (!versionDeps) {
        try {
          const v = await apiGet(`/version/${encodeURIComponent(item.resolved.versionId)}`, { fetchImpl });
          versionDeps = v?.dependencies ?? [];
        } catch (err) {
          log?.warn(`could not fetch dependencies for ${item.resolved.slug}: ${err.message}`, 'download');
          versionDeps = [];
        }
      }
      // Backfill the compat metadata when it was not on the resolve payload.
      if ((!item.resolved.requiredDeps || item.resolved.requiredDeps.length === 0) && Array.isArray(versionDeps)) {
        item.resolved.requiredDeps = versionDeps
          .filter((d) => d?.dependency_type === 'required')
          .map((d) => d.project_id ?? d.version_id ?? '')
          .filter(Boolean);
      }
      for (const dep of versionDeps) {
        if (dep.dependency_type !== 'required') continue;
        const known = dep.project_id && resolvedById.has(dep.project_id);
        if (known) continue;
        depChecks++;
        if (depChecks > 80) { log?.warn('dependency resolution cap reached (80); stopping', 'download'); frontier = []; break; }
        try {
          const r = await resolveDependency(dep, mcVersion, loader, { fetchImpl, log, depth: item.depth + 1 });
          if (!r) continue;
          if (resolvedById.has(r.projectId)) continue;
          resolvedById.set(r.projectId, r);
          log?.info(`  + dependency: ${r.name} ${r.versionNumber} [${r.file.filename}]`, 'download');
          next.push({ resolved: r, depth: item.depth + 1 });
        } catch (err) {
          log?.warn(`dependency ${dep.file_name ?? dep.project_id} failed: ${err.message}`, 'download');
        }
      }
    }
    frontier = next;
  }

  // 3) download everything
  const all = [...resolvedById.values()];
  const downloaded = [];
  const failed = [];
  for (const r of all) {
    try {
      const info = await downloadFile(r, modsDir, { fetchImpl, log });
      downloaded.push({
        name: r.name, slug: r.slug, version: r.versionNumber,
        file: r.file.filename, fromDependency: r.fromDependency,
        // manifest + compatibility fields (ModEntry model):
        projectId: r.projectId, versionId: r.versionId,
        url: r.file.url ?? '',
        hashes: r.file.hashes && typeof r.file.hashes === 'object' ? r.file.hashes : {},
        size: info.size,
        gameVersions: r.gameVersions ?? [],
        loaders: r.loaders ?? [],
        requiredDeps: r.requiredDeps ?? [],
        hashVerified: info.hashVerified,
        
      });
    } catch (err) {
      failed.push({ slug: r.slug, reason: err.message });
      log?.error(`download failed for ${r.slug}: ${err.message}`, 'download');
    }
  }

  const depCount = downloaded.filter((d) => d.fromDependency).length;
  log?.info(
    `downloaded ${downloaded.length} jars (${depCount} dependencies) into ${modsDir}; ` +
    `${skipped.length + failed.length} skipped/failed`,
    'download',
  );
  return { downloaded, skipped: [...skipped, ...failed], modsDir, requested };
}
