

import { getStore } from '@netlify/blobs';
import { lockKey, fateKey, seedBeat, PENDING_TTL_MS } from './schema.mjs';

const JSON_STRONG = { type: 'json', consistency: 'strong' };

const HEAD_KEY = 'beat/head';
const verKey = (n) => `beat/v${n}`;
const PROBE_DEPTH = 4;

export function beatStore() {
  return getStore({ name: 'universal-beat', consistency: 'strong' });
}

async function createOnly(store, key, value) {
  const w = await store.setJSON(key, value, { onlyIfNew: true });
  return !!w.modified;
}

const SETTLE_MS = 40;

async function confirmStored(store, key, predicate) {
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const stored = await store.get(key, JSON_STRONG);
  return !!stored && predicate(stored);
}

function writerStamp() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function advanceHead(store, version) {
  const cur = (await store.get(HEAD_KEY, JSON_STRONG))?.version || 0;
  if (cur >= version) return;
  await store.setJSON(HEAD_KEY, { version });
}

export async function readBeat(store) {
  let version = (await store.get(HEAD_KEY, JSON_STRONG))?.version || 0;

  if (version < 1) {
    await createOnly(store, verKey(1), seedBeat());
    await advanceHead(store, 1);
    version = 1;
  }

  let beat = await store.get(verKey(version), JSON_STRONG);
  for (let i = 0; i < PROBE_DEPTH; i++) {
    const next = await store.get(verKey(version + 1), JSON_STRONG);
    if (!next) break;
    version += 1;
    beat = next;
  }

  if (!beat) {
    const seeded = seedBeat();
    await createOnly(store, verKey(version), seeded);
    beat = (await store.get(verKey(version), JSON_STRONG)) || seeded;
  }

  if (!Array.isArray(beat.ledger)) beat.ledger = [];
  return { beat, version };
}

export async function casBeat(store, mutate, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    const { beat, version } = await readBeat(store);

    const out = mutate(structuredClone(beat));
    if (!out.ok) return out;

    const next = out.beat;
    next.version = version + 1;
    next.writer = writerStamp();

    const key = verKey(next.version);
    if (await createOnly(store, key, next)) {
      if (await confirmStored(store, key, (v) => v.writer === next.writer)) {
        await advanceHead(store, next.version);
        return { ok: true, beat: next, prev: beat, extra: out.extra };
      }
    }

  }
  return { ok: false, status: 503, error: 'busy' };
}

export async function readVersion(store, version) {
  return (await store.get(verKey(version), JSON_STRONG)) || null;
}

export async function reserveLock(store, tokenId, nonce) {
  const key = lockKey(tokenId);
  const now = Date.now();
  const reservation = { pending: true, nonce, at: now };
  const isOurs = (v) => v.pending && v.nonce === nonce;

  if (await createOnly(store, key, reservation) && await confirmStored(store, key, isOurs)) {
    return { ok: true };
  }

  const lock = await store.get(key, JSON_STRONG);
  if (!lock) {
    return (await createOnly(store, key, reservation) && await confirmStored(store, key, isOurs))
      ? { ok: true }
      : { ok: false, reason: 'inflight', lock: null };
  }

  if (!lock.pending) {
    return { ok: false, reason: lock.nonce === nonce ? 'replay' : 'locked', lock };
  }

  if (lock.nonce === nonce) return { ok: true };

  if (now - (lock.at || 0) < PENDING_TTL_MS) return { ok: false, reason: 'inflight', lock };

  await store.delete(key);
  return (await createOnly(store, key, reservation) && await confirmStored(store, key, isOurs))
    ? { ok: true }
    : { ok: false, reason: 'inflight', lock };
}

export async function finalizeLock(store, tokenId, record) {
  await store.setJSON(lockKey(tokenId), { pending: false, ...record });
}

export async function releaseLock(store, tokenId, nonce) {
  const cur = await store.get(lockKey(tokenId), JSON_STRONG);
  if (cur && cur.pending && cur.nonce === nonce) await store.delete(lockKey(tokenId));
}

export async function readLock(store, tokenId) {
  return (await store.get(lockKey(tokenId), JSON_STRONG)) || null;
}

export async function clearLock(store, tokenId) {
  await store.delete(lockKey(tokenId));
}

export async function ipDeviceCount(store, year, hash) {
  const res = await store.list({ prefix: `ip/${year}/${hash}/` });
  return res.blobs.length;
}

export async function markIpDevice(store, year, hash, tokenId) {
  await store.setJSON(`ip/${year}/${hash}/${tokenId}`, { at: Date.now() }, { onlyIfNew: true });
}

export async function writeFate(store, ownerTokenId, fate) {
  if (!ownerTokenId || ownerTokenId === 'seed') return;
  await store.setJSON(fateKey(ownerTokenId), fate);
}

export async function readFate(store, tokenId) {
  return (await store.get(fateKey(tokenId), JSON_STRONG)) || null;
}
