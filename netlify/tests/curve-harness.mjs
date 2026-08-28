
// Experiment harness for the learning-curve agent.
//
// It exists because seed-to-seed variance in this task is larger than every
// effect worth arguing about. A single run of one configuration has measured
// anywhere from 6 to 13 hits/min; several conclusions drawn from three or four
// seeds turned out to reverse under thirty. With sd around 3, resolving a
// difference of 1.5 needs roughly 30 seeds per arm.
//
// Each (arm, seed) job runs in its own process, so the whole grid finishes in
// wall-clock proportional to grid size over core count. Nothing here is shipped
// to the browser; it lives under netlify/ which the redirect rules 404.
//
//   node netlify/tests/curve-harness.mjs                     default grid
//   node netlify/tests/curve-harness.mjs --seeds 30 --grad 60000 --workers 40
//   node netlify/tests/curve-harness.mjs --arms base,rays

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = (n) => fs.readFileSync(new URL('../../learning-curve/' + n, import.meta.url), 'utf8');

// Seeds are hashed from the run index rather than taken as a short arithmetic
// run. That is a precaution, not a fix for a proven problem, and the honest
// version of the story is worth keeping because the first reading was wrong.
//
// This harness used to seed run s with 1000 + 7s. At 30k gradient steps over 16
// seeds per family that looked alarming: the arithmetic family measured sd 1.25
// hits/min against 2.39 for hashed seeds, a variance ratio of 3.66 where
// F(15,15) needs about 2.4 - which, if real, would mean correlated streams and
// a t inflated by roughly 1.9x everywhere below. It did not replicate. At 60k
// over 30 seeds per family the same two families measure sd 2.32 (arithmetic)
// and 1.93 (hashed), the opposite way round, and the means always agreed
// (13.30 against 14.00, then 16.34 against 16.30). A sample sd from 16 runs is
// itself noisy, and that test was run after a suggestive 8-seed split, so the
// first reading is best treated as what it looks like: noise, found by looking.
//
// Hashing is kept because it costs nothing and removes the question. Numbers
// measured before the change remain comparable.
const seedOf = (s) => (Math.imul(s + 1, 2654435761) >>> 0) % 2000000000;

const sub = (s, from, to) => {
  if (!s.includes(from)) throw new Error('arm patch did not match:\n' + from.slice(0, 120));
  return s.replace(from, to);
};

