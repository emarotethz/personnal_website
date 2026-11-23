import { getStore } from '@netlify/blobs';
import { seedState, nonceKey, rateKey } from './sine-schema.mjs';

const JSON_STRONG = { type: 'json', consistency: 'strong' };

const HEAD_KEY = 'sine/head';
const verKey = (n) => `sine/v${n}`;
const PROBE_DEPTH = 4;
const SETTLE_MS = 40;

export function sineStore() {
  return getStore({ name: 'sine', consistency: 'strong' });
}

async function createOnly(store, key, value) {
  const w = await store.setJSON(key, value, { onlyIfNew: true });
  return !!w.modified;
}

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

export async function readState(store) {
  let version = (await store.get(HEAD_KEY, JSON_STRONG))?.version || 0;

  if (version < 1) {
    await createOnly(store, verKey(1), seedState());
    await advanceHead(store, 1);
    version = 1;
  }

  let state = await store.get(verKey(version), JSON_STRONG);
  for (let i = 0; i < PROBE_DEPTH; i++) {
    const next = await store.get(verKey(version + 1), JSON_STRONG);
    if (!next) break;
    version += 1;
    state = next;
  }

  if (!state) {
    const seeded = seedState();
    await createOnly(store, verKey(version), seeded);
    state = (await store.get(verKey(version), JSON_STRONG)) || seeded;
  }

  if (!Array.isArray(state.ledger)) state.ledger = [];
  return { state, version };
}

export async function casState(store, mutate, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    const { state, version } = await readState(store);

    const out = mutate(structuredClone(state));
    if (!out.ok) return out;

    const next = out.state;
    next.version = version + 1;
    next.writer = writerStamp();

    const key = verKey(next.version);
    if (await createOnly(store, key, next)) {
      if (await confirmStored(store, key, (v) => v.writer === next.writer)) {
        await advanceHead(store, next.version);
        return { ok: true, state: next, extra: out.extra };
      }
    }
  }
  return { ok: false, status: 503, error: 'busy' };
}

export async function readNonce(store, tokenId) {
  return (await store.get(nonceKey(tokenId), JSON_STRONG)) || null;
}

export async function writeNonce(store, tokenId, record) {
  await store.setJSON(nonceKey(tokenId), record);
}

export async function readRate(store, tokenId) {
  return (await store.get(rateKey(tokenId), JSON_STRONG)) || null;
}

export async function writeRate(store, tokenId) {
  await store.setJSON(rateKey(tokenId), { at: Date.now() });
}
