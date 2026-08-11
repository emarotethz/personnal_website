

import { beatStore, readBeat } from '../lib/store.mjs';
import { publicBeat } from '../lib/schema.mjs';
import { json } from '../lib/http.mjs';

const CACHE = {
  'cache-control': 'public, max-age=0, must-revalidate',
  'netlify-cdn-cache-control': 'public, s-maxage=300, durable',
  'netlify-cache-tag': 'beat',
};

export default async () => {
  const { beat } = await readBeat(beatStore());
  return json(publicBeat(beat), { headers: CACHE });
};

export const config = { path: '/api/beat' };
