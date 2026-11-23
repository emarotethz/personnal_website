// Agent keys: a key lets a coding agent act as the device that made it,
// on sine only. It is signed, so it cannot be guessed, and making a new
// one (a new generation) switches the old one off.
import { hmacHex } from './identity.mjs';

const KEY_RE = /^sk_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(\d{1,6})_([0-9a-f]{32})$/;
const genKey = (id) => `sine/agent/${id}`;

function secrets(env) {
  const list = [env.HMAC_SECRET, env.HMAC_SECRET_PREV].filter(Boolean);
  if (!list.length) throw new Error('HMAC_SECRET is not configured');
  return list;
}

async function sign(secret, id, gen) {
  return (await hmacHex(secret, `sine-agent|${id}|${gen}`)).slice(0, 32);
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function generation(store, id) {
  const rec = await store.get(genKey(id), { type: 'json', consistency: 'strong' });
  return rec && Number.isInteger(rec.gen) ? rec.gen : 0;
}

export async function agentKey(store, env, id) {
  const gen = await generation(store, id);
  return `sk_${id}_${gen}_${await sign(secrets(env)[0], id, gen)}`;
}

export async function rotateAgentKey(store, env, id) {
  const gen = (await generation(store, id)) + 1;
  await store.setJSON(genKey(id), { gen, at: Date.now() });
  return `sk_${id}_${gen}_${await sign(secrets(env)[0], id, gen)}`;
}

export async function verifyAgentKey(store, env, key) {
  if (typeof key !== 'string' || key.length > 120) return null;
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const [, id, genStr, sig] = m;
  const gen = Number(genStr);
  let good = false;
  for (const s of secrets(env)) if (same(await sign(s, id, gen), sig)) good = true;
  if (!good) return null;
  if ((await generation(store, id)) !== gen) return null;
  return { id };
}
