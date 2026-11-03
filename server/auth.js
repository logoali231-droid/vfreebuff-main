// auth.js — minimal shared-password login. No OAuth, no Google, no database.
//
// How it works:
//  - Set APP_PASSWORD in the environment and the whole app is locked behind a
//    single password. No APP_PASSWORD -> auth is OFF (local dev stays frictionless).
//  - Login swaps the password for a random bearer token kept in memory and
//    returned as an HttpOnly, SameSite=Lax cookie (no secret to leak, no
//    storage backend; a server restart simply asks you to log in again).
//  - Password comparison is constant-time (sha256 + timingSafeEqual).
//  - Login attempts are rate-limited per client address.
import crypto from 'node:crypto';

const COOKIE_NAME = 'vfb_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
const WINDOW_MS = 60 * 1000;                     // brute-force window
const MAX_FAILURES = 10;                         // per window per client

let expectedHash = null;                         // sha256(password) or null
const sessions = new Map();                      // token -> expiry epoch ms
const failures = new Map();                      // client -> { windowStart, count }

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Read the password from the environment. Returns { enabled }. */
export function initAuth(env = process.env) {
  const pw = typeof env.APP_PASSWORD === 'string' ? env.APP_PASSWORD : '';
  expectedHash = pw.length > 0 ? sha(pw) : null;
  sessions.clear();
  failures.clear();
  return { enabled: expectedHash !== null };
}

export function authEnabled() {
  return expectedHash !== null;
}

/** Constant-time password check. Always true while auth is disabled. */
export function checkPassword(candidate) {
  if (!expectedHash) return true;
  return crypto.timingSafeEqual(sha(candidate ?? ''), expectedHash);
}

export function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  if (sessions.size > 512) {                     // lazy prune of expired tokens
    const now = Date.now();
    for (const [k, exp] of sessions) if (exp < now) sessions.delete(k);
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function sessionValid(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}

export function revokeSession(token) {
  if (token) sessions.delete(token);
}

export function cookieName() {
  return COOKIE_NAME;
}

/** Extract a cookie value from a request's Cookie header. */
export function readCookie(req, name = COOKIE_NAME) {
  const raw = req?.headers?.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token, { secure = false } = {}) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; `
    + `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
}

export function clearCookie({ secure = false } = {}) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** True when the request arrived over HTTPS (directly or via a proxy). */
export function isSecureRequest(req) {
  return Boolean(req?.socket?.encrypted) || req?.headers?.['x-forwarded-proto'] === 'https';
}

/**
 * Brute-force guard: allows MAX_FAILURES failed attempts per WINDOW_MS and
 * per client. Returns true while attempts are still allowed.
 */
export function allowAttempt(client, now = Date.now()) {
  const rec = failures.get(client);
  if (!rec || now - rec.windowStart > WINDOW_MS) {
    failures.set(client, { windowStart: now, count: 1 });
    return true;
  }
  rec.count += 1;
  return rec.count <= MAX_FAILURES;
}

export function clearFailures(client) {
  failures.delete(client);
}

/** Paths that are reachable without a session when auth is enabled. */
const PUBLIC_PATHS = new Set([
  '/login', '/login.html', '/logout', '/healthz',
  '/api/auth/login', '/api/auth/logout', '/api/auth/status',
]);

export function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname);
}
