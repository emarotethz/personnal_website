

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CORE_JS = fileURLToPath(new URL('../../learning-curve/curve-core.js', import.meta.url));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

global.self = global;
new Function(fs.readFileSync(CORE_JS, 'utf8'))();
const LC = global.LC;
const { C, R, NOBS, NRC } = LC;

let seed = 2024;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

console.log('\n[1] torus distance');
{
  let ok = true, half = true;
  for (let i = 0; i < 300; i++) {
    const L = i % 2 ? C.W : C.H;
    const a = rand() * L, b = rand() * L;
    const d = LC.dwrap(b - a, L);
    if (Math.abs(d) > L / 2 + 1e-9) half = false;
    if (!near(((a + d) % L + L) % L, b % L, 1e-6)) ok = false;
  }
  check('|dwrap| never exceeds half the axis', half, true);
  check('a + dwrap(b-a) lands on b', ok, true);
  check('exactly half wraps to -L/2 or +L/2', Math.abs(LC.dwrap(C.W / 2, C.W)), C.W / 2);
}

console.log('\n[2] the intercept solver');
{
  let worst = 0, solved = 0;
  for (let i = 0; i < 500; i++) {
    const t = 0.05 + rand() * 0.6;
    const ang = rand() * Math.PI * 2;
    const aim = [Math.cos(ang) * C.BSPD * t, Math.sin(ang) * C.BSPD * t];
    const v = [(rand() * 2 - 1) * 200, (rand() * 2 - 1) * 200];
    const p = [aim[0] - v[0] * t, aim[1] - v[1] * t];
    const got = LC.intercept(p[0], p[1], v[0], v[1], C.BSPD);
    if (got > 0) { solved++; worst = Math.max(worst, Math.abs(got - t)); }
  }
  check('every constructed intercept was found', solved, 500);
  check('and recovered t* to 1e-4', worst < 1e-4, true);
  check('a target fleeing faster than the bullet is uncatchable',
    LC.intercept(100, 0, C.BSPD * 1.5, 0, C.BSPD), -1);
}

console.log('\n[3] the observation is a mirror of itself');
{
  const w = new LC.World(), o1 = new Float32Array(NOBS), o2 = new Float32Array(NOBS);
  const FLIP = LC.OBS_FLIP;
  const SAME = [];
  for (let i = 0; i < NOBS; i++) if (FLIP.indexOf(i) < 0) SAME.push(i);
  let badSame = 0, badFlip = 0, tested = 0, badMirror = 0;
  const om = new Float32Array(NOBS);
  for (let trial = 0; trial < 120; trial++) {
    w.reset(rand);
    for (const s of [w.a, w.b]) {
      s.vx = (rand() * 2 - 1) * 300; s.vy = (rand() * 2 - 1) * 300;
      s.cd = rand() * C.BCD; s.inv = 0;
    }
    w.pb.clear();
    for (let k = 0; k < 3; k++) {
      w.pb.add(rand() * C.W, rand() * C.H, (rand() * 2 - 1) * 700, (rand() * 2 - 1) * 700, -1);
    }
    w.observe(0, o1, 0);

    const mirrorY = (y) => (C.H - y) % C.H;
    for (const s of [w.a, w.b]) { s.y = mirrorY(s.y); s.vy = -s.vy; s.a = -s.a; }
    for (let i = 0; i < w.pb.n; i++) { w.pb.y[i] = mirrorY(w.pb.y[i]); w.pb.vy[i] = -w.pb.vy[i]; }
    for (const R of w.rocks) { R.y = mirrorY(R.y); R.vy = -R.vy; }
    w.observe(0, o2, 0);

    tested++;
    for (const i of SAME) if (!near(o1[i], o2[i], 2e-6)) badSame++;
    for (const i of FLIP) if (!near(o1[i], -o2[i], 2e-6)) badFlip++;

    LC.mirrorObs(o1, 0, om);
    for (let i = 0; i < NOBS; i++) if (!near(om[i], o2[i], 2e-6)) badMirror++;
  }
  check('ran the reflection on many random worlds', tested, 120);
  check('the layout declares some dims as mirrored', FLIP.length > 4, true);
  check('longitudinal and magnitude dims are unchanged', badSame, 0);
  check('lateral and sine dims all flip sign', badFlip, 0);
  check('mirrorObs reproduces the reflected world exactly', badMirror, 0);

  let badAct = 0;
  for (const turn of LC.TURNS) {
    for (const thrust of [0, 1]) {
      for (const fire of [0, 1]) {
        if (LC.mirrorAct(LC.encode(turn, thrust, fire)) !== LC.encode(-turn, thrust, fire)) badAct++;
      }
    }
  }
  check('mirrorAct swaps the turn and leaves thrust and fire alone', badAct, 0);
}

