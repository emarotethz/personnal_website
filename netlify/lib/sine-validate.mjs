import {
  BEATS_ALLOWED, BLOCK_ID_RE, CODE_MAX, NAME_MAX, AUTHOR_MAX, GROUP_MAX, COORD_MAX, ABOUT_MAX, isColor,
} from './sine-schema.mjs';

const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const OPS = ['fork', 'update', 'delete', 'describe', 'move'];
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

const bad = (field) => ({ ok: false, field });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function readLabel(v, max, fallback) {
  if (v === undefined) return fallback;
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s || s.length > max || CONTROL_RE.test(s)) return null;
  return s;
}

function readCode(v, fallback) {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || v.length > CODE_MAX) return null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return null;
  return v;
}

function readBeats(v, fallback) {
  if (v === undefined) return fallback;
  if (!isNum(v) || !Number.isInteger(v) || !BEATS_ALLOWED.includes(v)) return null;
  return v;
}

function readGroup(v, fallback) {
  if (v === undefined) return fallback;
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length > GROUP_MAX || CONTROL_RE.test(s)) return null;
  return s;
}

function readColor(v, fallback) {
  if (v === undefined) return fallback;
  if (typeof v !== 'string') return null;
  const c = v.trim().toLowerCase();
  return isColor(c) ? c : null;
}

function readCoord(v) {
  if (!isNum(v) || !Number.isInteger(v) || Math.abs(v) > COORD_MAX) return null;
  return v;
}

export function validateSineEdit(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body');

  const { op, nonce } = body;
  if (typeof op !== 'string' || !OPS.includes(op)) return bad('op');
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return bad('nonce');

  if (op === 'fork') {
    const { parent } = body;
    if (typeof parent !== 'string' || !BLOCK_ID_RE.test(parent)) return bad('parent');

    const name = readLabel(body.name, NAME_MAX, 'untitled');
    if (name === null) return bad('name');
    const author = readLabel(body.author, AUTHOR_MAX, 'anonymous');
    if (author === null) return bad('author');
    const code = readCode(body.code, undefined);
    if (code === null) return bad('code');
    const beats = readBeats(body.beats, undefined);
    if (beats === null) return bad('beats');
    const group = readGroup(body.group, undefined);
    if (group === null) return bad('group');
    const color = readColor(body.color, undefined);
    if (color === null) return bad('color');

    let col, row;
    if (body.col !== undefined || body.row !== undefined) {
      col = readCoord(body.col);
      row = readCoord(body.row);
      if (col === null || row === null) return bad('cell');
    }
    return { ok: true, edit: { op, nonce, parent, name, author, code, beats, group, color, col, row } };
  }

  if (op === 'describe') {
    const group = readGroup(body.group, undefined);
    if (!group) return bad('group');
    if (typeof body.about !== 'string') return bad('about');
    const about = body.about.replace(/\s+/g, ' ').trim();
    if (about.length > ABOUT_MAX || CONTROL_RE.test(about)) return bad('about');
    return { ok: true, edit: { op, nonce, group, about } };
  }

  // a whole box, shifted by whole cells
  if (op === 'move') {
    const group = readGroup(body.group, undefined);
    if (!group) return bad('group');
    const shift = (v) => (isNum(v) && Number.isInteger(v) && Math.abs(v) <= 2 * COORD_MAX ? v : null);
    const dc = shift(body.dc), dr = shift(body.dr);
    if (dc === null || dr === null) return bad('shift');
    return { ok: true, edit: { op, nonce, group, dc, dr } };
  }

  const { id } = body;
  if (typeof id !== 'string' || !BLOCK_ID_RE.test(id)) return bad('id');

  if (op === 'delete') return { ok: true, edit: { op, nonce, id } };

  const edit = { op, nonce, id };
  let touched = false;

  if (body.name !== undefined) {
    const name = readLabel(body.name, NAME_MAX, undefined);
    if (name == null) return bad('name');
    edit.name = name; touched = true;
  }
  if (body.author !== undefined) {
    const author = readLabel(body.author, AUTHOR_MAX, undefined);
    if (author == null) return bad('author');
    edit.author = author; touched = true;
  }
  if (body.code !== undefined) {
    const code = readCode(body.code, undefined);
    if (code == null) return bad('code');
    edit.code = code; touched = true;
  }
  if (body.beats !== undefined) {
    const beats = readBeats(body.beats, undefined);
    if (beats == null) return bad('beats');
    edit.beats = beats; touched = true;
  }
  if (body.group !== undefined) {
    const group = readGroup(body.group, undefined);
    if (group == null) return bad('group');
    edit.group = group; touched = true;
  }
  if (body.color !== undefined) {
    const color = readColor(body.color, undefined);
    if (color == null) return bad('color');
    edit.color = color; touched = true;
  }
  if (body.col !== undefined || body.row !== undefined) {
    const col = readCoord(body.col);
    const row = readCoord(body.row);
    if (col === null || row === null) return bad('cell');
    edit.col = col; edit.row = row; touched = true;
  }

  if (!touched) return bad('empty');
  return { ok: true, edit };
}
