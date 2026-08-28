

// The regression that matters. An earlier version of this agent looked entirely fine
// - loss fell, Q values moved, it dodged well - and never learned to shoot at
// all, because the hit reward was paid to the step where the bullet landed
// instead of the step that fired it. Nothing but an end-to-end competence
// measurement catches that, so this is it.
//
// Slow (~1 min) and therefore kept out of the default `npm test`.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const L = (n) => fileURLToPath(new URL('../../learning-curve/' + n, import.meta.url));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
};

global.self = global;
for (const f of ['curve-core.js', 'curve-net.js', 'curve-worker.js']) {
  new Function(fs.readFileSync(L(f), 'utf8'))();
}
const LC = global.LC, Learner = global.LCLearner;
const { C } = LC;

const FAST = process.env.CURVE_FAST === '1';
const TARGET = FAST ? 4000 : 30000;
const MARKS = FAST ? [0, 2000, 4000] : [0, 4000, 15000, 30000];

function evaluate(learner, seed, steps) {
  const rand = LC.rng(seed);
  const w = new LC.World(), ev = new LC.Ev();
  const ob = new Float32Array(LC.NOBS);
  w.reset(rand);
  let hits = 0, taken = 0, shots = 0, rounds = 0, wins = 0;
  for (let t = 0; t < steps; t++) {
    w.observe(0, ob, 0);
    learner.net.fwd(learner.P, ob, 0);
    const na = LC.nActions(w, 0);
    const a = rand() < 0.02 ? (rand() * na) | 0 : learner.net.argmaxN(na);
    w.advance(a, LC.scripted(w, 1, rand), ev, w.roundT * C.CDT);
    if (ev.fired) shots++;
    if (ev.hitSrc !== -2) hits++;
    if (ev.gotHit) taken++;
    if (ev.done) { rounds++; if (ev.hitSrc !== -2) wins++; w.reset(rand); }
  }
  const mins = steps * C.CDT / 60;
  return { hpm: hits / mins, tpm: taken / mins, acc: shots ? hits / shots : 0, win: rounds ? wins / rounds : 0, rounds };
}

function trainTo(learner, target) {
  while (learner.grad < target) learner.chunk();
}

console.log(`\n[1] learning curve against the scripted opponent (target ${TARGET} gradient steps)`);
console.log('     grad     hits/min  taken/min   acc     winrate   meanQ    loss');

const seeds = FAST ? [7] : [7, 21, 99];
const results = [];

for (const seed of seeds) {
  const learner = new Learner(seed);
  const row = { seed, marks: {} };
  const t0 = Date.now();
  for (const mark of MARKS) {
    trainTo(learner, mark);
    const e = evaluate(learner, 4242, 9000);
    row.marks[mark] = e;
    console.log(`  s${seed} ${String(mark).padStart(6)}  ${e.hpm.toFixed(1).padStart(7)}  ${e.tpm.toFixed(1).padStart(8)}  ` +
      `${(100 * e.acc).toFixed(1).padStart(5)}%  ${(100 * e.win).toFixed(0).padStart(6)}%  ` +
      `${learner.qbar.toFixed(2).padStart(7)}  ${learner.loss.toFixed(4)}`);
  }
  row.secs = (Date.now() - t0) / 1000;
  row.learner = learner;
  results.push(row);
  console.log(`     seed ${seed} took ${row.secs.toFixed(0)}s of single-core CPU`);
}

console.log('\n[2] a fresh policy must be bad, and training must beat it');
const first = MARKS[0], last = MARKS[MARKS.length - 1];
check('an untrained policy is not dangerous', results.every((r) => r.marks[first].hpm < 6), true);
check('an untrained policy loses most rounds', results.every((r) => r.marks[first].win < 0.30), true);
check('training at least triples its hit rate',
  results.every((r) => r.marks[last].hpm > 3 * Math.max(1, r.marks[first].hpm)), true);

// Anchored to the measured curve, and deliberately set high enough to fail if
// the learner loses ground. Over 12 harness seeds the agent reaches 8.22 ± 1.22
// hits/min by 15k gradient steps and 13.48 ± 0.57 by 30k, at 30.7% accuracy;
// the same learner with the mirrored half of each batch turned off reaches only
// 8.79 at 30k, at 21.0%. So 10.0 and 24% sit above what a mirror-less learner
// can do and roughly three standard deviations below what this one does - a
// regression that size gets caught, ordinary seed noise does not trip it.
// Ceiling against this opponent is 19.2. 2 of 3 seeds must clear; all print.
const MID = FAST ? 2000 : 15000, HPM_MID = FAST ? 1.5 : 4.5, HPM_END = FAST ? 3.0 : 10.0;
const midOK = results.filter((r) => r.marks[MID].hpm >= HPM_MID).length;
const endOK = results.filter((r) => r.marks[last].hpm >= HPM_END).length;
const ACC_END = FAST ? 0.10 : 0.24;
const accOK = results.filter((r) => r.marks[last].acc >= ACC_END).length;
const need = seeds.length === 1 ? 1 : 2;
console.log(`     ${midOK}/${seeds.length} seeds cleared ${HPM_MID} hits/min at ${MID}, ${endOK}/${seeds.length} cleared ${HPM_END} at ${last}`);
check(`at least ${need} seeds are shooting by ${MID} steps`, midOK >= need, true);
check(`at least ${need} seeds reach ${HPM_END} hits/min`, endOK >= need, true);
check(`at least ${need} seeds beat ${(100 * ACC_END).toFixed(0)}% accuracy (random is ~1%)`, accOK >= need, true);
check('the agent improves over its own starting point', results.every((r) => r.marks[last].hpm > r.marks[first].hpm), true);

