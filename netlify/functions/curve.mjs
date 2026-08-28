

// Leaderboard for /learning-curve/. The score is how many training steps the
// agent needed before it took three rounds in a row, so higher is better.
//
// One row per player, best score only. Somebody grinding twenty runs gets one
// line on the board, not twenty, and beating your own best replaces it rather
// than adding to it.

import { getStore } from '@netlify/blobs';
import { json, fail, readJsonBody, NO_STORE } from '../lib/http.mjs';

const KEY = 'board/v1';
const MAX_ROWS = 200;
const SHOWN = 10;
const JSON_STRONG = { type: 'json', consistency: 'strong' };

const MAX_GRAD = 4000000;
const MAX_SECONDS = 6 * 3600;
const MIN_SECONDS = 8;
const MAX_ROUNDS = 5000;

function store() {
  return getStore({ name: 'learning-curve', consistency: 'strong' });
}

const ADJ = ['brisk', 'quiet', 'dogged', 'idle', 'sharp', 'patient', 'restless', 'blunt',
  'careful', 'reckless', 'steady', 'sly', 'plain', 'stubborn', 'nimble', 'grim'];
const NOUN = ['pilot', 'gunner', 'drifter', 'skipper', 'runner', 'scout', 'wing', 'tracer',
  'ranger', 'flier', 'hand', 'mark', 'rook', 'ace', 'jockey', 'lark'];

function nameFor(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  h >>>= 0;
  const a = ADJ[h % ADJ.length];
  const n = NOUN[(h >>> 8) % NOUN.length];
  return `${a} ${n} ${((h >>> 16) % 90) + 10}`;
}

function clean(rows) {
  return rows
    .filter((r) => r && typeof r.id === 'string' && Number.isFinite(r.grad))
    .sort((a, b) => b.grad - a.grad)
    .slice(0, MAX_ROWS);
}

function publicRows(rows, meId) {
  return rows.slice(0, SHOWN).map((r, i) => ({
    rank: i + 1,
    name: nameFor(r.id),
    grad: r.grad,
    rounds: r.rounds,
    seconds: r.seconds,
    day: r.day,
    me: r.id === meId || undefined,
  }));
}

export default async (req) => {
  const s = store();

  if (req.method === 'GET') {
    const me = new URL(req.url).searchParams.get('me') || '';
    const rows = clean((await s.get(KEY, JSON_STRONG))?.rows || []);
    return json({ rows: publicRows(rows, me), total: rows.length }, {
      headers: {
        'cache-control': 'public, max-age=0, must-revalidate',
        'netlify-cdn-cache-control': 'public, s-maxage=30, durable',
        'netlify-cache-tag': 'curve-board',
      },
    });
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, parsed.why);
  const b = parsed.body || {};

  const id = typeof b.id === 'string' && /^[0-9a-f-]{8,40}$/.test(b.id) ? b.id : null;
  const grad = Number(b.grad);
  const rounds = Number(b.rounds);
  const seconds = Number(b.seconds);
  if (!id) return fail(400, 'bad-id');
  if (!Number.isFinite(grad) || grad <= 0 || grad > MAX_GRAD) return fail(400, 'bad-score');
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) return fail(400, 'bad-rounds');
  if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) return fail(400, 'bad-duration');
  if (grad > seconds * 3000) return fail(400, "implausible");

  const rows = clean((await s.get(KEY, JSON_STRONG))?.rows || []);
  const day = new Date().toISOString().slice(0, 10);
  const mine = rows.find((r) => r.id === id);
  let improved = true;
  if (mine) {
    if (mine.grad >= grad) improved = false;
    else { mine.grad = grad; mine.rounds = rounds; mine.seconds = seconds; mine.day = day; }
  } else {
    rows.push({ id, grad, rounds, seconds, day });
  }
  const next = clean(rows);
  if (improved) await s.setJSON(KEY, { rows: next });

  return json({
    rows: publicRows(next, id),
    improved,
    rank: next.findIndex((r) => r.id === id) + 1,
    total: next.length,
    name: nameFor(id),
  }, { headers: NO_STORE });
};

export const config = { path: '/api/curve-board' };