const ARMS = {
  base: {
    what: 'as shipped',
    core: (s) => s,
    worker: (s) => s,
  },
  fineturn: {
    what: 'five turn options instead of three',
    core: (s) => sub(s, 'var TURNS = [-1, 0, 1];', 'var TURNS = [-1, -0.3, 0, 0.3, 1];'),
    worker: (s) => s,
  },
  rays: {
    what: 'ray depth sensor instead of coordinates',
    core: (s) => sub(s, "var MODE = 'raw';", "var MODE = 'rays';"),
    worker: (s) => s,
  },
  atimpact: {
    what: 'pay a hit where the bullet lands, not to the shot that fired it',
    core: (s) => s,
    worker: (s) => sub(s,
      "    if (ev.hitSrc >= 0) ring.credit(ev.hitSrc, LC.R.HIT);",
      "    if (ev.hitSrc !== -2) { ring.r[st % RING] += LC.R.HIT; ring.rc[(st % RING) * NRC] += LC.R.HIT; }"),
  },
  nopassive: {
    what: 'no stationary or drifting sparring partners',
    core: (s) => s,
    worker: (s) => {
      s = sub(s, '  if (sr < 0.12) return', '  if (0) return');
      return sub(s, '  if (sr < 0.24) {', '  if (0) {');
    },
  },

  // A self-play episode is 10 seconds. It used to be 20, which is also what a
  // round the player was in the middle of used to be capped at - except that
  // the live world sets roundMax to Infinity, so the cap never applied to them
  // anyway. Shortening it only changes what the agent dreams, and it measures
  // level: over 30 seeds at 8000 gradient steps 4.63 hits/min against a moving
  // player versus 4.47, and at 60000 steps 15.66 against 16.13, neither near
  // two standard errors. It reads slightly low at 60k on all four styles and
  // slightly high at 8k on three, which is what noise looks like rather than a
  // trend. The win rate is not comparable between these arms: a 12000 step
  // evaluation holds twice as many episodes at 10s, so the same wins per
  // minute divide by twice the rounds.
  ep20: {
    what: 'self-play episodes of 20s rather than 10s',
    core: (s) => sub(s, '  ROUND_MAX: 10,', '  ROUND_MAX: 20,'),
    worker: (s) => s,
  },

  // Two arms on paying the agent for aim it cannot use. The aim terms ignore
  // the blocked flag the network is already given, so holding the nose on a
  // player behind a rock earns AIM every step and every shot into the rock
  // scores the full SHOTQ. That is why the agent will stand off and wait out
  // someone in cover: the standoff is its best-paying option.
  //
  // Gating the terms on a clear line looks like the obvious fix and measures
  // worse. Over 30 seeds at 8000 gradient steps, gating both takes 4.47
  // hits/min against a moving player down to 3.50 (t = -2.3) and - the part
  // that settles it - 1.67 down to 1.32 against a player who hides (t = -2.1),
  // the case it was meant to fix. Median lead at firing degrades too, 0.390 to
  // 0.465 rad. By 60000 steps every style is level again, so the cost is
  // entirely in how fast it learns.
  //
  // Gating only the shot, and leaving the per-step aim alone, was the obvious
  // salvage: keep the dense signal, stop paying 0.60 a time for shooting a
  // rock. It is not worse to two standard errors on any style, but it is
  // directionally worse on all four (4.06 against 4.47 moving, 1.47 against
  // 1.67 camper) and better on none, so there is nothing here to take.
  //
  // The reason is the one already noted on R.FIRE: aim is the dense signal in
  // a task where the gun is available about 4% of the time. Rocks occlude the
  // line often enough that gating removes a real share of it, and an agent
  // that learns to lead more slowly is worse at everything, including getting
  // an angle on someone in cover. Against a camper, aiming well beats being
  // pushed to reposition. Kept as arms because the reasoning is convincing and
  // wrong, which is the kind worth leaving written down.
  shotgate: {
    what: 'no shot-quality reward for a shot fired through a rock',
    core: (s) => {
      s = sub(s, '  s.tA = actTurn(actA);', '  s.blk = this.blocked;\n  s.tA = actTurn(actA);');
      return sub(s, '    rc[3] += R.SHOTQ', '    if (!s.blk) rc[3] += R.SHOTQ');
    },
    worker: (s) => s,
  },
  fullgate: {
    what: 'neither aim term paid when the line to the intercept is blocked',
    core: (s) => {
      s = sub(s, '  s.tA = actTurn(actA);', '  s.blk = this.blocked;\n  s.tA = actTurn(actA);');
      s = sub(s, '    rc[3] += R.SHOTQ', '    if (!s.blk) rc[3] += R.SHOTQ');
      return sub(s, '  if (cl > 0) rc[4] +=', '  if (cl > 0 && !s.blk) rc[4] +=');
    },
    worker: (s) => s,
  },

  // The shipped learner trains on a left/right reflection of half its batch.
  // This arm turns that off, which is how the number in curve-worker.js was
  // measured: 11.99 hits/min without it against 16.34 with, over 30 seeds.
  nomirror: {
    what: 'no left/right mirrored transitions (the pre-mirror learner)',
    core: (s) => s,
    worker: (s) => sub(s,
      '    if (this.rand() < 0.5) {\n      LC.mirrorObs(',
      '    if (0) {\n      LC.mirrorObs('),
  },

  clonemore: {
    what: 'more sparring against the clone of the player, less scripted',
    core: (s) => s,
    worker: (s) => sub(s, 'if (this.hN > 400 && r < 0.75) {', 'if (this.hN > 400 && r < 0.90) {'),
  },

  bcfast: {
    what: 'fit the clone of the player three times as often, double batch',
    core: (s) => {
      return s;
    },
    worker: (s) => {
      s = sub(s, "  if ((this.grad % 8) === 0) this.bcStep();", "  if ((this.grad % 3) === 0) this.bcStep();");
      return sub(s, '  var B = 16, i, loss = 0;', '  var B = 32, i, loss = 0;');
    },
  },

  // Let the player's own transitions take a larger share of every batch.
  //
  // Raising HUMAN_MAX_FRAC is NOT the way to do that, and testing it was worth
  // one grid: the cap never binds. A hundred seconds of play is 1500 real
  // transitions against 40000 dreamt ones, so the mix formula lands near 13%
  // and 0.40 is never reached - raising it to 0.65 measured identical to the
  // baseline, digit for digit, across 30 seeds. The weight is the live knob.
  livew: {
    what: 'weight real transitions 16x instead of 4x in the batch mix',
    core: (s) => s,
    worker: (s) => sub(s,
      '(this.live.n * 4) / (this.live.n * 4 + this.dream.n)',
      '(this.live.n * 16) / (this.live.n * 16 + this.dream.n)'),
  },

  adapt: {
    what: 'more clone sparring and a faster-fitted clone, together',
    core: (s) => s,
    worker: (s) => {
      s = sub(s, 'if (this.hN > 400 && r < 0.75) {', 'if (this.hN > 400 && r < 0.90) {');
      s = sub(s, "  if ((this.grad % 8) === 0) this.bcStep();", "  if ((this.grad % 3) === 0) this.bcStep();");
      return sub(s, '  var B = 16, i, loss = 0;', '  var B = 32, i, loss = 0;');
    },
  },

  per: {
    what: 'sample the worse-fitting of two transitions',
    core: (s) => s,
    worker: (s) => {
      s = sub(s, '  this.x = new Float32Array(cap * NAUX);      // auxiliary regression targets',
        '  this.x = new Float32Array(cap * NAUX);      // auxiliary regression targets\n' +
        '  this.pri = new Float32Array(cap);');
      s = sub(s, '  this.a[i] = a; this.r[i] = r; this.d[i] = d; this.gp[i] = gp;',
        '  this.a[i] = a; this.r[i] = r; this.d[i] = d; this.gp[i] = gp; this.pri[i] = 10;');
      s = sub(s, '    ix = (this.rand() * rep.n) | 0;\n    var So = ix * NOBS',
        '    ix = (this.rand() * rep.n) | 0;\n' +
        '    var i2 = (this.rand() * rep.n) | 0;\n' +
        '    if (rep.pri[i2] > rep.pri[ix]) ix = i2;\n' +
        '    var So = ix * NOBS');
      return sub(s, '    lsum += err * err;', '    lsum += err * err;\n    rep.pri[ix] = err < 0 ? -err : err;');
    },
  },

  eps12: {
    what: 'explore at 12% rather than 6% for the whole run',
    core: (s) => s,
    worker: (s) => sub(s, 'var EPS0 = 1.0, EPS1 = 0.06, EPS_N = 3000;', 'var EPS0 = 1.0, EPS1 = 0.12, EPS_N = 3000;'),
  },

  aux616: {
    what: 'predict the opponent 6 and 16 decisions ahead, not 4 and 10',
    core: (s) => s,
    worker: (s) => sub(s, 'var AUXK1 = 4, AUXK2 = 10;', 'var AUXK1 = 6, AUXK2 = 16;'),
  },

  tau4: {
    what: 'target network tracks at half the rate',
    core: (s) => s,
    worker: (s) => sub(s, 'var TAU = 0.008;', 'var TAU = 0.004;'),
  },

  // More capacity. The note in curve-core.js recording that 96 and 128 hidden
  // units were no better was measured before the auxiliary head and before the
  // mirror, and the mirror doubles what each gradient step is worth. It costs
  // roughly twice as much per step, so it is only meaningful when the arms are
  // matched on wall clock rather than on gradient steps.
  nh96: {
    what: 'hidden layers of 96 rather than 64',
    core: (s) => s,
    worker: (s) => sub(s, 'var NH = 64;', 'var NH = 96;'),
  },

  auxw6: {
    what: 'auxiliary head weighted 6 rather than 3',
    core: (s) => s,
    worker: (s) => sub(s, "var AUXW = LC.MODE === 'lead' ? 0 : 3.0;", "var AUXW = LC.MODE === 'lead' ? 0 : 6.0;"),
  },

  gamma98: {
    what: 'discount 0.98 rather than 0.97',
    core: (s) => s,
    worker: (s) => sub(s, 'var GAMMA = 0.97, NSTEP = 3, BATCH = 64;', 'var GAMMA = 0.98, NSTEP = 3, BATCH = 64;'),
  },

  // Frame stacking: show the policy the frame from 8 and 20 decisions ago
  // (0.53s and 1.33s) alongside the present one. Physics is already Markov
  // from one frame, so this adds nothing about flying or shooting; what it
  // could add is what kind of player it is up against. Triples the input width
  // and costs about 1.75x a gradient step, so it only means anything matched
  // on wall clock.
  stack: {
    what: 'also show the frame from 8 and 20 decisions ago',
    core: (s) => sub(s, 'var HLAG = [];', 'var HLAG = [8, 20];'),
    worker: (s) => s,
  },

  trace: {
    what: 'six leaky traces of what the opponent has been doing',
    core: (s) => sub(s, 'var PROF = 0;', 'var PROF = 1;'),
    worker: (s) => s,
  },

  stack1: {
    what: 'also show the frame from 8 decisions ago',
    core: (s) => sub(s, 'var HLAG = [];', 'var HLAG = [8];'),
    worker: (s) => s,
  },

  oppep: {
    what: 'one sparring partner per episode, not per decision',
    core: (s) => s,
    worker: (s) => {
      s = sub(s, 'Learner.prototype.dreamStep = function () {',
        `Learner.prototype.pickOpp = function () {
  var sr = this.rand();
  if (sr < 0.12) return 0;
  if (sr < 0.24) return 1;
  var r = this.rand();
  if (this.league.length && r < 0.30) return 2;
  if (this.hN > 400 && r < 0.75) return 3;
  return 4;
};
Learner.prototype.newOpp = function (i) {
  if (!this.oppKind) { this.oppKind = new Int32Array(NWORLD); this.oppIdx = new Int32Array(NWORLD); }
  this.oppKind[i] = this.pickOpp();
  this.oppIdx[i] = (this.rand() * 1e6) | 0;
};
Learner.prototype.dreamStep = function () {`);
      s = sub(s, 'Learner.prototype.dreamOpponent = function (w) {', 'Learner.prototype.dreamOpponent = function (w, kind, li) {');
      s = sub(s, '  var sr = this.rand();\n  if (sr < 0.12) return', '  if (kind === 0) return');
      s = sub(s, '  if (sr < 0.24) {', '  if (kind === 1) {');
      s = sub(s, '  var r = this.rand();\n  if (this.league.length && r < 0.30) {', '  if (kind === 2 && this.league.length) {');
      s = sub(s, '    var P2 = this.league[(this.rand() * this.league.length) | 0];', '    var P2 = this.league[li % this.league.length];');
      s = sub(s, '  if (this.hN > 400 && r < 0.75) {', '  if (kind === 3 && this.hN > 400) {');
      s = sub(s, '    var opp = this.dreamOpponent(w);',
        '    if (!this.oppKind) this.newOpp(i);\n    var opp = this.dreamOpponent(w, this.oppKind[i], this.oppIdx[i]);');
      return sub(s, '      w.reset(this.rand);', '      w.reset(this.rand); this.newOpp(i);');
    },
  },

  stackep: {
    what: 'frame stacking with one sparring partner per episode',
    core: (s) => sub(s, 'var HLAG = [];', 'var HLAG = [8, 20];'),
    worker: (s) => ARMS.oppep.worker(s),
  },

  nstep5: {
    what: 'five-step returns instead of three',
    core: (s) => s,
    worker: (s) => sub(s, 'var GAMMA = 0.97, NSTEP = 3, BATCH = 64;', 'var GAMMA = 0.97, NSTEP = 5, BATCH = 64;'),
  },

  sticky: {
    what: 'hold an exploratory action for three decisions',
    core: (s) => s,
    worker: (s) => sub(s,
      '    var a = this.rand() < eps ? (this.rand() * na) | 0 : this.net.argmaxN(na);',
      `    if (!this.hold) { this.hold = new Int32Array(NWORLD); this.holdA = new Int32Array(NWORLD); }
    var a;
    if (this.hold[i] > 0) {
      this.hold[i]--; a = this.holdA[i];
      if (a >= na) a -= NACT >> 1;      // it wanted to fire and the gun is reloading
    } else if (this.rand() < eps) {
      a = (this.rand() * na) | 0; this.holdA[i] = a; this.hold[i] = 2;
    } else a = this.net.argmaxN(na);`),
  },
};

