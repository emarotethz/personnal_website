import { sineStore, readState } from '../lib/sine-store.mjs';
import { mintToken, verifyToken, readToken, cookieHeader } from '../lib/identity.mjs';
import { json, NO_STORE } from '../lib/http.mjs';

export default async (req) => {
  const env = process.env;
  const store = sineStore();

  let token = readToken(req);
  let claim = await verifyToken(token, env);
  if (!claim) {
    token = await mintToken(env);
    claim = await verifyToken(token, env);
  }

  const { state } = await readState(store);
  const mine = state.blocks.filter((b) => b.owner === claim.id).map((b) => b.id);

  return json(
    { token, version: state.version, blocks: mine },
    { headers: { ...NO_STORE, 'set-cookie': cookieHeader(token, req) } },
  );
};

export const config = { path: '/api/sine-me' };
