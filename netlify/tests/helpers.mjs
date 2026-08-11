

import { readFileSync } from 'node:fs';

export const BASE = process.env.UB_TEST_BASE || 'http://localhost:8888';
export const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(BASE);
export const DESTRUCTIVE = process.env.UB_TEST_DESTRUCTIVE === '1';
export const J = { 'content-type': 'application/json' };

if (!IS_LOCAL && process.env.UB_TEST_REMOTE_OK !== '1') {
  console.error(`\nRefusing to run against ${BASE}.\n` +
    'These tests write real edits and consume real per-IP quota.\n' +
    'To run against a deploy preview, set UB_TEST_REMOTE_OK=1.\n');
  process.exit(2);
}

let failures = 0, checks = 0;
export function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
export function section(name) { console.log(`\n${name}`); }
export function finish() {
  console.log(`\n${failures === 0 ? `ALL ${checks} CHECKS PASSED` : `${failures} of ${checks} CHECKS FAILED`}  (${BASE})`);
  process.exit(failures === 0 ? 0 : 1);
}

export const nonce = (tag, i) => `${tag}-${i}-${Math.random().toString(36).slice(2, 10)}`;

let ipSeq = 0;
export const debugIp = () => `10.${(ipSeq++ % 250) + 1}.${Math.floor(Math.random() * 250)}.7`;

export async function getBeat() {
  return (await fetch(`${BASE}/api/beat`)).json();
}

export async function newDevice(ip = debugIp()) {
  const r = await fetch(`${BASE}/api/me`, { headers: { 'X-Debug-IP': ip } });
  const body = await r.json();
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return { token: body.token, cookie, ip, me: body };
}

export async function me(dev) {
  const h = { 'X-Debug-IP': dev.ip };
  if (dev.cookie) h.cookie = dev.cookie;
  else if (dev.token) h['X-Beat-Token'] = dev.token;
  return (await fetch(`${BASE}/api/me`, { headers: h })).json();
}

export async function edit(dev, body, opts = {}) {
  const h = { ...J, 'X-Debug-IP': dev.ip };
  if (opts.viaHeader) h['X-Beat-Token'] = dev.token;
  else if (dev.cookie) h.cookie = dev.cookie;
  else if (dev.token) h['X-Beat-Token'] = dev.token;
  const r = await fetch(`${BASE}/api/edit`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

export async function freeSlots() {
  const b = await getBeat();
  const taken = new Set(b.notes.map((n) => `${n.inst}:${n.step}`));
  const out = [];
  for (const inst of b.instruments) {
    for (let s = 0; s < b.steps; s++) if (!taken.has(`${inst}:${s}`)) out.push({ inst, step: s });
  }
  return out;
}

export async function admin(action) {
  const token = process.env.ADMIN_TOKEN || readEnv('ADMIN_TOKEN');
  const r = await fetch(`${BASE}/api/admin`, {
    method: 'POST', headers: { ...J, 'X-Beat-Admin': token }, body: JSON.stringify(action),
  });
  return { status: r.status, body: await r.json() };
}

export async function reseed() {
  if (!IS_LOCAL && !DESTRUCTIVE) {
    console.error(`\nRefusing to reseed ${BASE}. That would erase the live loop.\n` +
      'Set UB_TEST_DESTRUCTIVE=1 only if you really mean it.\n');
    process.exit(2);
  }
  return admin({ action: 'reseed' });
}

function readEnv(key) {
  try {
    const txt = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    return (txt.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1]?.trim() || '';
  } catch { return ''; }
}