if (process.env.CURVE_JOB) {
  const job = JSON.parse(process.env.CURVE_JOB);
  const arm = ARMS[job.arm];
  globalThis.self = globalThis;
  new Function(arm.core(SRC('curve-core.js')))();
  new Function(SRC('curve-net.js'))();
  new Function(arm.worker(SRC('curve-worker.js')))();
  const LC = globalThis.LC, Learner = globalThis.LCLearner, C = LC.C;

  const IDLE = LC.encode(0, 0, 0), POKE = LC.encode(0, 0, 1);
  const OPP = {
    moving: (w, r) => LC.scripted(w, 1, r),
    still: (w, r) => (r() < 0.05 ? POKE : IDLE),
    // A cleaner shot than the scripted policy: no jitter, a tighter tolerance,
    // and it always fires once it has the angle. Measurement only. It exists
    // because the scripted opponent has a ceiling around 19 hits/min and the
    // agent now scores 16 against it, which leaves too little room above to
    // separate one arm from another.
    sharp: (w, r) => {
      const le = w.lead[1];
      if (w.threat[1] > 0.28) return LC.encode(r() < 0.5 ? -1 : 1, 1, r() < 0.35 ? 1 : 0);
      return LC.encode(le > 0.03 ? 1 : (le < -0.03 ? -1 : 0),
        w.dist > C.RD * 0.30 ? 1 : 0, Math.abs(le) < 0.10 ? 1 : 0);
    },
    camper: (w, r) => {
      const me = w.b, foe = w.a;
      let best = null, bd = 1e9;
      for (let i = 0; i < w.rocks.length; i++) {
        const Rk = w.rocks[i];
        const dx = LC.dwrap(Rk.x - me.x, C.W), dy = LC.dwrap(Rk.y - me.y, C.H);
        const d = Math.hypot(dx, dy);
        if (d < bd) { bd = d; best = Rk; }
      }
      if (!best) return IDLE;
      const ax = LC.dwrap(best.x - foe.x, C.W), ay = LC.dwrap(best.y - foe.y, C.H);
      const an = Math.hypot(ax, ay) || 1;
      const gx = LC.dwrap(best.x + (ax / an) * (best.r + C.SR * 2) - me.x, C.W);
      const gy = LC.dwrap(best.y + (ay / an) * (best.r + C.SR * 2) - me.y, C.H);
      const gd = Math.hypot(gx, gy);
      let br = Math.atan2(gy, gx) - me.a;
      while (br > Math.PI) br -= 2 * Math.PI;
      while (br < -Math.PI) br += 2 * Math.PI;
      return LC.encode(br > 0.12 ? 1 : (br < -0.12 ? -1 : 0),
        gd > C.SR * 1.5 && Math.abs(br) < 0.5 ? 1 : 0, 0);
    },
  };
  const STYLES = ['moving', 'still', 'sharp', 'camper'];

  const styleAt = (style, sec, secs) =>
    style === 'switch' ? (sec < secs / 2 ? 'still' : 'moving') : style;

  function play(l, style, secs, gps, rand) {
    const w = new LC.World(), ev = new LC.Ev();
    const oa = new Float32Array(LC.NOBS), oh = new Float32Array(LC.NOBS);
    w.reset(rand);
    for (let sec = 0; sec < secs; sec++) {
      for (let k = 0; k < 15; k++) {
        w.observe(0, oa, 0); w.observe(1, oh, 0);
        l.net.fwd(l.P, oa, 0);
        const na = LC.nActions(w, 0);
        const a = rand() < 0.03 ? (rand() * na) | 0 : l.net.argmaxN(na);
        const hact = OPP[styleAt(style, sec, secs)](w, rand), st = w.step;
        w.advance(a, hact, ev, w.roundT * C.CDT);
        l.addLive(st, oa, 0, a, ev.r, ev.done, ev.hitSrc, ev.rc, 0, w.rel[0], w.rel[1]);
        l.addHuman(oh, 0, hact);
        if (ev.done) w.reset(rand);
      }
      for (let g = 0; g < gps; g++) l.chunk();
    }
  }

  function measure(l, style, seed, steps) {
    const rand = LC.rng(seed);
    const w = new LC.World(), ev = new LC.Ev();
    const ob = new Float32Array(LC.NOBS);
    w.reset(rand);
    let hits = 0, shots = 0, rounds = 0, wins = 0, leads = [];
    for (let i = 0; i < steps; i++) {
      w.observe(0, ob, 0);
      l.net.fwd(l.P, ob, 0);
      const na = LC.nActions(w, 0);
      const a = rand() < 0.02 ? (rand() * na) | 0 : l.net.argmaxN(na);
      const le = Math.abs(w.lead[0]);
      w.advance(a, OPP[style](w, rand), ev, w.roundT * C.CDT);
      if (ev.fired) { shots++; leads.push(le); }
      if (ev.hitSrc !== -2) hits++;
      if (ev.done) { rounds++; if (ev.hitSrc !== -2) wins++; w.reset(rand); }
    }
    leads.sort((a, b) => a - b);
    const mins = steps * C.CDT / 60;
    return {
      hpm: hits / mins,
      acc: shots ? hits / shots : 0,
      win: rounds ? wins / rounds : 0,
      lead: leads.length ? leads[leads.length >> 1] : NaN,
    };
  }

  const t0 = Date.now();
  const l = new Learner(job.seed);
  if (job.session) {
    play(l, job.session, job.secs, job.gps, LC.rng(seedOf(job.seed + 7919)));
  } else {
    while (l.grad < job.grad) l.chunk();
  }
  const out = { arm: job.arm, seed: job.seed, secs: (Date.now() - t0) / 1000, grad: l.grad, nobs: LC.NOBS, nact: LC.NACT };
  for (const style of STYLES) out[style] = measure(l, style, 4242, job.eval);
  process.send(out);
  process.exit(0);
}

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const SEEDS = +opt('seeds', 30);
const GRAD = +opt('grad', 60000);
const EVAL = +opt('eval', 12000);
const SESSION = opt('session', '');
const SECS = +opt('secs', 100);
const GPS = +opt('gps', 500);
const WORKERS = Math.min(+opt('workers', Math.max(2, os.cpus().length - 8)), 56);
const PICK = opt('arms', 'base,fineturn,rays,atimpact').split(',');

