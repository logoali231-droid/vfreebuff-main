// manifest.js — pack manifests.
//
// Two responsibilities:
//  * modrinth.index.json — the STANDARD Modrinth App manifest (formatVersion
//    1): every jar with its path, sha1/sha512 hashes, download URL and size,
//    plus the minecraft/loader dependencies. Importable by the Modrinth App.
//  * loader metadata — read from the launcher's own mmc-pack.json (Prism /
//    ATLauncher instance root) when present; the loader version is NEVER
//    guessed. If it cannot be determined the loader dependency is omitted and
//    the compatibility report says so.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { validate } from './schema.js';

/** Modrinth manifest dependency key for each supported loader. */
export const LOADER_DEPENDENCY_KEY = Object.freeze({
  forge: 'forge',
  fabric: 'fabric-loader',
  neoforge: 'neoforge',
  quilt: 'quilt-loader',
});

/** Launcher component uid -> manifest dependency key. */
const UID_DEPENDENCY_KEY = Object.freeze({
  'net.minecraftforge': 'forge',
  'net.fabricmc': 'fabric-loader',
  'net.fabricmc.fabric-loader': 'fabric-loader',
  'net.neoforged': 'neoforge',
  'net.neoforged.moddev': 'neoforge',
  'org.quiltmc.quilt-loader': 'quilt-loader',
});

/**
 * Read launcher metadata for an instance (mmc-pack.json lives in the Prism
 * instance root, i.e. the parent of .minecraft, or inside the dir itself).
 * @returns {{minecraftVersion:string|null, loaderVersion:string|null, loaderKey:string|null, source:string|null}}
 */
export function readLauncherMeta(instanceDir) {
  const out = { minecraftVersion: null, loaderVersion: null, loaderKey: null, source: null };
  if (!instanceDir) return out;
  const candidates = [
    path.join(path.dirname(instanceDir), 'mmc-pack.json'),
    path.join(instanceDir, 'mmc-pack.json'),
  ];
  for (const file of candidates) {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const comps = Array.isArray(raw?.components) ? raw.components : [];
    for (const c of comps) {
      const uid = String(c?.uid ?? '');
      const version = typeof c?.version === 'string' ? c.version : '';
      if (!version) continue;
      if (uid === 'minecraft') out.minecraftVersion = version;
      const key = UID_DEPENDENCY_KEY[uid];
      if (key) { out.loaderKey = key; out.loaderVersion = version; }
    }
    out.source = file;
    break;
  }
  return out;
}

/**
 * Build a modrinth.index.json document from the downloaded mod list.
 * Structurally validated against the ModpackManifest model before returning.
 *
 * @param {{name, summary?, versionId?, mcVersion, loader, loaderVersion?, mods}} input
 *   `mods` are ModEntry records (file/hashes/url/size required per entry).
 */
export function buildManifest({ name, summary = '', versionId = '', mcVersion, loader, loaderVersion = null, mods = [] }) {
  const files = [];
  for (const m of mods) {
    if (!m || typeof m.file !== 'string' || !m.file) continue;
    const hashes = {};
    if (m.hashes?.sha1) hashes.sha1 = String(m.hashes.sha1);
    if (m.hashes?.sha512) hashes.sha512 = String(m.hashes.sha512);
    files.push({
      path: `mods/${m.file.replace(/\\/g, '/')}`,
      hashes,
      downloads: typeof m.url === 'string' && /^https:\/\//.test(m.url) ? [m.url] : [],
      fileSize: Number.isFinite(m.size) ? m.size : 0,
    });
  }

  const dependencies = { minecraft: String(mcVersion) };
  const depKey = LOADER_DEPENDENCY_KEY[loader];
  if (depKey && loaderVersion) dependencies[depKey] = String(loaderVersion);

  const manifest = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: String(versionId || new Date().toISOString().slice(0, 10)),
    name: String(name || 'VFreeBuff Pack'),
    summary: String(summary).slice(0, 200),
    files,
    dependencies,
  };

  const { ok, errors } = validate('ModpackManifest', manifest);
  if (!ok) throw new Error(`manifest failed schema validation: ${errors.join('; ')}`);
  return manifest;
}

export function manifestPathFor(instanceDir) {
  return path.join(instanceDir, 'modrinth.index.json');
}

/** Write the manifest into the instance root; returns the file path. */
export async function writeManifest(instanceDir, manifest) {
  const file = manifestPathFor(instanceDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return file;
}

/** Read back the instance's manifest, or null when there is none yet. */
export async function readManifest(instanceDir) {
  if (!instanceDir) return null;
  try {
    const raw = JSON.parse(await fsp.readFile(manifestPathFor(instanceDir), 'utf8'));
    return validate('ModpackManifest', raw).ok ? raw : raw; // tolerate older files
  } catch {
    return null;
  }
}
