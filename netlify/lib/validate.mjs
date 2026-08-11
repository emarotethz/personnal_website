

import {
  INSTRUMENTS, PITCHED, SCALE, STEPS,
  VEL_MIN, VEL_MAX, DECAY_MIN, DECAY_MAX, NOTE_ID_RE,
} from './schema.mjs';

const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const OPS = ['add', 'modify', 'remove'];

const bad = (field) => ({ ok: false, field });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, dp) => Number(v.toFixed(dp));

function readPitch(v) {
  if (v === undefined) return 0;
  if (!isNum(v) || !Number.isInteger(v)) return null;
  if (v < 0 || v >= SCALE.midi.length) return null;
  return v;
}

function readVel(v) {
  if (v === undefined) return 0.8;
  if (!isNum(v)) return null;
  return round(clamp(v, VEL_MIN, VEL_MAX), 2);
}

function readDecay(v) {
  if (v === undefined) return 0.3;
  if (!isNum(v)) return null;
  return round(clamp(v, DECAY_MIN, DECAY_MAX), 3);
}

export function validateEdit(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body');

  const { op, nonce } = body;
  if (typeof op !== 'string' || !OPS.includes(op)) return bad('op');
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return bad('nonce');

  if (op === 'add') {
    const { inst, step } = body;
    if (typeof inst !== 'string' || !INSTRUMENTS.includes(inst)) return bad('inst');
    if (!isNum(step) || !Number.isInteger(step) || step < 0 || step >= STEPS) return bad('step');

    const pitch = readPitch(body.pitch);
    if (pitch === null) return bad('pitch');
    const vel = readVel(body.vel);
    if (vel === null) return bad('vel');
    const decay = readDecay(body.decay);
    if (decay === null) return bad('decay');

    return { ok: true, edit: { op, nonce, inst, step, pitch: PITCHED.has(inst) ? pitch : 0, vel, decay } };
  }

  const { id } = body;
  if (typeof id !== 'string' || !NOTE_ID_RE.test(id)) return bad('id');

  if (op === 'remove') return { ok: true, edit: { op, nonce, id } };

  const pitch = readPitch(body.pitch);
  if (pitch === null) return bad('pitch');
  const vel = readVel(body.vel);
  if (vel === null) return bad('vel');
  const decay = readDecay(body.decay);
  if (decay === null) return bad('decay');

  return { ok: true, edit: { op, nonce, id, pitch, vel, decay } };
}

export function validateTempo(body) {
  const { bpm, swing } = body;
  if (!isNum(bpm) || bpm < 50 || bpm > 180) return bad('bpm');
  if (!isNum(swing) || swing < 0 || swing > 0.3) return bad('swing');
  return { ok: true, bpm: Math.round(bpm), swing: round(swing, 3) };
}