const jobs = [];
for (const arm of PICK) {
  if (!ARMS[arm]) { console.error('unknown arm: ' + arm); process.exit(2); }
  for (let s = 0; s < SEEDS; s++) {
    jobs.push({ arm, seed: seedOf(s), grad: GRAD, eval: EVAL, session: SESSION, secs: SECS, gps: GPS });
  }
}

console.log(`\n${PICK.length} arms x ${SEEDS} seeds = ${jobs.length} runs, ${WORKERS} at a time`);
console.log(SESSION
  ? `each: ${SECS}s simulated session against a ${SESSION} player at ${GPS} grad/s`
  : `each: train to ${GRAD} gradient steps on self-play only`);
for (const a of PICK) console.log(`  ${a.padEnd(10)} ${ARMS[a].what}`);
console.log('');

const results = [];
let next = 0, done = 0, live = 0;
const started = Date.now();

function launch() {
  while (live < WORKERS && next < jobs.length) {
    const job = jobs[next++];
    live++;
    const ch = fork(fileURLToPath(import.meta.url), [], {
      env: { ...process.env, CURVE_JOB: JSON.stringify(job) },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    ch.on('message', (m) => results.push(m));
    ch.on('exit', () => {
      live--; done++;
      if (done % Math.max(1, Math.floor(jobs.length / 20)) === 0 || done === jobs.length) {
        const el = (Date.now() - started) / 1000;
        const eta = done ? (el / done) * (jobs.length - done) : 0;
        process.stderr.write(`\r  ${done}/${jobs.length} done, ${el.toFixed(0)}s elapsed, ~${eta.toFixed(0)}s left   `);
      }
      if (done === jobs.length) report(); else launch();
    });
  }
}

const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const sd = (v) => { const m = mean(v); return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1)); };