console.log('\n[3] the auxiliary head learns to predict the opponent');
{
  const worst = Math.max.apply(null, results.map((r) => r.learner.auxLoss));
  console.log(`     prediction loss: ${results.map((r) => r.learner.auxLoss.toFixed(4)).join(', ')}`);
  check('the prediction converged', worst < 0.08, true);
  check('and it is a real task, not a constant', results.some((r) => r.learner.auxLoss > 1e-5), true);
}

console.log('\n[3b] it learns the strategy you are actually using');
// Whether that translates into measurably better play inside one session is
// below the noise floor here - the seed-to-seed spread in hits/min is wider
// than the effect - but whether it fits your policy at all is low variance and
// worth pinning down. Two distinct opponents, and the clone has to tell them
// apart.
{
  const styles = {
    still: (LC2, w, r) => LC.encode(0, 0, 0),
    turner: (LC2, w, r) => LC.encode(1, 0, r() < 0.1 ? 1 : 0),
  };
  const fits = {};
  for (const name of Object.keys(styles)) {
    const l = new Learner(11);
    const rand = LC.rng(5);
    const w = new LC.World(), ev = new LC.Ev();
    const ob = new Float32Array(LC.NOBS);
    w.reset(rand);
    for (let i = 0; i < 4000; i++) {
      w.observe(1, ob, 0);
      const act = styles[name](LC, w, rand);
      l.addHuman(ob, 0, act);
      w.advance((rand() * LC.NACT) | 0, act, ev, 0);
      if (ev.done) w.reset(rand);
    }
    const before = l.bcCE;
    for (let k = 0; k < 3000; k++) l.bcStep();
    let agree = 0, n = 0;
    w.reset(rand);
    for (let i = 0; i < 600; i++) {
      w.observe(1, ob, 0);
      const want = styles[name](LC, w, rand);
      l.bc.fwd(l.BP, ob, 0);
      let best = 0;
      for (let a = 1; a < LC.NACT; a++) if (l.bc.A[a] > l.bc.A[best]) best = a;
      if (best === want) agree++;
      n++;
      w.advance((rand() * LC.NACT) | 0, want, ev, 0);
      if (ev.done) w.reset(rand);
    }
    fits[name] = { before, after: l.bcCE, agree: agree / n };
    console.log(`     ${name.padEnd(8)} cross-entropy ${before.toFixed(2)} -> ${l.bcCE.toFixed(3)}, reproduces ${(100 * agree / n).toFixed(0)}% of moves`);
  }
  check('the clone fits a stationary player', fits.still.after < 0.5, true);
  check('and reproduces that player', fits.still.agree > 0.6, true);
  check('the clone fits a different player too', fits.turner.after < 0.5, true);
  check('and reproduces that one', fits.turner.agree > 0.6, true);
  check('fitting is what improved it, not luck',
    fits.still.after < fits.still.before && fits.turner.after < fits.turner.before, true);
}

console.log('\n[4] stability at a high update ratio');
check('no NaN in the weights', results.every((r) => r.learner.P.every((v) => isFinite(v))), true);
check('value estimates stay bounded', results.every((r) => Math.abs(r.learner.qbar) < 25), true);
check('no runaway rollback loop', results.every((r) => r.learner.rollbacks <= 2), true);

console.log('\n[5] a hit is credited to the shot that caused it');
// Deterministic wiring check, not a comparison. Which timing is better is a
// statistical question that four seeds cannot answer - it flip-flopped twice
// here before curve-harness.mjs settled it over 30 seeds (crediting the firing
// step: 11.99 hits/min against 9.61, t = 5.9). Comparisons belong in the
// harness; this file asserts the mechanism is actually connected.
{
  const l = new Learner(5);
  const ring = l.rings[0];
  const obs = new Float32Array(LC.NOBS), rc = new Float32Array(LC.NRC);
  for (let st = 0; st < 20; st++) ring.write(st, obs, 0, 3, -0.05, 0, rc, 0, null, 0, 0);
  const firedAt = 6, landedAt = 19;
  const before = ring.r[firedAt % 64], impactBefore = ring.r[landedAt % 64];
  ring.credit(firedAt, LC.R.HIT);
  check('the firing step receives the reward', ring.r[firedAt % 64] > before + 1, true);
  check('the impact step does not', ring.r[landedAt % 64], impactBefore);
  check('the decomposition follows it', ring.rc[(firedAt % 64) * LC.NRC] > 1, true);
  check('a step older than the ring is dropped', ring.credit(firedAt - 200, LC.R.HIT), false);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
