// index.js — HTTP server: PWA static files, JSON API, SSE terminal log stream.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, saveConfig, publicConfig } from './config.js';
import { logger, runLogger } from './logger.js';
import { runs, startRun, getStatus } from './pipeline.js';
import { readChaptersLayout } from './preview.js';
import { publicRegistry } from './providers.js';
import { readQuestbook } from './questbook.js';
import { searchCatalog, getModDetail } from './catalog.js';
import { readManifest, manifestPathFor } from './manifest.js';
import { readCompatReport } from './compat.js';
import { schemaDoc } from './schema.js';
import {
  listConfigFiles, readConfigFile, proposeChanges, applyProposal, listBackups, undoBackup,
  proposalPreview,
} from './configedit.js';
import { troubleshoot } from './troubleshoot.js';
import {
  initAuth, authEnabled, checkPassword, createSession, sessionValid, revokeSession,
  readCookie, sessionCookie, clearCookie, isSecureRequest, allowAttempt, clearFailures,
  isPublicPath,
} from './auth.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 512 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------ SSE log ------------------------------ */

const sseClients = new Set();

function sseSend(client, obj) {
  client.res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res };
  sseClients.add(client);

  // replay history so a late/reconnecting terminal still shows the run
  for (const line of logger.history()) sseSend(client, { type: 'log', ...line });
  sseSend(client, { type: 'status', ...getStatus() });

  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.delete(client);
  });
}

const broadcast = (obj) => {
  for (const c of sseClients) sseSend(c, obj);
};

logger.on('entry', (line) => broadcast({ type: 'log', ...line }));
runs.on('event', (event) => broadcast(event));