function report() {
  process.stderr.write('\n');
  const byArm = {};
  for (const r of results) (byArm[r.arm] = byArm[r.arm] || []).push(r);

  const base = byArm[PICK[0]] || [];
  const col = (rows, style, k) => rows.map((r) => r[style][k]);

  for (const style of ['moving', 'still', 'sharp', 'camper']) {
    console.log(`\nagainst a ${style} player`);
    console.log('  arm        n   hits/min  +/-95%     acc    won   median lead   vs base');
    const bm = base.length ? mean(col(base, style, 'hpm')) : 0;
    const bs = base.length ? sd(col(base, style, 'hpm')) : 0;
    for (const arm of PICK) {
      const rows = byArm[arm] || [];
      if (!rows.length) continue;
      const h = col(rows, style, 'hpm'), m = mean(h), s = sd(h);
      const se = s / Math.sqrt(rows.length);
      let verdict = '';
      if (arm !== PICK[0] && (rows.length < 3 || base.length < 3)) {
        verdict = 'too few seeds to say';
      } else if (arm !== PICK[0] && base.length) {
        const seDiff = Math.sqrt((s * s) / rows.length + (bs * bs) / base.length);
        const t = (m - bm) / (seDiff || 1e-9);
        verdict = Math.abs(t) < 2 ? 'no difference'
          : (t > 0 ? 'BETTER (t=' + t.toFixed(1) + ')' : 'worse (t=' + t.toFixed(1) + ')');
      } else if (arm === PICK[0]) verdict = '(baseline)';
      console.log('  ' + arm.padEnd(10) + String(rows.length).padStart(3) +
        m.toFixed(2).padStart(10) + ('±' + (1.96 * se).toFixed(2)).padStart(9) +
        (100 * mean(col(rows, style, 'acc'))).toFixed(1).padStart(8) + '%' +
        (100 * mean(col(rows, style, 'win'))).toFixed(0).padStart(5) + '%' +
        mean(col(rows, style, 'lead')).toFixed(3).padStart(10) + '   ' + verdict);
    }
  }
  const anyRows = byArm[PICK[0]] || results;
  console.log(`\n  observation width / action count per arm:`);
  for (const arm of PICK) {
    const r = (byArm[arm] || [])[0];
    if (r) console.log(`    ${arm.padEnd(10)} ${r.nobs} inputs, ${r.nact} actions, ${r.secs.toFixed(0)}s per run`);
  }
  console.log(`\n  total wall clock ${((Date.now() - started) / 1000).toFixed(0)}s`);
  console.log('  "no difference" means the gap is inside two standard errors, i.e. this');
  console.log('  many seeds cannot tell the arms apart.\n');
}

launch();
