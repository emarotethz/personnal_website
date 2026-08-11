

import { purgeCache } from '@netlify/functions';
import {
  beatStore, readBeat, casBeat, reserveLock, finalizeLock, releaseLock,
  ipDeviceCount, markIpDevice, writeFate,
} from '../lib/store.mjs';
import {
  publicBeat, newNoteId, slotOf, PITCHED, MAX_NOTES, IP_EDIT_CAP, LOCK_MS, LEDGER_MAX,
} from '../lib/schema.mjs';
import { verifyToken, readToken, cookieHeader, ipHash, country } from '../lib/identity.mjs';
import { json, fail, readJsonBody, NO_STORE } from '../lib/http.mjs';
import { validateEdit } from '../lib/validate.mjs';

const isVictim = (note, editorId) => !!note.owner && note.owner !== 'seed' && note.owner !== editorId;

const pushLedger = (beat, entry) => {
  beat.ledger = [entry, ...(beat.ledger || [])].slice(0, LEDGER_MAX);
};

export default async (req, context) => {
  const env = process.env;
  if (req.method !== 'POST') return fail(405, 'method');

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, 'invalid', { field: parsed.why });

  const checked = validateEdit(parsed.body);
  if (!checked.ok) return fail(400, 'invalid', { field: checked.field });
  const edit = checked.edit;

  const token = readToken(req);
  const claim = await verifyToken(token, env);
  if (!claim) return fail(401, 'bad-token');

  const store = beatStore();

  const res = await reserveLock(store, claim.id, edit.nonce);
  if (!res.ok) {
    const { beat } = await readBeat(store);
    if (res.reason === 'replay') {
      return json({
        ok: true, replay: true, state: publicBeat(beat),
        edit: res.lock.placed ?? null, noteId: res.lock.noteId ?? null,
      }, { headers: NO_STORE });
    }
    if (res.reason === 'inflight') return fail(429, 'rate', { version: beat.version });
    return fail(403, 'locked', {
      version: beat.version,
      noteId: res.lock?.noteId ?? null,
      lockedUntil: res.lock?.usedAt ? res.lock.usedAt + LOCK_MS : null,
    });
  }

  const ip = await ipHash(req, env);
  if ((await ipDeviceCount(store, ip.year, ip.hash)) >= IP_EDIT_CAP) {
    await releaseLock(store, claim.id, edit.nonce);
    return fail(403, 'ip-cap', { cap: IP_EDIT_CAP });
  }

  const cc = country(context);
  const now = Date.now();

  const outcome = await casBeat(store, (beat) => {
    if (edit.op === 'add') {
      if (beat.notes.length >= MAX_NOTES) return { ok: false, status: 409, error: 'full', maxNotes: MAX_NOTES };
      const slot = `${edit.inst}:${edit.step}`;
      if (beat.notes.some((n) => slotOf(n) === slot)) return { ok: false, status: 409, error: 'slot-taken' };

      const note = {
        id: newNoteId(),
        inst: edit.inst,
        step: edit.step,
        pitch: PITCHED.has(edit.inst) ? edit.pitch : 0,
        vel: edit.vel,
        decay: edit.decay,
        country: cc,
        at: now,
        owner: claim.id,
      };
      beat.notes.push(note);
      pushLedger(beat, { kind: 'add', inst: note.inst, step: note.step, country: cc, victim: false, at: now });
      return { ok: true, beat, extra: { note, victim: null } };
    }

    const idx = beat.notes.findIndex((n) => n.id === edit.id);
    if (idx === -1) return { ok: false, status: 404, error: 'no-such-note' };
    const before = beat.notes[idx];
    const victim = isVictim(before, claim.id) ? before : null;

    if (edit.op === 'remove') {
      beat.notes.splice(idx, 1);
      pushLedger(beat, { kind: 'remove', inst: before.inst, step: before.step, country: cc, victim: !!victim, at: now });
      return { ok: true, beat, extra: { note: before, victim } };
    }

    const next = {
      ...before,
      pitch: PITCHED.has(before.inst) ? edit.pitch : 0,
      vel: edit.vel,
      decay: edit.decay,
    };
    beat.notes[idx] = next;
    pushLedger(beat, { kind: 'modify', inst: next.inst, step: next.step, country: cc, victim: !!victim, at: now });
    return { ok: true, beat, extra: { note: next, victim } };
  });

  if (!outcome.ok) {
    await releaseLock(store, claim.id, edit.nonce);
    const { beat } = await readBeat(store);
    return fail(outcome.status ?? 409, outcome.error, { version: beat.version, maxNotes: outcome.maxNotes });
  }

  const { beat, extra } = outcome;
  const placed = {
    kind: edit.op,
    inst: extra.note.inst,
    step: extra.note.step,
    pitch: extra.note.pitch,
    country: cc,
    at: now,
  };

  await Promise.all([
    finalizeLock(store, claim.id, {
      nonce: edit.nonce,
      usedAt: now,
      noteId: edit.op === 'remove' ? null : extra.note.id,
      kind: edit.op,
      placed,
    }),
    markIpDevice(store, ip.year, ip.hash, claim.id),
    extra.victim
      ? writeFate(store, extra.victim.owner, {
          kind: edit.op === 'remove' ? 'removed' : 'modified',
          by: cc, at: now, inst: extra.victim.inst, step: extra.victim.step,
        })
      : Promise.resolve(),
  ]);

  try { await purgeCache({ tags: ['beat'] }); } catch {}

  return json({
    ok: true,
    state: publicBeat(beat),
    edit: placed,
    noteId: edit.op === 'remove' ? null : extra.note.id,
  }, { headers: { ...NO_STORE, 'set-cookie': cookieHeader(token, req) } });
};

export const config = { path: '/api/edit', method: 'POST' };