console.log('\n[4] the observation stays in range');
{
  const w = new LC.World(), o = new Float32Array(NOBS);
  let out = 0, bad = 0, n = 0;
  const peak = new Float64Array(NOBS), offenders = [];
  let peakThreat = 0;
  const ev = new LC.Ev();
  for (let trial = 0; trial < 60; trial++) {
    w.reset(rand);
    for (let t = 0; t < 300; t++) {
      w.observe(0, o, 0);
      if (w.threat[0] > peakThreat) peakThreat = w.threat[0];
      for (let i = 0; i < NOBS; i++) {
        n++;
        if (!isFinite(o[i])) bad++;
        else {
          if (Math.abs(o[i]) > peak[i]) peak[i] = Math.abs(o[i]);
          if (o[i] < -1.05 || o[i] > 1.05) out++;
        }
      }
      w.advance(LC.scripted(w, 0, rand), LC.scripted(w, 1, rand), ev, t * C.CDT);
      if (ev.done) w.reset(rand);
    }
  }
  for (let i = 0; i < NOBS; i++) if (peak[i] > 1.05) offenders.push(i + ':' + peak[i].toFixed(3));
  if (offenders.length) console.log('     out-of-range dims -> ' + offenders.join(', '));
  check('sampled a lot of observations', n > 400000, true);
  check('no NaN or Infinity anywhere', bad, 0);
  check('every dim inside [-1.05, 1.05]', out, 0);
  check('the threat features were actually exercised', peakThreat > 0.2, true);
}

console.log('\n[5] bullets cannot tunnel through a ship');
{
  let missed = 0, tried = 0;
  for (let i = 0; i < 400; i++) {
    const w = new LC.World();
    w.a.x = 500; w.a.y = 350; w.a.vx = 0; w.a.vy = 0; w.a.inv = 0;
    const ang = rand() * Math.PI * 2;
    const d = C.SR + C.BR + 1 + rand() * 30;
    w.pb.clear();
    w.pb.add(500 - Math.cos(ang) * d, 350 - Math.sin(ang) * d,
      Math.cos(ang) * C.BSPD, Math.sin(ang) * C.BSPD, -1);
    tried++;
    let hit = false;
    for (let t = 0; t < 6 && !hit; t++) {
      LC.stepPool(w.pb, C.DT);
      if (LC.hitScan(w.pb, w.a, C.DT) !== -2) hit = true;
    }
    if (!hit) missed++;
  }
  check('every dead-on shot registers', [tried, missed], [400, 0]);
  {
    const w = new LC.World();
    w.a.x = 500; w.a.y = 350; w.a.inv = 0;
    w.pb.clear();
    w.pb.add(400, 350 + C.SR + C.BR + 40, C.BSPD, 0, -1);
    let hit = false;
    for (let t = 0; t < 12; t++) { LC.stepPool(w.pb, C.DT); if (LC.hitScan(w.pb, w.a, C.DT) !== -2) hit = true; }
    check('a clean miss stays a miss', hit, false);
  }
  {
    const w = new LC.World();
    w.a.x = 500; w.a.y = 350; w.a.inv = C.INV;
    w.pb.clear();
    w.pb.add(500 - 20, 350, C.BSPD, 0, -1);
    let hit = false;
    for (let t = 0; t < 6; t++) { LC.stepPool(w.pb, C.DT); if (LC.hitScan(w.pb, w.a, C.DT) !== -2) hit = true; }
    check('spawn invulnerability actually protects', hit, false);
  }
}

