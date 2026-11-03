// schema.js — canonical data models shared by the pipeline, the API and the UI.
// Every generated artifact (mod entry, catalog hit, manifest, compat report,
// questbook) has one declared shape here, plus a lightweight runtime validator
// so a structurally wrong object is caught at the boundary instead of silently
// rendering or writing garbage. Types are JSON-friendly by design: the models
// must be serializable, inspectable via GET /api/schema and testable offline.
export const APP_NAME = 'VFreeBuff';

const t = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  'array<string>': (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
};

/**
 * Model registry. Each field: { type, optional?, desc }.
 * `optional` fields may be absent (undefined); when present they must match.
 */
export const MODELS = {
  ModEntry: {
    description: 'One mod in a generated pack, as recorded by the downloader.',
    fields: {
      name: { type: 'string', desc: 'Display title from Modrinth.' },
      slug: { type: 'string', desc: 'Modrinth project slug.' },
      version: { type: 'string', desc: 'Modrinth version number of the chosen build.' },
      file: { type: 'string', desc: 'Jar filename inside <instance>/mods.' },
      fromDependency: { type: 'boolean', desc: 'true when auto-resolved as a required dependency.' },
      projectId: { type: 'string', optional: true, desc: 'Modrinth project id.' },
      versionId: { type: 'string', optional: true, desc: 'Modrinth version id of the chosen build.' },
      url: { type: 'string', optional: true, desc: 'Direct download URL (goes into the manifest).' },
      hashes: { type: 'object', optional: true, desc: '{ sha1, sha512 } of the jar.' },
      size: { type: 'number', optional: true, desc: 'File size in bytes.' },
      gameVersions: { type: 'array<string>', optional: true, desc: 'MC versions the chosen build supports.' },
      loaders: { type: 'array<string>', optional: true, desc: 'Loaders the chosen build supports.' },
      requiredDeps: { type: 'array<string>', optional: true, desc: 'projectIds this mod hard-requires.' },
      hashVerified: { type: 'boolean', optional: true, desc: 'sha512 checked during download.' },
    },
  },

  CatalogEntry: {
    description: 'One searchable mod in the catalog, scored against the pack target.',
    fields: {
      slug: { type: 'string', desc: 'Modrinth project slug.' },
      title: { type: 'string', desc: 'Project title.' },
      description: { type: 'string', desc: 'One-line summary.' },
      author: { type: 'string', desc: 'Primary author/team.' },
      downloads: { type: 'number', desc: 'Lifetime downloads.' },
      follows: { type: 'number', desc: 'Followers.' },
      categories: { type: 'array<string>', desc: 'Modrinth categories incl. the loader facet.' },
      versions: { type: 'array<string>', desc: 'Minecraft versions this project supports.' },
      iconUrl: { type: 'string', desc: 'Project icon URL (may be empty).' },
      projectType: { type: 'string', desc: 'mod | modpack | resourcepack | shader…' },
      compatible: { type: 'boolean', desc: 'Matches the current target MC version + loader + is a mod.' },
      url: { type: 'string', desc: 'Canonical Modrinth project URL.' },
      clientSide: { type: 'string', optional: true, desc: 'required|optional|unsupported|unknown' },
      serverSide: { type: 'string', optional: true, desc: 'required|optional|unsupported|unknown' },
    },
  },

  ModDetail: {
    description: 'Catalog detail for one mod: latest compatible build + required dependencies.',
    fields: {
      entry: { type: 'object', desc: 'The CatalogEntry for this project.' },
      latestVersion: { type: 'string', desc: 'Version number of the newest compatible build ("" if none).' },
      latestVersionId: { type: 'string', desc: 'Modrinth version id of that build.' },
      releaseChannel: { type: 'string', desc: 'release | beta | alpha.' },
      datePublished: { type: 'string', desc: 'ISO date of that build.' },
      requiredDeps: { type: 'array', desc: 'Required dependencies: [{ projectId, name }].' },
      recentVersions: { type: 'array', desc: 'Last 5 builds: [{ versionNumber, type, datePublished, gameVersions, loaders }].' },
      compatible: { type: 'boolean', desc: 'A build exists for the current target.' },
    },
  },

  ModpackManifest: {
    description: 'Modrinth App pack manifest (modrinth.index.json, formatVersion 1) written per build.',
    fields: {
      formatVersion: { type: 'number', desc: 'Always 1.' },
      game: { type: 'string', desc: 'Always "minecraft".' },
      versionId: { type: 'string', desc: 'Pack version identifier.' },
      name: { type: 'string', desc: 'Pack name.' },
      summary: { type: 'string', desc: 'Short description (first line of the prompt).' },
      files: { type: 'array', desc: '[{ path, hashes:{sha1,sha512}, downloads:[url], fileSize }] — path is mods/<jar>.' },
      dependencies: { type: 'object', desc: '{ minecraft, forge|fabric-loader|neoforge|quilt-loader } — loader key omitted when its version is unknown.' },
    },
  },

  CompatReport: {
    description: 'Deterministic compatibility validation of a built pack (never AI-generated).',
    fields: {
      ok: { type: 'boolean', desc: 'true when no check failed.' },
      generatedAt: { type: 'string', desc: 'ISO timestamp.' },
      target: { type: 'object', desc: '{ minecraftVersion, modLoader, loaderVersion|null }.' },
      stats: { type: 'object', desc: '{ requested, downloaded, dependencies, skipped }.' },
      checks: { type: 'array', desc: '[{ code, label, status: pass|warn|fail|info, detail }].' },
      issues: { type: 'array', desc: '[{ severity: error|warn, code, subject, message }].' },
      reportPath: { type: 'string', optional: true, desc: 'Where the report was written.' },
    },
  },

  Questbook: {
    description: "The pack's own questbook (config/modpackquestforge/questbook.json) — canonical progression output.",
    fields: {
      format: { type: 'string', desc: 'modpackquestforge/questbook@1' },
      packTitle: { type: 'string', desc: 'Pack name.' },
      prompt: { type: 'string', desc: 'The plain-language request behind the pack.' },
      minecraftVersion: { type: 'string', desc: 'Target MC version.' },
      modLoader: { type: 'string', desc: 'Target loader.' },
      createdAt: { type: 'string', desc: 'ISO timestamp.' },
      chapters: { type: 'array', desc: '[{ id, title, icon, description, orderIndex, quests:[…] }] — deps may cross chapters (pack-wide DAG)' },
    },
  },

  ConfigProposal: {
    description: 'AI-proposed config changes staged for preview — never applied without approval.',
    fields: {
      proposalId: { type: 'string', desc: 'Server-side id of the pending proposal.' },
      instruction: { type: 'string', desc: 'The natural-language request behind it.' },
      note: { type: 'string', optional: true, desc: 'Model note when the request cannot be done via config files.' },
      filesUsed: { type: 'number', desc: 'How many config files were shown to the model.' },
      changes: { type: 'array', desc: '[{ path, action: replace|create, reason, added, removed, diff }] — validated against the real files.' },
      rejected: { type: 'array', desc: 'Proposed changes the deterministic validator refused, with reasons.' },
    },
  },

  TroubleshootReport: {
    description: 'Crash/log analysis: deterministic signatures first, optional AI explanation on top.',
    fields: {
      findings: { type: 'array', desc: '[{ code, severity: error|warn|info, subject, message, suggestion }].' },
      mentions: { type: 'array<string>', desc: 'Mod ids named in the report.' },
      matched: { type: 'array<string>', desc: 'Mentions that match this pack\'s actual jars.' },
      ai: { type: 'object', optional: true, desc: '{ summary, causes:[…], fixes:[…] } when the AI ran; null otherwise.' },
      note: { type: 'string', optional: true, desc: 'Why no AI explanation was produced (or provider failure).' },
    },
  },
};

/** Validate an object against one of the MODELS. Returns { ok, errors[] }. */
export function validate(modelName, obj) {
  const model = MODELS[modelName];
  if (!model) return { ok: false, errors: [`unknown model "${modelName}"`] };
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['value must be an object'] };
  }
  for (const [field, spec] of Object.entries(model.fields)) {
    const v = obj[field];
    if (v === undefined || v === null) {
      if (!spec.optional) errors.push(`${field}: required ${spec.type} is missing`);
      continue;
    }
    const check = t[spec.type];
    if (!check) { errors.push(`${field}: validator declares unknown type "${spec.type}"`); continue; }
    if (!check(v)) errors.push(`${field}: expected ${spec.type}, got ${Array.isArray(v) ? 'array' : typeof v}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Compact model listing for GET /api/schema (what the UI/docs render). */
export function schemaDoc() {
  return {
    app: APP_NAME,
    version: 1,
    models: Object.fromEntries(
      Object.entries(MODELS).map(([name, m]) => [
        name,
        { description: m.description, fields: m.fields },
      ]),
    ),
  };
}
