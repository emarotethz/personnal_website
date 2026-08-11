

export const NO_STORE = { 'cache-control': 'private, no-store' };

export function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function fail(status, error, extra = {}) {
  return json({ error, ...extra }, { status, headers: NO_STORE });
}

const MAX_BODY = 512;

export async function readJsonBody(req) {
  const len = Number(req.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BODY) return { ok: false, why: 'too-large' };
  let text;
  try { text = await req.text(); } catch { return { ok: false, why: 'unreadable' }; }
  if (text.length > MAX_BODY) return { ok: false, why: 'too-large' };
  try { return { ok: true, body: JSON.parse(text) }; } catch { return { ok: false, why: 'malformed' }; }
}
