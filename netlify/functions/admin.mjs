

import { purgeCache } from '@netlify/functions';
import { beatStore, readBeat, casBeat, readVersion, clearLock } from '../lib/store.mjs';
import { publicBeat, seedBeat, MAX_NOTES, NOTE_ID_RE } from '../lib/schema.mjs';
import { isAdmin } from '../lib/identity.mjs';
import { json, fail, readJsonBody, NO_STORE } from '../lib/http.mjs';
import { validateTempo } from '../lib/validate.mjs';

export default async (req) => {
  const env = process.env;
  if (req.method !== 'POST') return fail(405, 'method');
  if (!(await isAdmin(req, env))) return fail(401, 'unauthorized');

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, 'invalid', { field: parsed.why });

  const store = beatStore();
  const { action } = parsed.body;

  if (action === 'stats') {
    const [{ beat }, locks] = await Promise.all([readBeat(store), store.list({ prefix: 'lock/' })]);
    const byInst = {};
    for (const n of beat.notes) byInst[n.inst] = (byInst[n.inst] || 0) + 1;
    return json({
      version: beat.version, bpm: beat.bpm, swing: beat.swing,
      notes: beat.notes.length, maxNotes: MAX_NOTES, byInst,
      locks: locks.blobs.length, ledger: (beat.ledger || []).length,
    }, { headers: NO_STORE });
  }

  if (action === 'unlock') {
    const { tokenId } = parsed.body;
    if (typeof tokenId !== 'string' || !/^[0-9a-f-]{36}$/.test(tokenId)) return fail(400, 'invalid', { field: 'tokenId' });
    await clearLock(store, tokenId);
    return json({ ok: true, unlocked: tokenId }, { headers: NO_STORE });
  }

  let outcome;

  if (action === 'revert') {
    const { version } = parsed.body;
    if (!Number.isInteger(version)) return fail(400, 'invalid', { field: 'version' });
    const snap = await readVersion(store, version);
    if (!snap) return fail(404, 'no-such-version');

    outcome = await casBeat(store, (beat) => ({ ok: true, beat: { ...beat, notes: snap.notes } }));
  } else if (action === 'reseed') {
    const fresh = seedBeat();
    const keepLedger = parsed.body.keepLedger !== false;
    outcome = await casBeat(store, (beat) => ({
      ok: true,
      beat: {
        ...beat, notes: fresh.notes, bpm: fresh.bpm, swing: fresh.swing,
        ledger: keepLedger ? beat.ledger : [],
      },
    }));
  } else if (action === 'deleteNote') {
    const { id } = parsed.body;
    if (typeof id !== 'string' || !NOTE_ID_RE.test(id)) return fail(400, 'invalid', { field: 'id' });
    outcome = await casBeat(store, (beat) => {
      const idx = beat.notes.findIndex((n) => n.id === id);
      if (idx === -1) return { ok: false, status: 404, error: 'no-such-note' };
      beat.notes.splice(idx, 1);
      return { ok: true, beat };
    });
  } else if (action === 'setTempo') {
    const t = validateTempo(parsed.body);
    if (!t.ok) return fail(400, 'invalid', { field: t.field });
    outcome = await casBeat(store, (beat) => ({ ok: true, beat: { ...beat, bpm: t.bpm, swing: t.swing } }));
  } else {
    return fail(400, 'invalid', { field: 'action' });
  }

  if (!outcome.ok) return fail(outcome.status ?? 409, outcome.error);

  try { await purgeCache({ tags: ['beat'] }); } catch {}

  return json({ ok: true, state: publicBeat(outcome.beat) }, { headers: NO_STORE });
};

export const config = { path: '/api/admin', method: 'POST' };
