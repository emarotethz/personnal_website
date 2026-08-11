

import {
  check, section, finish, nonce, newDevice, me, edit, getBeat, freeSlots, reseed, IS_LOCAL,
} from './helpers.mjs';

const N = 8;

if (IS_LOCAL) await reseed();
let free = await freeSlots();
let fi = 0;
const slot = () => free[fi++ % free.length];

section('[1] validation rejects rather than coerces');
const v = await newDevice();
const bad = [
  ['instrument not in the allowlist', { op: 'add', inst: 'cowbell', step: 1 }, 'inst'],
  ['step out of range', { op: 'add', inst: 'kick', step: 99 }, 'step'],
  ['negative step', { op: 'add', inst: 'kick', step: -1 }, 'step'],
  ['pitch escaping the scale', { op: 'add', inst: 'pluck', step: 1, pitch: 47 }, 'pitch'],
  ['numeric string not coerced', { op: 'add', inst: 'kick', step: 1, vel: '0.9' }, 'vel'],
  ['step as a string', { op: 'add', inst: 'kick', step: '1' }, 'step'],
  ['fractional step', { op: 'add', inst: 'kick', step: 1.5 }, 'step'],
  ['unknown op', { op: 'drop', inst: 'kick', step: 1 }, 'op'],
  ['malformed note id', { op: 'remove', id: 'bogus' }, 'id'],
  ['Infinity as pitch', { op: 'add', inst: 'tom', step: 1, pitch: 1e999 }, 'pitch'],
];
for (const [label, body, field] of bad) {
  const r = await edit(v, { ...body, nonce: nonce('bad', field) });
  check(label, [r.status, r.body.field], [400, field]);
}
const noNonce = await edit(v, { op: 'add', inst: 'kick', step: 1 });
check('missing nonce', [noNonce.status, noNonce.body.field], [400, 'nonce']);
const forged = await edit({ ip: v.ip, token: 'v1.11111111-2222-3333-4444-555555555555.20000.AAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  { op: 'add', inst: 'kick', step: 1, nonce: nonce('forge', 0) }, { viaHeader: true });
check('forged token is rejected', [forged.status, forged.body.error], [401, 'bad-token']);
check('none of that spent the edit', (await me(v)).locked, false);

section('[2] one device, one edit, ever');
const d = await newDevice();
const s1 = slot();
const first = await edit(d, { op: 'add', ...s1, vel: 0.7, decay: 0.2, nonce: nonce('first', 1) });
check('the first edit commits', first.status, 200);
const second = await edit(d, { op: 'add', ...slot(), vel: 0.7, decay: 0.2, nonce: nonce('second', 2) });
check('a second edit is refused', [second.status, second.body.error], [403, 'locked']);
check('locked via the cookie', (await me(d)).locked, true);
check('locked via the header token alone', (await me({ ip: d.ip, token: d.token })).locked, true);

section('[3] resending the same nonce replays, it does not double-commit');
const d2 = await newDevice();
const nn = nonce('idem', 3);
const body = { op: 'add', ...slot(), vel: 0.7, decay: 0.2, nonce: nn };
const a = await edit(d2, body);
const b = await edit(d2, body);
check('first attempt commits', a.status, 200);
check('identical resend replays instead of 403', [b.status, b.body.replay], [200, true]);
check('both name the same note', a.body.noteId, b.body.noteId);
const beatNow = await getBeat();
check('only one note exists in that slot',
  beatNow.notes.filter((n) => n.inst === body.inst && n.step === body.step).length, 1);

section(`[4] ${N} devices race for the same empty slot`);
free = await freeSlots(); fi = 0;
const target = slot();
let devices = await Promise.all(Array.from({ length: N }, () => newDevice()));
let v0 = (await getBeat()).version;
let res = await Promise.all(devices.map((dev, i) =>
  edit(dev, { op: 'add', ...target, vel: 0.8, decay: 0.3, nonce: nonce('race', i) })));

check('exactly one winner', res.filter((r) => r.status === 200).length, 1);
check('everyone else gets slot-taken', res.filter((r) => r.status === 409 && r.body.error === 'slot-taken').length, N - 1);
check('version advanced by exactly 1', (await getBeat()).version - v0, 1);
let locks = await Promise.all(devices.map(me));
check('exactly one device spent its edit', locks.filter((m) => m.locked).length, 1);
check('the winner is the one who is locked', locks[res.findIndex((r) => r.status === 200)].locked, true);
check('one note landed in the slot',
  (await getBeat()).notes.filter((n) => n.inst === target.inst && n.step === target.step).length, 1);

section(`[5] ${N} devices race to delete the same note`);
const victim = (await getBeat()).notes.find((n) => n.inst === target.inst && n.step === target.step);
devices = await Promise.all(Array.from({ length: N }, () => newDevice()));
v0 = (await getBeat()).version;
res = await Promise.all(devices.map((dev, i) => edit(dev, { op: 'remove', id: victim.id, nonce: nonce('del', i) })));

check('exactly one winner', res.filter((r) => r.status === 200).length, 1);
check('everyone else gets no-such-note', res.filter((r) => r.status === 404 && r.body.error === 'no-such-note').length, N - 1);
check('version advanced by exactly 1', (await getBeat()).version - v0, 1);
locks = await Promise.all(devices.map(me));
check('THE LOSERS ALL KEPT THEIR EDIT', locks.filter((m) => m.locked).length, 1);

section('[6] losing a race is never charged to the visitor');
const d3 = await newDevice();
const occupied = (await getBeat()).notes[0];
const clash = await edit(d3, { op: 'add', inst: occupied.inst, step: occupied.step, vel: 0.5, decay: 0.2, nonce: nonce('clash', 6) });
check('adding onto an occupied slot is refused', [clash.status, clash.body.error], [409, 'slot-taken']);
check('and the edit is still theirs', (await me(d3)).locked, false);
const gone = await edit(d3, { op: 'remove', id: 'n_deadbeef', nonce: nonce('gone', 7) });
check('deleting a note that does not exist is refused', [gone.status, gone.body.error], [404, 'no-such-note']);
check('and the edit is STILL theirs', (await me(d3)).locked, false);

finish();
