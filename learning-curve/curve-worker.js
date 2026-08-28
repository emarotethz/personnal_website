// The learner. Normally this runs in a Worker; if the browser has none, the page
// loads the same file as a plain script and drives LCLearner on a timer instead.
//
// The thing worth understanding here is why it dreams. Live play produces 15
// transitions a second, and competence costs about 6000 of them - roughly seven
// minutes of real play. Rolling the same 6000 out headlessly costs 20ms. So the
// human's transitions are in the buffer for relevance, not for volume, and the
// gradient steps are the only real expense.
(function (root) {
'use strict';

if (typeof importScripts === 'function' && typeof root.LC === 'undefined') {
  importScripts('curve-core.js?v=3', 'curve-net.js?v=2');
}

var LC = root.LC, Net = root.LCNet.Net, Adam = root.LCNet.Adam, polyak = root.LCNet.polyak;
var NAUX = root.LCNet.NAUX;
var NOBS = LC.NOBS, NACT = LC.NACT, NRC = LC.NRC, C = LC.C;

// Left and right are the same problem. Reflect a transition - negate every
// lateral component of the observation, swap the turn - and it is still a true
// transition of this world, so half of every batch is shown mirrored. The
// reflection replaces the sample rather than being appended to it, so a
// gradient step costs exactly what it did before.
//
// This is the largest single win measured on the agent. Over 30 seeds, against
// the same learner with the reflection switched off: 16.30 hits/min against a
// moving target where it manages 12.38 (t = -7.1), 16.17 against a still one
// against 13.19 (t = -3.0), and 15.92 against a sharper scripted opponent
// against 12.24 (t = -7.3). The median lead error at the moment of firing falls
// from 0.123 rad to 0.079, which is the mechanism showing through - it aims
// better rather than shooting more. It has replicated on two independent seed
// families; `--arms base,nomirror` in the harness reproduces it.
var MOBS = new Float32Array(NOBS), MOBS2 = new Float32Array(NOBS);
var MAUX = new Float32Array(NAUX);

var NH = 64;
var GAMMA = 0.97, NSTEP = 3, BATCH = 64;
// Gradient steps are the only expensive thing here - rollout runs at ~293k
// steps/sec, gradient steps at ~800/sec. So the ratio to tune is transitions
// per gradient step, and more is better: at 4 grad steps per transition the
// agent needed 60k gradient steps to reach 9 hits/min, at 0.25 it gets there in
// under 4k. Four fresh transitions per update, not four updates per transition.
var UTD = 0.25;
var DREAM_CAP = 40000, HUMAN_CAP = 8192;
var RING = 64, DELAY = 16;
var LR0 = 1e-3, LR1 = 3e-4, LR_DROP = 30000;
var TAU = 0.008;
var EPS0 = 1.0, EPS1 = 0.06, EPS_N = 3000;
var NWORLD = 4;
var HUMAN_MAX_FRAC = 0.40;
var SNAP_EVERY = 2000, Q_SANE = 15, Q_MAD = 30, MAD_STREAK = 200;
var LEAGUE_N = 5, LEAGUE_EVERY = 2500, LEAGUE_EPS = 0.10;
var CLONE_EPS = 0.20;
var AUXW = LC.MODE === 'lead' ? 0 : 3.0;
var AUXMODE = 'predict';
var AUXK1 = 4, AUXK2 = 10;

// Tried at 30 seeds each and rejected, recorded so the machine time does not
// get spent twice. Each is still an arm in the harness:
// `node netlify/tests/curve-harness.mjs --arms base,<name>`.
//
//   eps12    a 12% exploration floor rather than 6%: 13.96 hits/min against
//            16.30 (t = -3.8). The floor is already where it should be.
//   sticky   holding an exploratory action for three decisions: level against
//            a moving target, worse against a still one (13.67 v 16.17).
//   per      prioritised replay, training on the worse-fitting of two draws:
//            level on hits and worse at aiming (median lead 0.13 against 0.08).
//   nstep5   five-step returns rather than three: level.
//   aux616   auxiliary horizons of 6 and 16 decisions rather than 4 and 10:
//            level, despite matching a bullet's time of flight more closely.
//   tau4     halving the rate the target network tracks at: level.
//   auxw6    the auxiliary head weighted 6 rather than 3: 13.77 against 16.30
//            (t = -5.3). Three is already the right weight for it.
//   gamma98  discounting at 0.98 rather than 0.97: level against a moving
//            target, worse against a still one (13.04 against 16.17).
//   stack    frame stacking, and traces of what the opponent has been doing:
//            both rejected, both recorded in curve-core.js next to HLAG and
//            PROF, since they are questions about the observation.
//   oppep    one sparring partner per episode rather than per decision: 14.11
//            against 16.30 (t = -4.0). See the note above dreamOpponent.
//   nh96     hidden layers of 96 rather than 64. This one has to be matched on
//            CPU rather than on gradient steps, since it costs 1.83x a step:
//            given 32800 steps against the baseline's 60000, so that both runs
//            take about the same time, it reaches 13.61 against 16.30
//            (t = -5.4). The capacity does not pay for the steps it costs.
//
// And on the live-play side, where the point was to adapt harder to the person
// playing: sparring more against their clone and fitting that clone three times
// as often, both together, measured level over 30 seeds against a player who
// sits still and against one who switches from still to moving halfway.

function Replay(cap) {
  this.cap = cap; this.n = 0; this.w = 0;
  this.s = new Float32Array(cap * NOBS); this.s2 = new Float32Array(cap * NOBS);
  this.a = new Int8Array(cap); this.r = new Float32Array(cap);
  this.d = new Uint8Array(cap); this.gp = new Float32Array(cap);
  this.x = new Float32Array(cap * NAUX);
}
Replay.prototype.add = function (so, soff, a, r, s2o, s2off, d, gp, xo, xoff) {
  var i = this.w, k;
  for (k = 0; k < NOBS; k++) { this.s[i * NOBS + k] = so[soff + k]; this.s2[i * NOBS + k] = s2o[s2off + k]; }
  for (k = 0; k < NAUX; k++) this.x[i * NAUX + k] = xo ? xo[xoff + k] : 0;
  this.a[i] = a; this.r[i] = r; this.d[i] = d; this.gp[i] = gp;
  this.w = (this.w + 1) % this.cap;
  if (this.n < this.cap) this.n++;
};

// Holds the last RING decisions for two reasons: n-step returns can only be
// assembled once the future is known, and a hit has to be paid back to the step
// that fired the shot rather than the step the bullet lands on.
//
// That second one flip-flopped twice on small samples before the harness
// settled it. Over 30 seeds, crediting the firing step gives 11.99 hits/min
// against a moving target versus 9.61 for crediting at impact (t = 5.9), and
// the median lead error at the moment of firing drops from 0.193 rad to 0.124 -
// it aims better, which is exactly the mechanism working. Earlier readings on
// four and six seeds pointed the other way and were noise.
function Ring() {
  this.o = new Float32Array(RING * NOBS); this.a = new Int8Array(RING);
  this.r = new Float32Array(RING); this.d = new Uint8Array(RING);
  this.rc = new Float32Array(RING * NRC);
  this.x = new Float32Array(RING * NAUX);
  this.rel = new Float32Array(RING * 2);
  this.head = -1; this.drained = -1;
}
Ring.prototype.write = function (step, obs, off, act, r, done, rc, rcoff, aux, relF, relR) {
  var s = step % RING, k;
  if (this.head < 0) this.drained = step - 1;
  for (k = 0; k < NOBS; k++) this.o[s * NOBS + k] = obs[off + k];
  for (k = 0; k < NRC; k++) this.rc[s * NRC + k] = rc ? rc[rcoff + k] : 0;
  for (k = 0; k < NAUX; k++) this.x[s * NAUX + k] = aux ? aux[k] : 0;
  this.rel[s * 2] = relF || 0; this.rel[s * 2 + 1] = relR || 0;
  this.a[s] = act; this.r[s] = r; this.d[s] = done ? 1 : 0;
  this.head = step;
};
Ring.prototype.futureTarget = function (f) {
  var o = f % RING, i, k, slot;
  for (i = 0; i < 2; i++) {
    var want = i === 0 ? AUXK1 : AUXK2;
    slot = o;
    for (k = 1; k <= want; k++) {
      if (this.d[(f + k - 1) % RING]) break;
      slot = (f + k) % RING;
    }
    this.x[o * NAUX + i * 2] = this.rel[slot * 2];
    this.x[o * NAUX + i * 2 + 1] = this.rel[slot * 2 + 1];
  }
};

Ring.prototype.credit = function (step, amt) {
  if (step < 0 || this.head - step >= RING) return false;
  var s = step % RING;
  this.r[s] += amt;
  this.rc[s * NRC] += amt;
  return true;
};

Ring.prototype.drain = function (rep, acc) {
  var limit = this.head - DELAY;
  while (this.drained < limit) {
    var f = this.drained + 1, R = 0, g = 1, term = 0, k = 0, s;
    for (k = 0; k < NSTEP; k++) {
      s = (f + k) % RING;
      R += g * this.r[s]; g *= GAMMA;
      if (this.d[s]) { term = 1; break; }
    }
    var nx = (term ? (f + k) : (f + NSTEP)) % RING, cur = f % RING;
    if (AUXMODE === 'predict') this.futureTarget(f);
    rep.add(this.o, cur * NOBS, this.a[cur], R, this.o, nx * NOBS, term, g, this.x, cur * NAUX);
    if (acc) for (var j = 0; j < NRC; j++) acc[j] += this.rc[cur * NRC + j];
    this.drained = f;
  }
};

function Learner(seed) {
  this.rand = LC.rng(seed || 1);
  this.net = new Net(NOBS, NH, NACT);
  this.tgt = new Net(NOBS, NH, NACT);
  this.P = this.net.init(this.rand);
  this.PT = new Float32Array(this.P);
  this.G = new Float32Array(this.net.NP);
  this.opt = new Adam(this.net.NP, LR0);
  this.snap = new Float32Array(this.P);
  this.snapAt = 0;

  this.bc = new Net(NOBS, 48, NACT);
  this.BP = this.bc.init(this.rand);
  this.BG = new Float32Array(this.bc.NP);
  this.bopt = new Adam(this.bc.NP, 2e-3);
  this.hObs = new Float32Array(HUMAN_CAP * NOBS);
  this.hAct = new Int8Array(HUMAN_CAP);
  this.hN = 0; this.hW = 0;
  this.bcCE = 2.5; this.bcEMA = 2.5; this.shiftStreak = 0; this.readapt = 0;

  this.dream = new Replay(DREAM_CAP);
  this.live = new Replay(HUMAN_CAP);

  this.worlds = []; this.rings = []; this.wstep = []; this.evs = [];
  for (var i = 0; i < NWORLD; i++) {
    var w = new LC.World();
    w.reset(this.rand);
    this.worlds.push(w); this.rings.push(new Ring());
    this.wstep.push(0); this.evs.push(new LC.Ev());
  }
  this.liveRing = new Ring();
  this.obuf = new Float32Array(NOBS);
  this.obuf2 = new Float32Array(NOBS);
  this.oppNet = new Net(NOBS, NH, NACT);
  this.league = []; this.leagueAt = 0;
  this.auxT = new Float32Array(NAUX);
  this.auxLoss = 0;

  this.grad = 0; this.trans = 0; this.dreamSteps = 0; this.liveTrans = 0;
  this.loss = 0; this.qbar = 0; this.madStreak = 0; this.rollbacks = 0;
  this.rcAcc = new Float32Array(NRC); this.rcN = 0;
  this.rcPrev = new Float32Array(NRC); this.rcNPrev = 0; this.rcLast = null;
  this.hits = 0; this.shots = 0; this.taken = 0; this.rounds = 0; this.wins = 0;
  this.retDream = 0; this.retN = 0; this.retAcc = 0;
  this.events = [];
  this.epsFloor = EPS1;
  this.dead = 0;
  this.utd = UTD;
}

Learner.prototype.eps = function () {
  var e = EPS0 + (this.epsFloor - EPS0) * Math.min(1, this.trans / EPS_N);
  return Math.max(this.epsFloor, e);
};

Learner.prototype.log = function (kind, text) {
  this.events.push({ kind: kind, text: text, at: this.grad });
  if (this.events.length > 24) this.events.shift();
};

Learner.prototype.addHuman = function (obs, off, act) {
  var i = this.hW, k;
  for (k = 0; k < NOBS; k++) this.hObs[i * NOBS + k] = obs[off + k];
  this.hAct[i] = act;
  this.hW = (this.hW + 1) % HUMAN_CAP;
  if (this.hN < HUMAN_CAP) this.hN++;
};

Learner.prototype.addLive = function (step, obs, off, act, r, done, hitSrc, rc, rcoff, relF, relR) {
  this.liveRing.write(step, obs, off, act, r, done, rc, rcoff, null, relF, relR);
  if (hitSrc >= 0) this.liveRing.credit(hitSrc, LC.R.HIT);
  this.liveRing.drain(this.live, null);
  this.liveTrans++;
};

// Three kinds of sparring partner, weighted toward the clone of you, since
// adapting to the person actually playing is what makes it feel hard.
//
// Note that this is drawn per decision, not per episode, so a dream round is
// fought against something that sits still for one step and plays like you the
// next. That looks like a bug and is worth keeping: drawing once per episode
// instead measures 14.11 hits/min against 16.30 over 30 seeds (t = -4.0). Per
// step, every episode contains practice against every style; per episode, only
// a tenth of them are against a still target and the rest of that episode's
// gradient is correlated. The chimera is domain randomisation, not an error.
//
// The
// scripted policy is the floor and keeps some diversity in the buffer. The
// frozen past selves are the standard remedy for plateauing against a fixed
// opponent; measured head to head they came out level (51% over 550 rounds),
// so they are kept for the long tail rather than on proven benefit, and they
// cost about 3% of throughput.
Learner.prototype.dreamOpponent = function (w) {
  // A share of barely-moving partners. Everything else here moves constantly,
  // and until the clone of you has been fitted the agent has never faced a
  // player who simply sits there. Removing them costs 16.30 hits/min against a
  // moving target down to 15.15 (t = -2.2) and 16.17 against a still one down
  // to 14.08 (t = -2.0), over 30 seeds. A small effect, but it has now come out
  // the same way on two independent seed families. Once the clone is fitted it
  // becomes redundant, since a still player produces a still clone, so in a
  // live session the gain is no longer significant (11.86 against 11.03,
  // t = 1.2). Kept because it is free and covers the opening minute.
  var sr = this.rand();
  if (sr < 0.12) return this.rand() < 0.05 ? LC.encode(0, 0, 1) : LC.encode(0, 0, 0);
  if (sr < 0.24) {
    return this.rand() < 0.05 ? LC.encode((this.rand() * 3 | 0) - 1, 1, 0) : LC.encode(0, 0, 0);
  }
  var r = this.rand();
  if (this.league.length && r < 0.30) {
    var P2 = this.league[(this.rand() * this.league.length) | 0];
    w.observe(1, this.obuf2, 0);
    this.oppNet.fwd(P2, this.obuf2, 0);
    var na = LC.nActions(w, 1);
    return this.rand() < LEAGUE_EPS ? (this.rand() * na) | 0 : this.oppNet.argmaxN(na);
  }
  // Sparring against the clone harder does not help. Raising this share from
  // 0.75 to 0.90 and fitting the clone three times as often at double batch,
  // both at once, measured level over 30 seeds of live play: 14.04 hits/min
  // against 13.77 against a player who sits still, and 14.38 against 14.63
  // against one who switches from still to moving halfway through. The agent
  // already handles a change of tactics; this is not what is holding it back.
  if (this.hN > 400 && r < 0.75) {
    // A share of exploration inside the clone itself, so what it practises
    // against is a neighbourhood around how you play rather than exactly how
    // you played. Costs nothing and should survive you changing tactics; it is
    // not measurably better over the seeds affordable here, but the seed spread
    // (6 to 13 hits/min within one setting) is wider than any effect this size,
    // so "not measurable" is the honest claim rather than "no effect".
    if (this.rand() < CLONE_EPS) return (this.rand() * LC.nActions(w, 1)) | 0;
    w.observe(1, this.obuf2, 0);
    this.bc.fwd(this.BP, this.obuf2, 0);
    return this.bc.sample(this.rand, 1.0);
  }
  return LC.scripted(w, 1, this.rand, 1);
};

Learner.prototype.dreamStep = function () {
  var eps = this.eps();
  for (var i = 0; i < NWORLD; i++) {
    var w = this.worlds[i], ring = this.rings[i], ev = this.evs[i], st = this.wstep[i];
    w.observe(0, this.obuf, 0);
    this.net.fwd(this.P, this.obuf, 0);
    var na = LC.nActions(w, 0);
    var a = this.rand() < eps ? (this.rand() * na) | 0 : this.net.argmaxN(na);
    var opp = this.dreamOpponent(w);
    w.advance(a, opp, ev, w.roundT * C.CDT);

    if (AUXMODE === 'lead') {
      this.auxT[0] = Math.cos(w.lead[0]);
      this.auxT[1] = Math.sin(w.lead[0]);
      this.auxT[2] = w.tHit[0] > 0 ? Math.min(1, w.tHit[0]) : 0;
      this.auxT[3] = 0;
    }
    ring.write(st, this.obuf, 0, a, ev.r, ev.done, ev.rc, 0,
      AUXMODE === 'lead' ? this.auxT : null, w.rel[0], w.rel[1]);
    if (ev.hitSrc >= 0) ring.credit(ev.hitSrc, LC.R.HIT);
    ring.drain(this.dream, this.rcAcc);
    this.rcN++;

    if (ev.fired) this.shots++;
    if (ev.hitSrc !== -2) this.hits++;
    if (ev.gotHit) this.taken++;
    this.retAcc += ev.r;
    if (ev.done) {
      this.rounds++;
      if (ev.hitSrc !== -2) this.wins++;
      this.retDream += (this.retAcc - this.retDream) * 0.05;
      this.retN++; this.retAcc = 0;
      w.reset(this.rand);
    }
    this.wstep[i] = st + 1;
    this.dreamSteps++; this.trans++;
  }
};

Learner.prototype.bcStep = function () {
  if (this.hN < 64) return;
  var B = 16, i, loss = 0;
  this.BG.fill(0);
  for (i = 0; i < B; i++) {
    var ix = (this.rand() * this.hN) | 0;
    this.bc.fwd(this.BP, this.hObs, ix * NOBS);
    loss += this.bc.bwdCE(this.BP, this.BG, this.hObs, ix * NOBS, this.hAct[ix], 1 / B);
  }
  this.bopt.step(this.BP, this.BG);
  loss /= B;
  this.bcCE = loss;
  if (loss > 1.6 * this.bcEMA && this.bcEMA > 0.05) {
    this.shiftStreak++;
    if (this.shiftStreak >= 3 && this.readapt <= 0) {
      this.readapt = 2000;
      this.epsFloor = 0.18;
      this.log('readapt', 'you changed tactics');
    }
  } else this.shiftStreak = 0;
  this.bcEMA += (loss - this.bcEMA) * 0.01;
};

Learner.prototype.gradStep = function () {
  var net = this.net, tgt = this.tgt, P = this.P, PT = this.PT, G = this.G;
  if (this.dream.n + this.live.n < 2000) return false;
  G.fill(0);
  var lsum = 0, qsum = 0, axsum = 0, b, ix, rep;
  // Real transitions are worth more than dreamt ones, but never allowed to
  // dominate the buffer or a single style becomes the whole world.
  //
  // The 4 is the knob, and it is already where it should be. At 16 the agent is
  // markedly worse - 10.15 hits/min against 13.92 over 30 seeds of live play
  // (t = -7.2), with the median lead error rising from 0.108 to 0.178. A
  // hundred seconds of one person's play is about 1500 transitions, and leaning
  // on that few overfits their style at the cost of being able to aim at all.
  //
  // HUMAN_MAX_FRAC is not a knob at all here: the formula below lands near 13%,
  // so the cap never binds. Raising it to 0.65 measured identical to baseline,
  // digit for digit, across 30 seeds. It is a guard rail, not a setting.
  var hf = this.live.n > 200 ? Math.min(HUMAN_MAX_FRAC, (this.live.n * 4) / (this.live.n * 4 + this.dream.n)) : 0;
  for (b = 0; b < BATCH; b++) {
    rep = (this.rand() < hf) ? this.live : this.dream;
    if (rep.n === 0) rep = this.dream;
    ix = (this.rand() * rep.n) | 0;
    var So = ix * NOBS, S2o = So, Xo = ix * NAUX;
    var S = rep.s, S2 = rep.s2, X = rep.x, act = rep.a[ix];
    if (this.rand() < 0.5) {
      LC.mirrorObs(rep.s, So, MOBS); LC.mirrorObs(rep.s2, So, MOBS2);
      for (var m = 0; m < NAUX; m++) MAUX[m] = (m & 1) ? -rep.x[Xo + m] : rep.x[Xo + m];
      S = MOBS; S2 = MOBS2; X = MAUX; So = 0; S2o = 0; Xo = 0;
      act = LC.mirrorAct(act);
    }
    var y = rep.r[ix];
    if (!rep.d[ix]) {
      net.fwd(P, S2, S2o);
      var ai = net.argmax();
      tgt.fwd(PT, S2, S2o);
      y += rep.gp[ix] * tgt.q[ai];
    }
    var q = net.fwd(P, S, So);
    qsum += q[net.argmax()];
    var err = q[act] - y;
    if (err > 1) err = 1; else if (err < -1) err = -1;
    lsum += err * err;
    net.bwdQ(P, G, S, So, act, err / BATCH);
    if (AUXW > 0) axsum += net.bwdAux(P, G, S, So, X, Xo, AUXW / BATCH);
  }
  this.opt.lr = this.grad > LR_DROP ? LR1 : LR0;
  this.opt.step(P, G);
  if (this.grad - this.leagueAt >= LEAGUE_EVERY) {
    this.leagueAt = this.grad;
    this.league.push(new Float32Array(P));
    if (this.league.length > LEAGUE_N) this.league.shift();
  }
  polyak(PT, P, TAU);
  this.grad++;
  this.loss += (lsum / BATCH - this.loss) * 0.01;
  this.qbar += (qsum / BATCH - this.qbar) * 0.01;
  this.auxLoss += (axsum / BATCH - this.auxLoss) * 0.01;
  if (this.readapt > 0 && --this.readapt === 0) this.epsFloor = EPS1;

  if (Math.abs(this.qbar) > Q_MAD) {
    if (++this.madStreak >= MAD_STREAK) this.rollback('value function diverged');
  } else this.madStreak = 0;
  if ((this.grad & 255) === 0) {
    if (!isFinite(P[0]) || !isFinite(P[net.W1]) || !isFinite(P[net.Wa])) this.rollback('NaN in the weights');
    else if (this.grad - this.snapAt >= SNAP_EVERY && Math.abs(this.qbar) < Q_SANE) {
      this.snap.set(P); this.snapAt = this.grad;
    }
  }
  return true;
};

Learner.prototype.rollback = function (why) {
  this.P.set(this.snap); this.PT.set(this.snap);
  this.opt.m.fill(0); this.opt.v.fill(0);
  this.opt.lr *= 0.5; LR0 *= 0.5; LR1 *= 0.5;
  this.qbar = 0; this.madStreak = 0; this.rollbacks++;
  this.log('rollback', why);
};

Learner.prototype.newBrain = function (seed) {
  this.rand = LC.rng(seed || ((Math.random() * 1e9) | 0));
  this.P = this.net.init(this.rand);
  this.PT = new Float32Array(this.P);
  this.snap = new Float32Array(this.P); this.snapAt = 0;
  this.opt = new Adam(this.net.NP, LR0);
  this.dream = new Replay(DREAM_CAP); this.live = new Replay(HUMAN_CAP);
  this.liveRing = new Ring();
  for (var i = 0; i < NWORLD; i++) {
    this.rings[i] = new Ring(); this.wstep[i] = 0;
    this.worlds[i].step = 0;
    this.worlds[i].reset(this.rand);
  }
  this.grad = 0; this.trans = 0; this.dreamSteps = 0; this.loss = 0; this.qbar = 0;
  this.hits = 0; this.shots = 0; this.taken = 0; this.rounds = 0; this.wins = 0;
  this.epsFloor = EPS1; this.readapt = 0; this.rollbacks = 0;
  this.league = []; this.leagueAt = 0;
  this.rcAcc.fill(0); this.rcN = 0;
};

Learner.prototype.chunk = function () {
  this.dreamStep();
  var n = Math.max(1, Math.round(NWORLD * this.utd)), did = 0;
  for (var i = 0; i < n; i++) if (this.gradStep()) did++;
  if ((this.grad % 8) === 0) this.bcStep();
  return did;
};

Learner.prototype.stats = function () {
  var mins = this.dreamSteps * C.CDT / 60;
  var rc = new Float32Array(NRC), i;
  var dn = this.rcN - this.rcNPrev;
  if (dn > 0) {
    for (i = 0; i < NRC; i++) { rc[i] = (this.rcAcc[i] - this.rcPrev[i]) / dn; this.rcPrev[i] = this.rcAcc[i]; }
    this.rcNPrev = this.rcN;
    this.rcLast = rc;
  } else if (this.rcLast) rc = this.rcLast;
  return {
    grad: this.grad, trans: this.trans, dream: this.dreamSteps, live: this.liveTrans,
    eps: this.eps(), loss: this.loss, q: this.qbar, gnorm: this.opt.gnorm,
    bcCE: this.bcCE, auxLoss: this.auxLoss, readapt: this.readapt > 0 ? 1 : 0, rollbacks: this.rollbacks,
    hitsPerMin: mins > 0 ? this.hits / mins : 0,
    takenPerMin: mins > 0 ? this.taken / mins : 0,
    acc: this.shots ? this.hits / this.shots : 0,
    winRate: this.rounds ? this.wins / this.rounds : 0,
    ret: this.retDream, rounds: this.rounds,
    bufDream: this.dream.n, bufLive: this.live.n, human: this.hN, league: this.league.length,
    rc: rc
  };
};

function Pacer(rate) {
  this.rate = rate || Infinity;
  this.credit = 0; this.last = 0; this.busy = 0; this.spent = 0;
}
Pacer.prototype.run = function (learner, now, msCap) {
  var per = Math.max(1, Math.round(NWORLD * learner.utd)), t0 = now, did = 0;
  if (this.rate === Infinity) {
    do { learner.chunk(); did += per; } while (nowMs() - t0 < msCap);
    this.busy = nowMs() - t0;
    this.spent += this.busy;
    return did;
  }
  if (!this.last) this.last = now;
  var dt = Math.min(0.5, (now - this.last) / 1000);
  this.last = now;
  this.credit = Math.min(this.rate * 0.5, this.credit + dt * this.rate);
  while (this.credit >= per) {
    learner.chunk();
    this.credit -= per; did += per;
    if (((now = nowMs()) - t0) >= msCap) break;
  }
  this.busy = nowMs() - t0;
  this.spent += this.busy;
  return did;
};
function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

root.LCLearner = Learner;
root.LCPacer = Pacer;
// Unthrottled. Measured curve against the scripted benchmark, by gradient step:
//   8k -> 8.0 hits/min, 25k -> 10.7, 60k -> 13.3, 85k -> 14.5 (ceiling 19.2),
// so on a machine managing ~500 steps/sec a three minute run lands past 85k.
// It only runs while a round is live: never during the intro, between rounds,
// while paused, or with the tab hidden.
root.LCRates = { eco: 120, normal: Infinity, turbo: Infinity };

if (typeof importScripts === 'function' && typeof root.document === 'undefined') {
  var L = null, running = false, timer = 0;
  var spare = [], lastSync = 0, lastStats = 0, mode = 'normal';
  var pacer = null, SLICE = 16, MSCAP = 13;
  var duty = 0;

  function sync(now) {
    if (!spare.length) return;
    var buf = spare.pop();
    buf.set(L.P);
    lastSync = now;
    root.postMessage({ type: 'weights', buf: buf }, [buf.buffer]);
  }

  function loop() {
    if (!running) return;
    var t0 = nowMs();
    pacer.run(L, t0, MSCAP);
    var now = nowMs(), spent = now - t0;
    duty += (spent / SLICE - duty) * 0.1;
    if (now - lastSync > 100) sync(now);
    if (now - lastStats > 110) {
      lastStats = now;
      var s = L.stats();
      s.ms = spent; s.duty = duty; s.mode = mode; s.rate = pacer.rate;
      s.events = L.events.splice(0, L.events.length);
      root.postMessage({ type: 'stats', s: s });
    }
    timer = setTimeout(loop, Math.max(1, SLICE - spent));
  }

  root.onmessage = function (e) {
    var m = e.data;
    if (m.type === 'init') {
      L = new Learner(m.seed);
      pacer = new Pacer(root.LCRates[m.mode || 'normal']);
      mode = m.mode || 'normal';
      spare = [new Float32Array(L.net.NP), new Float32Array(L.net.NP)];
      root.postMessage({ type: 'ready', np: L.net.NP, nobs: NOBS, nact: NACT, nh: NH });
      running = true; loop();
    } else if (m.type === 'recycle') {
      spare.push(new Float32Array(m.buf));
    } else if (m.type === 'live') {
      var d = m.d, n = m.n, st = m.step0, k;
      for (k = 0; k < n; k++) {
        var o = k * (NOBS * 2 + NRC + 7);
        L.addLive(st + k, d, o, d[o + NOBS * 2 + NRC], d[o + NOBS * 2 + NRC + 1],
          d[o + NOBS * 2 + NRC + 2], d[o + NOBS * 2 + NRC + 3], d, o + NOBS * 2,
          d[o + NOBS * 2 + NRC + 5], d[o + NOBS * 2 + NRC + 6]);
        L.addHuman(d, o + NOBS, d[o + NOBS * 2 + NRC + 4]);
      }
    } else if (m.type === 'mode') {
      mode = m.mode;
      pacer.rate = root.LCRates[mode] || root.LCRates.normal;
    } else if (m.type === 'pause') {
      var was = running;
      running = !m.on;
      if (running && !was) { pacer.last = 0; pacer.credit = 0; loop(); }
      else if (!running) clearTimeout(timer);
    } else if (m.type === 'newBrain') {
      L.newBrain(m.seed);
    }
  };
}

})(typeof self !== 'undefined' ? self : this);
