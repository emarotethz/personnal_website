import { sineStore } from '../lib/sine-store.mjs';
import { verifyToken, readToken } from '../lib/identity.mjs';
import { json, fail, NO_STORE } from '../lib/http.mjs';
import { agentKey, rotateAgentKey } from '../lib/sine-agent.mjs';

// GET: this device's agent address. POST: a new one, which switches the old one off.
export default async (req) => {
  const env = process.env;
  const claim = await verifyToken(readToken(req), env);
  if (!claim) return fail(401, 'bad-token');
  const store = sineStore();
  let key;
  if (req.method === 'GET') key = await agentKey(store, env, claim.id);
  else if (req.method === 'POST') key = await rotateAgentKey(store, env, claim.id);
  else return fail(405, 'method');
  const origin = new URL(req.url).origin;
  return json({ key, url: `${origin}/api/sine-mcp/${key}` }, { headers: NO_STORE });
};

export const config = { path: '/api/sine-key' };
