import { sineStore } from '../lib/sine-store.mjs';
import { verifyToken, readToken, cookieHeader, country } from '../lib/identity.mjs';
import { json, fail, readJsonBody, NO_STORE } from '../lib/http.mjs';
import { validateSineEdit } from '../lib/sine-validate.mjs';
import { commitEdit } from '../lib/sine-ops.mjs';

const MAX_EDIT_BODY = 16384;

export default async (req, context) => {
  const env = process.env;
  if (req.method !== 'POST') return fail(405, 'method');

  const parsed = await readJsonBody(req, MAX_EDIT_BODY);
  if (!parsed.ok) return fail(400, 'invalid', { field: parsed.why });

  const checked = validateSineEdit(parsed.body);
  if (!checked.ok) return fail(400, 'invalid', { field: checked.field });

  const token = readToken(req);
  const claim = await verifyToken(token, env);
  if (!claim) return fail(401, 'bad-token');

  const res = await commitEdit(sineStore(), env, {
    claimId: claim.id, edit: checked.edit, cc: country(context), ip: context?.ip || '', via: 'page',
  });
  if (res.status !== 200) return json(res.body, { status: res.status, headers: NO_STORE });
  return json(res.body, { headers: { ...NO_STORE, 'set-cookie': cookieHeader(token, req) } });
};

export const config = { path: '/api/sine-edit', method: 'POST' };
