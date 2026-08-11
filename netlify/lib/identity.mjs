

import { LOCK_MS } from './schema.mjs';

const enc = new TextEncoder();
const keyCache = new Map();

export const COOKIE_NAME = 'ub_token';
const TOKEN_RE = /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,7})\.([A-Za-z0-9_-]{20,64})$/;
const MAX_TOKEN_AGE_DAYS = 365;

async function hmacKey(secret) {
  let k = keyCache.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keyCache.set(secret, k);
  }
  return k;
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export async function hmacHex(secret, message) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message));
  return Buffer.from(sig).toString('hex');
}

function secretsOf(env) {
  const list = [env.HMAC_SECRET, env.HMAC_SECRET_PREV].filter(Boolean);
  if (!list.length) throw new Error('HMAC_SECRET is not configured');
  return list;
}

export async function mintToken(env) {
  const uuid = crypto.randomUUID();
  const day = Math.floor(Date.now() / 86400000);
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secretsOf(env)[0]), enc.encode(`v1|${uuid}|${day}`));
  return `v1.${uuid}.${day}.${b64url(sig)}`;
}

export async function verifyToken(token, env) {
  if (typeof token !== 'string' || token.length > 200) return null;
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const [, uuid, dayStr, sigStr] = m;
  const day = Number(dayStr);
  if (!Number.isInteger(day)) return null;
  if (Math.floor(Date.now() / 86400000) - day > MAX_TOKEN_AGE_DAYS) return null;

  let sig;
  try { sig = unb64url(sigStr); } catch { return null; }
  const data = enc.encode(`v1|${uuid}|${day}`);
  for (const secret of secretsOf(env)) {
    if (await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, data)) {
      return { id: uuid, issuedDay: day };
    }
  }
  return null;
}

export function readToken(req) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return req.headers.get('x-beat-token') || null;
}

export function cookieHeader(token, req) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  const maxAge = Math.floor(LOCK_MS / 1000);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly${secure}; SameSite=Lax`;
}

export function clientIp(req, env) {
  if (env.ALLOW_DEBUG_IP === 'true') {
    const dbg = req.headers.get('x-debug-ip');
    if (dbg) return dbg;
  }
  const nf = req.headers.get('x-nf-client-connection-ip');
  if (nf) return nf;
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return '0.0.0.0';
}

export async function ipHash(req, env) {
  const year = new Date().getUTCFullYear();
  return { year, hash: await hmacHex(secretsOf(env)[0], `ip:${clientIp(req, env)}:${year}`) };
}

export function country(context) {
  return context?.geo?.country?.code || '??';
}

export async function isAdmin(req, env) {
  const supplied = req.headers.get('x-beat-admin');
  if (!env.ADMIN_TOKEN || typeof supplied !== 'string') return false;
  const salt = secretsOf(env)[0];
  const [a, b] = await Promise.all([hmacHex(salt, `admin:${supplied}`), hmacHex(salt, `admin:${env.ADMIN_TOKEN}`)]);
  return a === b;
}
