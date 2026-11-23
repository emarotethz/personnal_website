import { sineStore, readState } from '../lib/sine-store.mjs';
import { publicState } from '../lib/sine-schema.mjs';
import { json } from '../lib/http.mjs';

const CACHE = {
  'cache-control': 'public, max-age=0, must-revalidate',
  'netlify-cdn-cache-control': 'public, s-maxage=300, durable',
  'netlify-cache-tag': 'sine',
};

export default async () => {
  const { state } = await readState(sineStore());
  return json(publicState(state), { headers: CACHE });
};

export const config = { path: '/api/sine' };
