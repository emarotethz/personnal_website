

// Leaderboard endpoint. Needs a running server (npm run dev), same as
// api.test.mjs, so it is not part of the default `npm test`.
//
// The property that matters: one row per player. Somebody replaying twenty
// times should occupy one line, and their best one, not twenty.

const BASE = process.env.CURVE_TEST_BASE || 'http://localhost:8888';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
};

const uid = () => crypto.randomUUID();
const post = async (body) => {
  const r = await fetch(`${BASE}/api/curve-board`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const get = async (me) => (await fetch(`${BASE}/api/curve-board?me=${encodeURIComponent(me || '')}`, { cache: 'no-store' })).json();

try {
  await fetch(`${BASE}/api/curve-board`);
} catch {
  console.error(`\nNo server at ${BASE}. Start one with: npm run dev\n`);
  process.exit(2);
}

console.log('\n[1] a run lands on the board under a generated name');
const a = uid();
{
  const r = await post({ id: a, grad: 12000, rounds: 9, seconds: 200 });
  check('accepted', r.status, 200);
  check('counted as an improvement', r.body.improved, true);
  const mine = r.body.rows.find((x) => x.me);
  check('appears on the board', !!mine, true);
  check('under a generated name, not an id', mine.name !== a && /^[a-z]+ [a-z]+ \d+$/.test(mine.name), true);
  check('and the id itself is never published', JSON.stringify(r.body).includes(a), false);
}

console.log('\n[2] replaying does not stack the board');
{
  const before = (await get(a)).total;
  const worse = await post({ id: a, grad: 5000, rounds: 4, seconds: 120 });
  check('a worse run is not an improvement', worse.body.improved, false);
  check('and the better score is kept', worse.body.rows.find((x) => x.me).grad, 12000);

  const better = await post({ id: a, grad: 20000, rounds: 14, seconds: 300 });
  check('a better run replaces it', better.body.improved, true);
  check('with the new score', better.body.rows.find((x) => x.me).grad, 20000);

  for (let i = 0; i < 5; i++) await post({ id: a, grad: 1000 + i, rounds: 2, seconds: 60 });
  const after = await get(a);
  check('five more runs added no extra rows', after.total, before);
  check('and there is exactly one row for this player',
    after.rows.filter((x) => x.name === better.body.name).length, 1);
}

console.log('\n[3] the same player always gets the same name');
{
  const r = await post({ id: a, grad: 20001, rounds: 14, seconds: 300 });
  const again = await post({ id: a, grad: 20002, rounds: 14, seconds: 300 });
  check('name is stable across submissions', r.body.name, again.body.name);
  const other = await post({ id: uid(), grad: 9000, rounds: 7, seconds: 180 });
  check('a different player gets a different name', other.body.name !== r.body.name, true);
}

console.log('\n[4] the client is not trusted');
{
  check('a malformed id is rejected', (await post({ id: 'nope!', grad: 100, rounds: 1, seconds: 100 })).status, 400);
  check('a zero score is rejected', (await post({ id: uid(), grad: 0, rounds: 1, seconds: 100 })).status, 400);
  check('an absurd score is rejected', (await post({ id: uid(), grad: 1e9, rounds: 1, seconds: 100 })).status, 400);
  check('a run that is too short to be real is rejected',
    (await post({ id: uid(), grad: 5000, rounds: 3, seconds: 2 })).status, 400);
  check('a score that outruns the training rate is rejected',
    (await post({ id: uid(), grad: 500000, rounds: 3, seconds: 30 })).status, 400);
  check('sane runs still get through',
    (await post({ id: uid(), grad: 7000, rounds: 5, seconds: 140 })).status, 200);
}

console.log('\n[5] the board reads back sorted and capped');
{
  const d = await get('');
  const grads = d.rows.map((r) => r.grad);
  check('sorted best first', grads.slice().sort((x, y) => y - x), grads);
  check('ranks are 1..n in order', d.rows.map((r) => r.rank), d.rows.map((_, i) => i + 1));
  check('no more than ten shown', d.rows.length <= 10, true);
  check('nobody is flagged as me without an id', d.rows.some((r) => r.me), false);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}  (${BASE})`);
process.exit(failures === 0 ? 0 : 1);