console.log('\n[5b] rocks shove, they do not kill');
{
  const w = new LC.World();
  w.reset(rand);
  const R = w.rocks[0];
  w.a.x = R.x + 4; w.a.y = R.y; w.a.vx = -200; w.a.vy = 0; w.a.inv = 0;
  const ev = new LC.Ev();
  w.beginStep(4, 4, ev);
  for (let i = 0; i < C.REPEAT; i++) w.tickOnce(ev);
  w.endStep(ev, 0);
  const d = Math.hypot(LC.dwrap(w.a.x - R.x, C.W), LC.dwrap(w.a.y - R.y, C.H));
  check('the ship is pushed clear of the rock', d >= R.r + C.SR - 1e-3, true);
  check('being shoved costs no life', [ev.gotHit, ev.hitSrc], [0, -2]);
  check('and the ship is moving outward afterwards',
    (w.a.vx * LC.dwrap(w.a.x - R.x, C.W) + w.a.vy * LC.dwrap(w.a.y - R.y, C.H)) > 0, true);
}
{
  const w = new LC.World();
  w.reset(rand);
  const R = w.rocks[0];
  w.pa.clear();
  w.pa.add(R.x - R.r - 10, R.y, C.BSPD, 0, 0);
  let gone = false;
  for (let i = 0; i < 6 && !gone; i++) { LC.stepPool(w.pa, C.DT); w.chip(w.pa); if (w.pa.n === 0) gone = true; }
  check('a rock absorbs a bullet', gone, true);
}
{
  const w = new LC.World();
  w.reset(rand);
  const o = new Float32Array(NOBS);
  const R = w.rocks[0];
  w.a.x = (R.x - 200 + C.W) % C.W; w.a.y = R.y; w.a.vx = 0; w.a.vy = 0; w.a.a = 0;
  w.b.x = (R.x + 200) % C.W; w.b.y = R.y; w.b.vx = 0; w.b.vy = 0;
  w.observe(0, o, 0);
  check('a rock on the firing line raises the blocked flag', w.blocked, 1);
  w.b.y = (R.y + R.r + C.SR * 8) % C.H;
  w.a.y = w.b.y;
  w.observe(0, o, 0);
  check('and a clear line does not', w.blocked, 0);
}
console.log('\n[6] reward bookkeeping');
{
  const w = new LC.World(), ev = new LC.Ev();
  w.reset(rand);
  let mismatch = 0, hits = 0, creditedAtImpact = 0;
  for (let t = 0; t < 20000; t++) {
    w.advance(LC.scripted(w, 0, rand), LC.scripted(w, 1, rand), ev, t * C.CDT);
    let s = 0;
    for (let i = 0; i < NRC; i++) s += ev.rc[i];
    if (!near(s, ev.r, 1e-6)) mismatch++;
    if (ev.hitSrc !== -2) { hits++; if (ev.rc[0] !== 0) creditedAtImpact++; }
    if (ev.done) w.reset(rand);
  }
  check('components always sum to the scalar reward', mismatch, 0);
  check('the run actually contained hits', hits > 20, true);
  check('the reward for a hit is left to the caller', creditedAtImpact, 0);
  check('and the firing step is reported so it can choose',
    /^-?\d+$/.test(String(ev.hitSrc)), true);
}

console.log('\n[7] potential-based shaping telescopes');
// sum_t gamma^t (gamma*PHI(s_{t+1}) - PHI(s_t)) === gamma^T PHI(s_T) - PHI(s_0).
// If this holds the shaping provably cannot change the optimal policy.
//
// R.POT ships at 0: the raw per-step form measured ~30% faster to learn and
// speed is the binding requirement. The policy-invariant path is kept working
// and tested here so the trade stays a choice rather than a one-way door.
{
  const potWas = R.POT;
  R.POT = 1;
  const w = new LC.World(), ev = new LC.Ev();
  let worst = 0, episodes = 0;
  for (let e = 0; e < 40; e++) {
    w.reset(rand);
    const phi0 = w.potential(0);
    let acc = 0, g = 1, T = 0;
    for (let t = 0; t < 400; t++) {
      w.advance((rand() * 12) | 0, (rand() * 12) | 0, ev, 0);
      acc += g * (ev.rc[5] + ev.rc[6]);
      g *= R.GAMMA; T++;
      if (ev.done) break;
    }
    const want = g * w.potential(0) - phi0;
    worst = Math.max(worst, Math.abs(acc - want));
    episodes++;
  }
  check('checked a batch of episodes', episodes, 40);
  check('telescoping identity holds to 1e-5', worst < 1e-5, true);
  R.POT = potWas;
  check('but the shipped default is the raw per-step form', R.POT, 0);
}

console.log('\n[8] the simulation is deterministic');
{
  const run = () => {
    const w = new LC.World(), ev = new LC.Ev();
    let s = 7; const r = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    w.reset(r);
    let acc = 0;
    for (let t = 0; t < 5000; t++) {
      const a = LC.scripted(w, 0, r), b = LC.scripted(w, 1, r);
      w.advance(a, b, ev, t * C.CDT);
      acc = (acc * 31 + Math.round((w.a.x + w.a.y * 3 + w.b.x * 7 + w.b.y * 11 + ev.r * 1e4) * 1e6)) % 2147483647;
      if (ev.done) w.reset(r);
    }
    return acc;
  };
  const h1 = run(), h2 = run();
  check('5000 ticks hash identically across runs', h1, h2);
  check('the hash is not a degenerate zero', h1 !== 0, true);
}

console.log('\n[9] the scripted opponent is a real benchmark');
{
  const w = new LC.World(), ev = new LC.Ev();
  w.reset(rand);
  let agentHits = 0, oppHits = 0, steps = 20000;
  for (let t = 0; t < steps; t++) {
    w.advance((rand() * 12) | 0, LC.scripted(w, 1, rand), ev, t * C.CDT);
    if (ev.hitSrc !== -2) agentHits++;
    if (ev.gotHit) oppHits++;
    if (ev.done) w.reset(rand);
  }
  const mins = steps * C.CDT / 60;
  console.log(`     random agent ${(agentHits / mins).toFixed(1)} hits/min, scripted opponent ${(oppHits / mins).toFixed(1)} hits/min`);
  check('a random policy is clearly losing', oppHits > agentHits * 2, true);
  check('the scripted opponent lands a meaningful number of shots', oppHits / mins > 8, true);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
