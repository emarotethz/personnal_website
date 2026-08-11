

import { beatStore, readBeat, readLock, readFate, ipDeviceCount } from '../lib/store.mjs';
import { publicNote, LOCK_MS, IP_EDIT_CAP } from '../lib/schema.mjs';
import { mintToken, verifyToken, readToken, cookieHeader, ipHash } from '../lib/identity.mjs';
import { json, NO_STORE } from '../lib/http.mjs';

export default async (req, context) => {
  const env = process.env;
  const store = beatStore();

  let token = readToken(req);
  let claim = await verifyToken(token, env);
  if (!claim) {
    token = await mintToken(env);
    claim = await verifyToken(token, env);
  }

  const [{ beat }, lock, fate, ip] = await Promise.all([
    readBeat(store),
    readLock(store, claim.id),
    readFate(store, claim.id),
    ipHash(req, env),
  ]);

  const now = Date.now();
  const spent = lock && !lock.pending && lock.usedAt && now - lock.usedAt < LOCK_MS;

  let locked = false;
  let reason = null;
  if (spent) {
    locked = true;
    reason = 'used';
  } else if ((await ipDeviceCount(store, ip.year, ip.hash)) >= IP_EDIT_CAP) {
    locked = true;
    reason = 'ip-cap';
  }

  const mine = spent && lock.noteId ? beat.notes.find((n) => n.id === lock.noteId) : null;

  return json({
    token,
    version: beat.version,
    locked,
    reason,
    cap: IP_EDIT_CAP,
    noteId: spent ? lock.noteId ?? null : null,
    kind: spent ? lock.kind ?? null : null,
    usedAt: spent ? lock.usedAt : null,
    lockedUntil: spent ? lock.usedAt + LOCK_MS : null,
    placed: spent ? lock.placed ?? null : null,
    note: mine ? publicNote(mine) : null,
    fate: spent ? fate : null,
  }, { headers: { ...NO_STORE, 'set-cookie': cookieHeader(token, req) } });
};

export const config = { path: '/api/me' };