/* --------------------------- API handlers --------------------------- */

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  /* ---- auth: one shared password (APP_PASSWORD), no third party ---- */
  if (route === 'GET /api/auth/status') {
    return sendJson(res, 200, { enabled: authEnabled(), authed: !authEnabled() || req.authed === true });
  }
  if (route === 'POST /api/auth/login') {
    const client = req.socket.remoteAddress ?? 'unknown';
    if (!allowAttempt(client)) {
      return sendJson(res, 429, { error: 'too many attempts — wait a minute and try again' });
    }
    const body = await readBody(req);
    if (!checkPassword(String(body.password ?? ''))) {
      logger.entry('warn', `login failed from ${client}`);
      return sendJson(res, 401, { error: 'wrong password' });
    }
    clearFailures(client);
    res.setHeader('set-cookie', sessionCookie(createSession(), { secure: isSecureRequest(req) }));
    logger.entry('success', `login ok (${client})`);
    return sendJson(res, 200, { ok: true });
  }
  if (route === 'POST /api/auth/logout') {
    revokeSession(readCookie(req));
    res.setHeader('set-cookie', clearCookie({ secure: isSecureRequest(req) }));
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'GET /api/config') return sendJson(res, 200, publicConfig());

  if (route === 'POST /api/config') {
    const body = await readBody(req);
    const saved = saveConfig(body);
    // persist full instance path etc., but never echo secrets
    void saved;
    return sendJson(res, 200, publicConfig());
  }

  if (route === 'POST /api/instance/validate') {
    const { dir } = await readBody(req);
    const target = String(dir ?? '').trim();
    if (!target) return sendJson(res, 400, { ok: false, error: 'no directory given' });
    let stat = null;
    try { stat = fs.statSync(target); } catch { stat = null; }
    const isDir = Boolean(stat?.isDirectory());
    const check = (p) => { try { return fs.existsSync(p); } catch { return false; } };
    const probe = path.join(target, 'mods-probe');
    let writable = false;
    if (isDir) {
      try {
        fs.mkdirSync(probe, { recursive: true });
        fs.rmSync(probe, { recursive: true, force: true });
        writable = true;
      } catch { writable = false; }
    }
    return sendJson(res, 200, {
      ok: isDir && writable,
      exists: isDir,
      writable,
      hasMods: check(path.join(target, 'mods')),
      hasFtbQuests: check(path.join(target, 'config', 'ftbquests', 'quests', 'chapters')),
      error: !isDir ? 'directory not found' : !writable ? 'directory is not writable' : null,
    });
  }

  if (route === 'POST /api/generate') {
    const body = await readBody(req);
    try {
      const { runId } = startRun({ prompt: body.prompt });
      return sendJson(res, 202, { ok: true, runId });
    } catch (err) {
      return sendJson(res, 409, { ok: false, error: err.message });
    }
  }

  if (route === 'GET /api/status') return sendJson(res, 200, getStatus());

  if (route === 'GET /api/schema') {
    // Canonical data models (ModEntry, CatalogEntry, Manifest, CompatReport…).
    return sendJson(res, 200, schemaDoc());
  }

  if (route === 'GET /api/catalog') {
    // Mods catalog: Modrinth search filtered by the pack's target version+loader.
    const cfg = loadConfig();
    try {
      const data = await searchCatalog({
        query: url.searchParams.get('q') ?? '',
        mcVersion: url.searchParams.get('mc') ?? cfg.minecraftVersion,
        loader: url.searchParams.get('loader') ?? cfg.modLoader,
        limit: Number(url.searchParams.get('limit')) || 24,
        offset: Number(url.searchParams.get('offset')) || 0,
        sort: url.searchParams.get('sort') ?? 'relevance',
      });
      return sendJson(res, 200, data);
    } catch (err) {
      return sendJson(res, 502, { error: `catalog search failed: ${err.message}` });
    }
  }

  if (route.startsWith('GET /api/catalog/')) {
    const cfg = loadConfig();
    const slug = decodeURIComponent(url.pathname.slice('/api/catalog/'.length)).trim();
    if (!slug || slug.includes('/')) return sendJson(res, 400, { error: 'bad slug' });
    try {
      const detail = await getModDetail(slug, {
        mcVersion: url.searchParams.get('mc') ?? cfg.minecraftVersion,
        loader: url.searchParams.get('loader') ?? cfg.modLoader,
      });
      if (!detail) return sendJson(res, 404, { error: `no Modrinth project "${slug}"` });
      return sendJson(res, 200, detail);
    } catch (err) {
      return sendJson(res, 502, { error: `catalog detail failed: ${err.message}` });
    }
  }

  if (route === 'GET /api/manifest') {
    // The pack's modrinth.index.json (standard Modrinth App manifest).
    const cfg = loadConfig();
    const manifest = await readManifest(cfg.instanceDir);
    return sendJson(res, 200, {
      instanceDir: cfg.instanceDir || null,
      manifest,
      path: manifest ? manifestPathFor(cfg.instanceDir) : null,
    });
  }

  if (route === 'GET /api/compat') {
    // Last deterministic compatibility report for the configured instance.
    const cfg = loadConfig();
    const report = await readCompatReport(cfg.instanceDir);
    return sendJson(res, 200, { instanceDir: cfg.instanceDir || null, report });
  }

  if (route === 'GET /api/providers') return sendJson(res, 200, publicRegistry());

  /* ---- config editing: propose -> preview -> approve -> backup -> undo ---- */

  if (route === 'GET /api/config/files') {
    const cfg = loadConfig();
    return sendJson(res, 200, { instanceDir: cfg.instanceDir || null, ...listConfigFiles(cfg.instanceDir) });
  }

  if (route === 'GET /api/config/file') {
    const cfg = loadConfig();
    try {
      const file = await readConfigFile(cfg.instanceDir, url.searchParams.get('path') ?? '');
      return sendJson(res, 200, file);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (route === 'POST /api/config/propose') {
    const cfg = loadConfig();
    const body = await readBody(req);
    try {
      const proposal = await proposeChanges({
        instanceDir: cfg.instanceDir,
        instruction: body.instruction,
        paths: Array.isArray(body.paths) ? body.paths : null,
        cfg, log: runLogger(),
      });
      return sendJson(res, 200, proposal);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (route === 'GET /api/config/proposal') {
    // Preview a staged proposal (used by troubleshoot fixes before approval).
    const preview = proposalPreview(url.searchParams.get('proposalId') ?? '');
    if (!preview) return sendJson(res, 404, { error: 'proposal not found (server restarted — trigger it again)' });
    return sendJson(res, 200, preview);
  }

  if (route === 'POST /api/config/apply') {
    const body = await readBody(req);
    try {
      const result = await applyProposal(String(body.proposalId ?? ''));
      runLogger().success(`applied ${result.files.length} config change(s); backup ${result.backupId}`, 'config');
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (route === 'GET /api/config/backups') {
    const cfg = loadConfig();
    return sendJson(res, 200, { backups: await listBackups(cfg.instanceDir) });
  }

  if (route === 'POST /api/config/undo') {
    const cfg = loadConfig();
    const body = await readBody(req);
    try {
      const result = await undoBackup(cfg.instanceDir, body.id);
      runLogger().success(`undo restored ${result.restored.length} file(s)`, 'config');
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  /* ---- troubleshooting: deterministic analysis + optional AI fixes ---- */

  if (route === 'POST /api/troubleshoot') {
    const cfg = loadConfig();
    const body = await readBody(req);
    try {
      const result = await troubleshoot({
        log: String(body.log ?? ''), cfg, instanceDir: cfg.instanceDir, logger: runLogger(),
      });
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (route === 'GET /api/questbook') {
    // The pack's own questbook (canonical output of the generator).
    const cfg = loadConfig();
    const found = await readQuestbook(cfg.instanceDir);
    return sendJson(res, 200, {
      instanceDir: cfg.instanceDir || null,
      questbook: found?.questbook ?? null,
      warning: found?.warning ?? null,
      path: found?.file ?? null,
    });
  }

  if (route === 'GET /api/chapters') {
    // Visual quest-tree preview: parse the actually-written .snbt chapters of
    // the configured instance (never guessed data).
    const cfg = loadConfig();
    return sendJson(res, 200, readChaptersLayout(cfg.instanceDir));
  }

  if (route === 'GET /api/events') return handleEvents(req, res);

  return sendJson(res, 404, { error: `unknown API route ${route}` });
}

/* --------------------------- Static files --------------------------- */

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA-ish fallback for unknown non-file paths
      if (!path.extname(filePath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) { res.writeHead(404); return res.end('not found'); }
          res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
          res.end(html);
        });
      }
      res.writeHead(404); return res.end('not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': /\.(?:js|css|png|svg|woff2)$/.test(ext) ? 'public, max-age=300' : 'no-cache',
    };
    if (ext === '.js') headers['service-worker-allowed'] = '/'; // harmless if unused
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    // --- auth gate: with APP_PASSWORD set, everything but the login door
    // --- requires a session cookie (API -> 401 JSON, pages -> redirect).
    if (authEnabled()) {
      req.authed = sessionValid(readCookie(req));
      if (!req.authed && !isPublicPath(url.pathname)) {
        if (url.pathname.startsWith('/api/')) {
          return sendJson(res, 401, { error: 'authentication required', login: '/login' });
        }
        res.writeHead(302, { location: '/login', 'cache-control': 'no-store' });
        return res.end();
      }
      if (url.pathname === '/logout') {
        res.writeHead(302, {
          location: '/login',
          'set-cookie': clearCookie({ secure: isSecureRequest(req) }),
          'cache-control': 'no-store',
        });
        return res.end();
      }
      if (url.pathname === '/login' && req.authed) {
        res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
        return res.end();
      }
      if (url.pathname === '/login' || url.pathname === '/login.html') url.pathname = '/login.html';
    } else if (url.pathname === '/login' || url.pathname === '/logout') {
      res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
      return res.end();
    }

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, ...getStatus() });
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, url);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
    logger.entry('error', `server error: ${err.message}`);
  }
});

initAuth(process.env);

server.listen(PORT, HOST, () => {
  const cfg = loadConfig();
  logger.entry('success', `VFreeBuff listening on http://${HOST}:${PORT}`);
  logger.entry('info', `provider=${cfg.provider} · MC ${cfg.minecraftVersion} · ${cfg.modLoader}` +
    (cfg.instanceDir ? ` · instance=${cfg.instanceDir}` : ' · instance not set'));
  logger.entry('info', authEnabled()
    ? 'auth=APP_PASSWORD — login required (set APP_PASSWORD empty to open)'
    : 'auth=off — set APP_PASSWORD to lock the app before deploying');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logger.entry('info', 'shutting down…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
