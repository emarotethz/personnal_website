

import { beatStore, readBeat } from '../lib/store.mjs';
import { json } from '../lib/http.mjs';

const CACHE = {
  'cache-control': 'public, max-age=0, must-revalidate',
  'netlify-cdn-cache-control': 'public, s-maxage=300, durable',
  'netlify-cache-tag': 'beat',
};

export default async (req) => {
  const raw = Number(new URL(req.url).searchParams.get('limit'));
  const limit = Number.isInteger(raw) && raw >= 1 && raw <= 100 ? raw : 30;
  const { beat } = await readBeat(beatStore());
  return json({ version: beat.version, edits: (beat.ledger || []).slice(0, limit) }, { headers: CACHE });
};

export const config = { path: '/api/ledger' };
