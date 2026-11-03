// catalog.js — the mods catalog: browse and search Modrinth with the pack's
// target Minecraft version + loader baked into the query, so every result is
// already filtered by real metadata (never AI guesses), plus per-mod detail
// (latest compatible build and its required dependencies).
import { apiGet, encFilters } from './modrinth.js';
import { validate } from './schema.js';

const LOADER_FACET = { forge: 'forge', fabric: 'fabric', neoforge: 'neoforge', quilt: 'quilt' };
const SORTS = new Set(['relevance', 'downloads', 'follows', 'updated', 'newest']);

/**
 * Build the Modrinth /search path for a target pack.
 * MC version and loader are FACETS (loader lives under `categories`), the
 * project type facet keeps the catalog to actual mods.
 */
export function buildSearchPath({ query = '', mcVersion = '', loader = '', limit = 24, offset = 0, sort = 'relevance' } = {}) {
  const facets = [];
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  if (loader && LOADER_FACET[loader]) facets.push([`categories:${LOADER_FACET[loader]}`]);
  facets.push(['project_type:mod']);

  const params = new URLSearchParams();
  if (query) params.set('query', query);
  params.set('facets', JSON.stringify(facets));
  params.set('index', SORTS.has(sort) ? sort : 'relevance');
  params.set('limit', String(Math.min(100, Math.max(1, Number(limit) || 24))));
  params.set('offset', String(Math.max(0, Number(offset) || 0)));
  return `/search?${params.toString()}`;
}

/** Map a Modrinth search hit (or project payload) to the CatalogEntry model. */
export function normalizeHit(hit, { mcVersion = '', loader = '' } = {}) {
  const versions = Array.isArray(hit.versions) ? hit.versions : [];
  const categories = Array.isArray(hit.categories) ? hit.categories : [];
  const projectType = hit.project_type ?? 'mod';
  const supportsMc = !mcVersion || versions.includes(mcVersion);
  const supportsLoader = !loader || categories.includes(LOADER_FACET[loader]);
  const entry = {
    slug: hit.slug ?? '',
    title: hit.title ?? hit.slug ?? '',
    description: hit.description ?? '',
    author: hit.author ?? '',
    downloads: Number(hit.downloads) || 0,
    follows: Number(hit.follows) || 0,
    categories,
    versions,
    iconUrl: hit.icon_url ?? '',
    projectType,
    clientSide: hit.client_side ?? 'unknown',
    serverSide: hit.server_side ?? 'unknown',
    compatible: projectType === 'mod' && supportsMc && supportsLoader,
    url: `https://modrinth.com/${projectType === 'mod' ? 'mod' : 'modrinth'}/${hit.slug ?? ''}`,
  };
  return entry;
}

/**
 * Search the catalog for the given target.
 * @returns {{ total, offset, limit, target, entries: CatalogEntry[] }}
 */
export async function searchCatalog({ query = '', mcVersion = '', loader = '', limit = 24, offset = 0, sort = 'relevance', fetchImpl = fetch } = {}) {
  const pathname = buildSearchPath({ query, mcVersion, loader, limit, offset, sort });
  const data = await apiGet(pathname, { fetchImpl });
  const hits = Array.isArray(data?.hits) ? data.hits : [];
  const entries = hits.map((h) => normalizeHit(h, { mcVersion, loader }));
  const result = {
    total: Number(data?.total_hits) || entries.length,
    offset: Number(data?.offset) || offset,
    limit: Number(data?.limit) || limit,
    target: { minecraftVersion: mcVersion || null, modLoader: loader || null },
    entries,
  };
  const bad = entries.find((e) => !validate('CatalogEntry', e).ok);
  if (bad) {
    // Should not happen — normalizeHit builds the model — but never ship a
    // malformed catalog entry to the UI.
    const { errors } = validate('CatalogEntry', bad);
    throw new Error(`catalog entry failed schema validation: ${errors.join('; ')}`);
  }
  return result;
}

/**
 * Detail for one mod: project metadata + newest build compatible with the
 * target (with a fallback listing when nothing matches the target filters).
 * @returns {object|null} ModDetail, or null when the slug does not exist.
 */
export async function getModDetail(slug, { mcVersion = '', loader = '', fetchImpl = fetch } = {}) {
  const project = await apiGet(`/project/${encodeURIComponent(slug)}`, { fetchImpl });
  if (!project || project.error) return null;

  // Search hits carry `versions` (MC version strings like "1.20.1"); project
  // payloads carry version *ids* (8-char base62), so re-ask for the version
  // list when what we have cannot be Minecraft versions.
  let versions = Array.isArray(project.versions) ? project.versions : [];
  const looksLikeIds = versions.length > 0 && versions.every((v) => !/^\d+\.\d+/.test(String(v).trim()));
  if (versions.length === 0 || looksLikeIds) {
    const all = (await apiGet(`/project/${project.id}/version`, { fetchImpl })) ?? [];
    versions = [...new Set(all.flatMap((v) => (Array.isArray(v.game_versions) ? v.game_versions : [])))];
  }

  const entry = normalizeHit({ ...project, versions }, { mcVersion, loader });

  const compatible = mcVersion && loader
    ? ((await apiGet(`/project/${project.id}/version${encFilters(mcVersion, loader)}`, { fetchImpl })) ?? [])
    : [];
  const all = compatible.length ? compatible : ((await apiGet(`/project/${project.id}/version`, { fetchImpl })) ?? []);

  // Project payloads do NOT carry the loader in `categories` (search hits do),
  // so compatibility is decided by the authoritative filtered version query:
  // a build exists for this exact MC version + loader.
  const targetGiven = Boolean(mcVersion && loader);
  entry.compatible = entry.projectType === 'mod' && (targetGiven ? compatible.length > 0 : all.length > 0);

  const newest = [...all].sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
  const pick = newest.find((v) => v.version_type === 'release') ?? newest[0] ?? null;
  const file = Array.isArray(pick?.files) ? (pick.files.find((f) => f.primary) ?? pick.files[0]) : null;

  const requiredDeps = (Array.isArray(pick?.dependencies) ? pick.dependencies : [])
    .filter((d) => d.dependency_type === 'required')
    .map((d) => ({ projectId: d.project_id ?? d.version_id ?? '', name: d.file_name ?? d.project_id ?? '' }));

  const detail = {
    entry,
    latestVersion: pick?.version_number ?? '',
    latestVersionId: pick?.id ?? '',
    releaseChannel: pick?.version_type ?? '',
    datePublished: pick?.date_published ?? '',
    requiredDeps,
    recentVersions: newest.slice(0, 5).map((v) => ({
      versionNumber: v.version_number ?? '',
      type: v.version_type ?? '',
      datePublished: v.date_published ?? '',
      gameVersions: Array.isArray(v.game_versions) ? v.game_versions : [],
      loaders: Array.isArray(v.loaders) ? v.loaders : [],
      filename: Array.isArray(v.files) ? (v.files.find((f) => f.primary) ?? v.files[0])?.filename ?? '' : '',
    })),
    compatible: Boolean(compatible.length),
  };

  const { ok, errors } = validate('ModDetail', detail);
  if (!ok) throw new Error(`mod detail failed schema validation: ${errors.join('; ')}`);
  return detail;
}
