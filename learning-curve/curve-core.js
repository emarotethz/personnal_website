// The duel itself: torus physics, the observation the agent sees, and the reward.
// Loaded three ways and it has to behave identically in all of them - <script src>
// on the page, importScripts() in the learner worker, and new Function() in the
// Node tests. Hence the root sniff and no module syntax anywhere in here.
(function (root) {
'use strict';

var C = {
  W: 1000, H: 700,
  DT: 1 / 60, REPEAT: 4,
  THR: 420, ROT: 3.6, DRAG: 0.55, VMAX: 380,
  // Slow bullets and a long reload are what make aiming worth anything. At the
  // original 0.45s reload a shooter that just held the trigger scored the same
  // hits/min as one that aimed (1.02x); here aimed fire is worth 1.97x sprayed.
  BSPD: 600, BTTL: 1.1, BCD: 1.6, BR: 4, SR: 12, MAXB: 3,
  // Rocks are obstacles, not hazards: they shove a ship off its line and they
  // swallow bullets, but they never kill anyone. NSEE is how many of them the
  // policy is told about, nearest first - describing all seven cost more in
  // diluted input than it bought in awareness (5.0 hits/min at 15k gradient
  // steps against 11.4 for the two nearest).
  NROCK: 7, NSEE: 2, RMIN: 24, RMAX: 46, RSPD: 24, BOUNCE: 0.6, SHOVE: 90,
  INV: 0.9,
  ROUND_MAX: 10,
  DOPT: 260
};
C.RD = Math.hypot(C.W, C.H) / 2;
C.RELV = 2 * C.VMAX;
C.RVMAX = C.BSPD + 2 * C.VMAX;
C.CDT = C.DT * C.REPEAT;
C.ROUND_STEPS = Math.round(C.ROUND_MAX / C.CDT);

// How the world is described to the policy. 'raw' ships: state only, both
// ships, their velocities, the nearest incoming shots and every rock. It is
// never told where to aim.
//
// Getting there took some doing. Per second of one core, flat out (hits/min,
// scripted ceiling 19.2):
//
//                          10s    30s    60s   120s
//   lead (given the answer) 4.7    9.5    9.1   18.2
//   raw                     2.2    3.9    3.9    7.0
//   raw + auxiliary head    5.9   10.2   15.7   14.9
//
// 'lead' hands over the solved intercept as cos/sin of how far the nose still
// has to turn, which makes aiming almost a supervised problem - and it was
// twice as good as anything else until the auxiliary head existed.
//
// Two things that did NOT work, both informative. 'extrap' hands over where the
// target will be at three fixed times, and 'polar' gives those as directions
// rather than offsets; both still lost badly, so *predicting* the target was
// never the hard part. Nor was capacity - 96 and 128 hidden units were no
// better and three times slower. That was re-checked once the auxiliary head
// and the mirrored batch existed, on the theory that more data per step might
// finally give the capacity something to do: matched on CPU rather than on
// gradient steps, 96 units reaches 13.61 hits/min against 64's 16.30.
//
// What worked was leaving the observation raw and adding a second head that
// regresses the intercept, trained on targets taken from the simulator (see
// AUXW in curve-worker.js). The policy still has to work out where to shoot;
// it just gets told, densely, whether its working-out was right, instead of
// having to infer it from hits that arrive once every couple of seconds.
var MODE = 'raw';

// Turn rate is 3.6 rad/s over a 4-tick decision, so a turn action rotates
// 0.24 rad while a shot wants the nose inside about 0.05. That looks like the
// binding constraint - the median lead error at the moment of firing is 0.20
// rad - so adding half-rate turns is the obvious fix. Over 30 seeds it is
// clearly worse: 6.80 hits/min against a moving target versus 9.38, t = -8.6,
// with no gain against a still one. Twenty actions cost more to explore than
// the finer aim is worth, and the median lead error does not improve. Settled.
var TURNS = [-1, 0, 1];
var NACT = TURNS.length * 4, NRC = 8;
var NBUL = 2;
var LOOK = [0.35, 0.7, 1.1];
var RAY_DEG = [0, 4, -4, 9, -9, 16, -16, 26, -26, 40, -40, 62, -62, 100, -100, 150, -150];
var RAY = RAY_DEG.map(function (d) { return d * Math.PI / 180; });
var NRAY = RAY.length, RAYCH = 2;
var RAYBASE = 7, RAYN = RAYBASE + NRAY * RAYCH + NBUL * 4 + 3;
// Behavioural traces: a few running summaries of what the opponent has been
// doing, as leaky integrators updated once per decision. This is the same thing
// frame stacking was reaching for - the part of history a single frame cannot
// hold - but as six numbers rather than ninety-two copied ones, which is the
// difference that matters given how badly the copied ones diluted the input.
//
// The six do carry the signal. Against a partner that sits still they read all
// zero; against one that circles, turn saturates at 0.98; against one that runs
// and shoots, speed pins at 1.0 and the fire trace at 0.53. They are also
// useless. Over 30 seeds: 15.51 hits/min against 16.30 in self-play, inside the
// noise, and against a player who switches from still to moving halfway through
// a session, 13.90 against 14.05. No difference anywhere, for 12% of throughput.
//
// Which, with the stacking result, is the answer to the question both were
// asking. Knowing what kind of player it faces does not help the agent, because
// it is not short of that knowledge: the behaviour clone already fits this
// person and then supplies them as the sparring partner, so the adaptation
// happens in the training distribution rather than in the observation. Handing
// the same thing to the policy a second time, as input, buys nothing.
// PROF = 0 turns them off, which is what ships.
var PROF = 0;
var NPROF = 6;
var RAWBASE = 22 + 3 * C.NROCK + 3;
var RAWN = RAWBASE + (PROF ? NPROF : 0);
var LEADN = 25 + 3 * C.NSEE + 1;
// Frame stacking. HLAG lists how many decisions back to show alongside the
// present one, so the observation becomes the current frame followed by a copy
// of the frame from each lag. Empty means no stacking, which is what ships.
//
// The motivation is that one frame cannot say what kind of player it is facing.
// Position and velocity make the physics Markov, so nothing is missing for
// flying and shooting, but whether this person sits still, circles, or runs is
// a property of the last few seconds and is invisible in a single frame. Two
// lags are a way to hand that over without recurrence to train through.
//
// It does not work, and it fails the same way the ray sensor and the
// all-seven-rocks observation failed: by dilution. Over 30 seeds, at the SAME
// number of gradient steps, so the extra cost is not what is being measured:
//
//   inputs   hits/min (moving)   median lead at firing
//   46          16.30                0.079
//   92 ([8])    14.44  (t = -4.1)    0.096
//   138 ([8,20]) 12.90 (t = -6.6)    0.109
//
// Monotone in width, and the aim degrades with it, which is the tell: the
// copies crowd out the dims the intercept has to be read from. Matched on wall
// clock instead, where three frames also cost 1.64x a step, it is worse again
// (13.64 and 10.40). Settled in both directions.
var HLAG = [];
var FRAME = MODE === 'lead' ? LEADN
  : MODE === 'extrap' ? RAWN + 2 * LOOK.length
  : MODE === 'polar' ? RAWN + 3 * LOOK.length
  : MODE === 'rays' ? RAYN
  : RAWN;
var NOBS = FRAME * (1 + HLAG.length);
var HMAX = HLAG.length ? Math.max.apply(null, HLAG) + 1 : 0;

var OBS_SWAP = [];
if (MODE === 'rays') {
  for (var rs = 1; rs < NRAY; rs += 2) {
    for (var rc = 0; rc < RAYCH; rc++) {
      OBS_SWAP.push([RAYBASE + rs * RAYCH + rc, RAYBASE + (rs + 1) * RAYCH + rc]);
    }
  }
}

var OBS_FLIP = MODE === 'lead'
  ? (function () {
      var f = [1, 3, 7, 9, 11, 15, 19, 21], i;
      for (i = 0; i < C.NSEE; i++) f.push(25 + i * 3 + 1);
      return f;
    })()
  : MODE === 'rays'
  ? (function () {
      var f = [1, 5], i, b = RAYBASE + NRAY * RAYCH;
      for (i = 0; i < NBUL; i++) f.push(b + i * 4 + 1, b + i * 4 + 3);
      return f;
    })()
  : (function () {
      var f = [1, 5, 8, 10, 12], i;
      for (i = 0; i < NBUL; i++) { f.push(14 + i * 4 + 1, 14 + i * 4 + 3); }
      for (i = 0; i < C.NROCK; i++) f.push(22 + i * 3 + 1);
      if (PROF) f.push(RAWBASE + 2);
      if (MODE === 'extrap') for (i = 0; i < LOOK.length; i++) f.push(RAWN + i * 2 + 1);
      if (MODE === 'polar') for (i = 0; i < LOOK.length; i++) f.push(RAWN + i * 3 + 1);
      return f;
    })();

if (HLAG.length) {
  (function () {
    var f0 = OBS_FLIP.slice(), s0 = OBS_SWAP.slice(), i, j, off;
    for (i = 0; i < HLAG.length; i++) {
      off = FRAME * (1 + i);
      for (j = 0; j < f0.length; j++) OBS_FLIP.push(f0[j] + off);
      for (j = 0; j < s0.length; j++) OBS_SWAP.push([s0[j][0] + off, s0[j][1] + off]);
    }
  })();
}

function mirrorObs(src, off, dst) {
  var k, i0, i1, t;
  for (k = 0; k < NOBS; k++) dst[k] = src[off + k];
  for (k = 0; k < OBS_FLIP.length; k++) dst[OBS_FLIP[k]] = -dst[OBS_FLIP[k]];
  for (k = 0; k < OBS_SWAP.length; k++) {
    i0 = OBS_SWAP[k][0]; i1 = OBS_SWAP[k][1];
    t = dst[i0]; dst[i0] = dst[i1]; dst[i1] = t;
  }
}
function mirrorAct(a) { var t = a % NT; return a - t + (NT - 1 - t); }

var R = {
  HIT: 2.0,
  GOT: -1.5,
  FIRE: -0.04,       // small on purpose. At -0.3 the agent stops firing before
                     // it ever learns to aim and the value function collapses.
  // With a 1.6s reload the gun is available about 4% of the time, so hits are a
  // sparse signal and holding the nose on the lead point is most of the skill.
  // These two carry that. Measured at 15k gradient steps: .010/.25 gave 5 hits
  // per minute, .04/.60 gives 14.5. Going further (.09, .18) makes it worse -
  // the agent starts farming the aim term instead of shooting.
  SHOTQ: 0.60, SHOTS: 0.18,
  AIM: 0.040, AIM_DECAY_S: 30, AIM_FLOOR: 0.15,
  // Potential-based shaping is provably policy-invariant, which is the nicer
  // property, but measured against it the raw per-step form learns about 30%
  // faster and learning speed is the hard requirement here. The reward
  // decomposition chart is the audit instead.
  POT: 0,            // 1 = shaping enters as gamma*PHI(s')-PHI(s), 0 = raw per-step
  DANGER: -0.05,
  RANGE: -0.06, RANGE_RAW: -0.08,
  LIVE: -0.002, LIVE_RAMP_S: 15, LIVE_MAX: -0.010,
  DRAW: -0.40,
  GAMMA: 0.97
};

function rng(seed) {
  var a = seed >>> 0, b = (seed ^ 0x9e3779b9) >>> 0, c = (seed ^ 0x85ebca6b) >>> 0, d = (seed ^ 0xc2b2ae35) >>> 0;
  for (var i = 0; i < 12; i++) { var t0 = (a + b | 0) + d | 0; d = d + 1 | 0; a = b ^ b >>> 9; b = c + (c << 3) | 0; c = c << 21 | c >>> 11; c = c + t0 | 0; }
  return function () {
    a |= 0; b |= 0; c |= 0; d |= 0;
    var t = (a + b | 0) + d | 0; d = d + 1 | 0;
    a = b ^ b >>> 9; b = c + (c << 3) | 0; c = c << 21 | c >>> 11; c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
}

function dwrap(d, L) { return d - L * Math.round(d / L); }
function wrapPi(a) { return a - 6.283185307179586 * Math.round(a / 6.283185307179586); }

function Ship() { this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.a = 0; this.cd = 0; this.inv = 0; }

function Pool(cap) {
  this.n = 0; this.cap = cap;
  this.x = new Float64Array(cap); this.y = new Float64Array(cap);
  this.vx = new Float64Array(cap); this.vy = new Float64Array(cap);
  this.t = new Float64Array(cap); this.src = new Int32Array(cap);
}
Pool.prototype.add = function (x, y, vx, vy, src) {
  if (this.n >= this.cap) return;
  var i = this.n++;
  this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy; this.t[i] = C.BTTL; this.src[i] = src;
};
Pool.prototype.rm = function (i) {
  var j = --this.n;
  this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.vx[i] = this.vx[j];
  this.vy[i] = this.vy[j]; this.t[i] = this.t[j]; this.src[i] = this.src[j];
};
Pool.prototype.clear = function () { this.n = 0; };

function stepShip(s, turn, thrust, dt) {
  s.a += turn * C.ROT * dt;
  if (thrust) { s.vx += Math.cos(s.a) * C.THR * dt; s.vy += Math.sin(s.a) * C.THR * dt; }
  var k = Math.exp(-C.DRAG * dt);
  s.vx *= k; s.vy *= k;
  var sp = Math.hypot(s.vx, s.vy);
  if (sp > C.VMAX) { s.vx *= C.VMAX / sp; s.vy *= C.VMAX / sp; }
  s.x += s.vx * dt; s.y += s.vy * dt;
  s.x = (s.x % C.W + C.W) % C.W; s.y = (s.y % C.H + C.H) % C.H;
  if (s.cd > 0) s.cd -= dt;
  if (s.inv > 0) s.inv -= dt;
}
function tryFire(s, p, src) {
  if (s.cd > 0 || p.n >= C.MAXB) return false;
  var c = Math.cos(s.a), si = Math.sin(s.a);
  p.add(s.x + c * C.SR, s.y + si * C.SR, s.vx + c * C.BSPD, s.vy + si * C.BSPD, src);
  s.cd = C.BCD;
  return true;
}
function stepPool(p, dt) {
  for (var i = p.n - 1; i >= 0; i--) {
    p.t[i] -= dt;
    if (p.t[i] <= 0) { p.rm(i); continue; }
    p.x[i] += p.vx[i] * dt; p.y[i] += p.vy[i] * dt;
    p.x[i] = (p.x[i] % C.W + C.W) % C.W; p.y[i] = (p.y[i] % C.H + C.H) % C.H;
  }
}
function hitScan(p, s, dt) {
  if (s.inv > 0) return -2;
  var rr = (C.SR + C.BR) * (C.SR + C.BR);
  for (var i = p.n - 1; i >= 0; i--) {
    var ex = dwrap(p.x[i] - s.x, C.W), ey = dwrap(p.y[i] - s.y, C.H);
    var sx = ex - p.vx[i] * dt, sy = ey - p.vy[i] * dt;
    var dx = ex - sx, dy = ey - sy, L2 = dx * dx + dy * dy, u = 0;
    if (L2 > 1e-9) { u = -(sx * dx + sy * dy) / L2; u = u < 0 ? 0 : (u > 1 ? 1 : u); }
    var cx = sx + dx * u, cy = sy + dy * u;
    if (cx * cx + cy * cy < rr) { var sc = p.src[i]; p.rm(i); return sc; }
  }
  return -2;
}

function intercept(px, py, vx, vy, sp) {
  var a = vx * vx + vy * vy - sp * sp, b = 2 * (px * vx + py * vy), c = px * px + py * py, t;
  if (Math.abs(a) < 1e-6) { t = Math.abs(b) < 1e-9 ? 0 : -c / b; }
  else {
    var d = b * b - 4 * a * c;
    if (d < 0) return -1;
    d = Math.sqrt(d);
    var t1 = (-b - d) / (2 * a), t2 = (-b + d) / (2 * a);
    t = Math.min(t1, t2);
    if (t < 0) t = Math.max(t1, t2);
  }
  return t > 0 ? t : -1;
}

function rayBlocked(rocks, ux, uy, maxd) {
  for (var i = 0; i < rocks.length; i++) {
    var R = rocks[i], t = R.qx * ux + R.qy * uy;
    if (t < 0 || t > maxd) continue;
    var px = R.qx - ux * t, py = R.qy - uy * t;
    if (px * px + py * py < (R.r + C.BR) * (R.r + C.BR)) return 1;
  }
  return 0;
}

function Rock() { this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.r = 0; this.qx = 0; this.qy = 0; this.clr = 0; this.seed = 0; }

function World() {
  this.a = new Ship(); this.b = new Ship();
  this.pa = new Pool(C.MAXB + 2); this.pb = new Pool(C.MAXB + 2);
  this.rocks = [];
  for (var i = 0; i < C.NROCK; i++) this.rocks.push(new Rock());
  this.step = 0; this.roundT = 0; this.round = 0;
  this.roundMax = C.ROUND_STEPS;
  this.lead = [0, 0]; this.threat = [0, 0]; this.dist = 0; this.tHit = [0, 0];
  this.blocked = 0;
  this.rel = [0, 0, 0, 0];
  this.hist = HMAX ? new Float32Array(2 * HMAX * FRAME) : null;
  this.hn = 0;
  this.prof = PROF ? new Float32Array(2 * NPROF) : null;
  this.profMem = PROF ? new Float32Array(2 * 3) : null;
  this.profN = [0, 0];
  this._st = { tA: 0, thA: 0, tB: 0, thB: 0, leadA: 0, phi0: 0, thr0: 0, sub: 0 };
}
World.prototype.reset = function (rand) {
  var A = this.a, B = this.b;
  A.x = rand() * C.W; A.y = rand() * C.H; A.a = rand() * 6.283185307179586;
  A.vx = 0; A.vy = 0; A.cd = 0; A.inv = C.INV;
  do {
    B.x = rand() * C.W; B.y = rand() * C.H;
  } while (Math.hypot(dwrap(B.x - A.x, C.W), dwrap(B.y - A.y, C.H)) < 260);
  B.a = rand() * 6.283185307179586; B.vx = 0; B.vy = 0; B.cd = 0; B.inv = C.INV;
  this.pa.clear(); this.pb.clear();
  for (var i = 0; i < this.rocks.length; i++) {
    var R = this.rocks[i], tries = 0;
    R.r = C.RMIN + rand() * (C.RMAX - C.RMIN);
    R.seed = (rand() * 1e6) | 0;
    do {
      R.x = rand() * C.W; R.y = rand() * C.H; tries++;
    } while (tries < 24 && (this.clearOf(R, A) || this.clearOf(R, B)));
    var ang = rand() * 6.283185307179586, sp = C.RSPD * (0.35 + rand() * 0.65);
    R.vx = Math.cos(ang) * sp; R.vy = Math.sin(ang) * sp;
  }
  this.roundT = 0; this.round++;
  this.hn = 0;
  if (this.prof) { this.prof.fill(0); this.profMem.fill(0); this.profN[0] = 0; this.profN[1] = 0; }
  this.observe(0, SCRATCH, 0); this.observe(1, SCRATCH, 0);
};

World.prototype.clearOf = function (R, s) {
  var d = Math.hypot(dwrap(R.x - s.x, C.W), dwrap(R.y - s.y, C.H));
  return d < R.r + C.SR * 5;
};

World.prototype.stepRocks = function (dt) {
  for (var i = 0; i < this.rocks.length; i++) {
    var R = this.rocks[i];
    R.x += R.vx * dt; R.y += R.vy * dt;
    R.x = (R.x % C.W + C.W) % C.W; R.y = (R.y % C.H + C.H) % C.H;
  }
};

World.prototype.shove = function (s) {
  for (var i = 0; i < this.rocks.length; i++) {
    var R = this.rocks[i];
    var dx = dwrap(s.x - R.x, C.W), dy = dwrap(s.y - R.y, C.H);
    var d = Math.hypot(dx, dy), hit = R.r + C.SR;
    if (d >= hit || d < 1e-6) continue;
    var nx = dx / d, ny = dy / d;
    s.x = R.x + nx * hit; s.y = R.y + ny * hit;
    s.x = (s.x % C.W + C.W) % C.W; s.y = (s.y % C.H + C.H) % C.H;
    var vn = s.vx * nx + s.vy * ny;
    if (vn < 0) { s.vx -= (1 + C.BOUNCE) * vn * nx; s.vy -= (1 + C.BOUNCE) * vn * ny; }
    s.vx += nx * C.SHOVE * 0.02; s.vy += ny * C.SHOVE * 0.02;
  }
};

World.prototype.chip = function (p) {
  for (var i = p.n - 1; i >= 0; i--) {
    for (var j = 0; j < this.rocks.length; j++) {
      var R = this.rocks[j];
      var dx = dwrap(p.x[i] - R.x, C.W), dy = dwrap(p.y[i] - R.y, C.H);
      if (dx * dx + dy * dy < (R.r + C.BR) * (R.r + C.BR)) { p.rm(i); break; }
    }
  }
};

World.prototype.observeRaw = function (who, o, oo) {
  var self = who ? this.b : this.a, opp = who ? this.a : this.b, inb = who ? this.pa : this.pb;
  var ca = Math.cos(self.a), sa = Math.sin(self.a), i;

  o[oo] = (self.vx * ca + self.vy * sa) / C.VMAX;
  o[oo + 1] = (-self.vx * sa + self.vy * ca) / C.VMAX;
  o[oo + 2] = Math.hypot(self.vx, self.vy) / C.VMAX;
  o[oo + 3] = self.cd / C.BCD;

  var px = dwrap(opp.x - self.x, C.W), py = dwrap(opp.y - self.y, C.H), d = Math.hypot(px, py);
  o[oo + 4] = (px * ca + py * sa) / C.RD;
  o[oo + 5] = (-px * sa + py * ca) / C.RD;
  o[oo + 6] = d / C.RD;
  var rvx = opp.vx - self.vx, rvy = opp.vy - self.vy;
  o[oo + 7] = (rvx * ca + rvy * sa) / C.RELV;
  o[oo + 8] = (-rvx * sa + rvy * ca) / C.RELV;
  var br = wrapPi(Math.atan2(py, px) - self.a);
  o[oo + 9] = Math.cos(br); o[oo + 10] = Math.sin(br);
  var hb = wrapPi(opp.a - self.a);
  o[oo + 11] = Math.cos(hb); o[oo + 12] = Math.sin(hb);
  o[oo + 13] = opp.inv > 0 ? 1 : 0;

  var ord = SORT_B, nb = 0;
  for (i = 0; i < inb.n; i++) {
    var qx = dwrap(inb.x[i] - self.x, C.W), qy = dwrap(inb.y[i] - self.y, C.H);
    ord[nb * 3] = qx * qx + qy * qy; ord[nb * 3 + 1] = qx; ord[nb * 3 + 2] = qy;
    BIDX[nb] = i; nb++;
  }
  for (i = 1; i < nb; i++) {
    for (var j = i; j > 0 && ord[j * 3] < ord[(j - 1) * 3]; j--) {
      swap3(ord, j, j - 1); var t0 = BIDX[j]; BIDX[j] = BIDX[j - 1]; BIDX[j - 1] = t0;
    }
  }
  for (i = 0; i < NBUL; i++) {
    var b = oo + 14 + i * 4;
    if (i < nb) {
      var k = BIDX[i], bx = ord[i * 3 + 1], by = ord[i * 3 + 2];
      var wx = inb.vx[k] - self.vx, wy = inb.vy[k] - self.vy;
      o[b] = (bx * ca + by * sa) / C.RD;
      o[b + 1] = (-bx * sa + by * ca) / C.RD;
      o[b + 2] = (wx * ca + wy * sa) / C.RVMAX;
      o[b + 3] = (-wx * sa + wy * ca) / C.RVMAX;
    } else { o[b] = 0; o[b + 1] = 0; o[b + 2] = 0; o[b + 3] = 0; }
  }

  for (i = 0; i < this.rocks.length; i++) {
    var R = this.rocks[i], s = oo + 22 + i * 3;
    R.qx = dwrap(R.x - self.x, C.W); R.qy = dwrap(R.y - self.y, C.H);
    o[s] = (R.qx * ca + R.qy * sa) / C.RD;
    o[s + 1] = (-R.qx * sa + R.qy * ca) / C.RD;
    o[s + 2] = R.r / C.RMAX;
  }

  if (MODE === 'extrap' || MODE === 'polar') {
    for (i = 0; i < LOOK.length; i++) {
      var nrm = C.RD + C.RELV * LOOK[i];
      var fx = px + rvx * LOOK[i], fy = py + rvy * LOOK[i];
      var ff = fx * ca + fy * sa, fr = -fx * sa + fy * ca, fd = Math.hypot(ff, fr);
      if (MODE === 'extrap') {
        var e = oo + RAWN + i * 2;
        o[e] = ff / nrm; o[e + 1] = fr / nrm;
      } else {
        var e2 = oo + RAWN + i * 3;
        o[e2] = fd > 1e-6 ? ff / fd : 1;
        o[e2 + 1] = fd > 1e-6 ? fr / fd : 0;
        o[e2 + 2] = fd / nrm;
      }
    }
  }

  var t = intercept(px, py, rvx, rvy, C.BSPD);
  this.lead[who] = t > 0 ? wrapPi(Math.atan2(py + rvy * t, px + rvx * t) - self.a) : br;
  this.tHit[who] = t;
  var thr = 0, minMiss = 1e9;
  for (i = 0; i < inb.n; i++) {
    var ux = dwrap(inb.x[i] - self.x, C.W), uy = dwrap(inb.y[i] - self.y, C.H);
    var ex = inb.vx[i] - self.vx, ey = inb.vy[i] - self.vy, vv = ex * ex + ey * ey;
    if (vv < 1e-6) continue;
    var tca = -(ux * ex + uy * ey) / vv;
    if (tca < 0) tca = 0; if (tca > C.BTTL) tca = C.BTTL;
    var miss = Math.hypot(ux + ex * tca, uy + ey * tca);
    if (miss < minMiss) minMiss = miss;
    var sc = Math.exp(-miss / 45) * Math.exp(-tca / 0.7);
    if (sc > thr) thr = sc;
  }
  if (minMiss > 1e8) minMiss = 1e9;
  this.threat[who] = thr;
  this.rel[who * 2] = (px * ca + py * sa) / C.RD;
  this.rel[who * 2 + 1] = (-px * sa + py * ca) / C.RD;

  var bd = Math.hypot(px, py);
  o[oo + RAWBASE - 3] = bd > 1e-6 ? rayBlocked(this.rocks, px / bd, py / bd, bd) : 0;
  o[oo + RAWBASE - 2] = thr;
  o[oo + RAWBASE - 1] = Math.min(1, minMiss / 150);

  if (PROF) {
    for (i = 0; i < NPROF; i++) o[oo + RAWBASE + i] = this.prof[who * NPROF + i];
  }

  if (!who) {
    this.dist = d;
    var ax = px + (t > 0 ? rvx * t : 0), ay = py + (t > 0 ? rvy * t : 0), ad = Math.hypot(ax, ay);
    this.blocked = ad > 1e-6 ? rayBlocked(this.rocks, ax / ad, ay / ad, ad) : 0;
  }
  return thr;
};

var SORT_B = new Float64Array(64 * 3), BIDX = new Int32Array(64), RIDX = new Int32Array(64);
function swap3(a, i, j) {
  for (var k = 0; k < 3; k++) { var t = a[i * 3 + k]; a[i * 3 + k] = a[j * 3 + k]; a[j * 3 + k] = t; }
}

function rayHit(qx, qy, r, ux, uy) {
  var t = qx * ux + qy * uy;
  if (t < -r) return -1;
  var px = qx - ux * t, py = qy - uy * t;
  var d2 = px * px + py * py, rr = r * r;
  if (d2 > rr) return -1;
  var back = Math.sqrt(rr - d2), hit = t - back;
  return hit < 0 ? 0 : hit;
}

World.prototype.observeRays = function (who, o, oo) {
  var self = who ? this.b : this.a, opp = who ? this.a : this.b, inb = who ? this.pa : this.pb;
  var ca = Math.cos(self.a), sa = Math.sin(self.a), i, k;

  o[oo] = (self.vx * ca + self.vy * sa) / C.VMAX;
  o[oo + 1] = (-self.vx * sa + self.vy * ca) / C.VMAX;
  o[oo + 2] = Math.hypot(self.vx, self.vy) / C.VMAX;
  o[oo + 3] = self.cd / C.BCD;
  var rvx = opp.vx - self.vx, rvy = opp.vy - self.vy;
  o[oo + 4] = (rvx * ca + rvy * sa) / C.RELV;
  o[oo + 5] = (-rvx * sa + rvy * ca) / C.RELV;
  o[oo + 6] = opp.inv > 0 ? 1 : 0;

  var px = dwrap(opp.x - self.x, C.W), py = dwrap(opp.y - self.y, C.H), d = Math.hypot(px, py);
  for (i = 0; i < this.rocks.length; i++) {
    var Rk = this.rocks[i];
    Rk.qx = dwrap(Rk.x - self.x, C.W); Rk.qy = dwrap(Rk.y - self.y, C.H);
  }
  for (k = 0; k < NRAY; k++) {
    var ang = self.a + RAY[k], ux = Math.cos(ang), uy = Math.sin(ang);
    var near = -1;
    for (i = 0; i < this.rocks.length; i++) {
      var R2 = this.rocks[i];
      var h = rayHit(R2.qx, R2.qy, R2.r, ux, uy);
      if (h >= 0 && (near < 0 || h < near)) near = h;
    }
    var ho = rayHit(px, py, C.SR, ux, uy);
    var b = oo + RAYBASE + k * RAYCH;
    o[b] = near < 0 ? 0 : Math.max(0, 1 - near / C.RD);
    o[b + 1] = ho < 0 ? 0 : Math.max(0, 1 - ho / C.RD);
  }

  var bb = oo + RAYBASE + NRAY * RAYCH;
  var ord = SORT_B, nb = 0;
  for (i = 0; i < inb.n; i++) {
    var qx = dwrap(inb.x[i] - self.x, C.W), qy = dwrap(inb.y[i] - self.y, C.H);
    ord[nb * 3] = qx * qx + qy * qy; ord[nb * 3 + 1] = qx; ord[nb * 3 + 2] = qy;
    BIDX[nb] = i; nb++;
  }
  for (i = 1; i < nb; i++) {
    for (var j = i; j > 0 && ord[j * 3] < ord[(j - 1) * 3]; j--) {
      swap3(ord, j, j - 1); var t0 = BIDX[j]; BIDX[j] = BIDX[j - 1]; BIDX[j - 1] = t0;
    }
  }
  var thr = 0, minMiss = 1e9;
  for (i = 0; i < NBUL; i++) {
    var e = bb + i * 4;
    if (i < nb) {
      var kk = BIDX[i], bx = ord[i * 3 + 1], by = ord[i * 3 + 2];
      var wx = inb.vx[kk] - self.vx, wy = inb.vy[kk] - self.vy;
      o[e] = (bx * ca + by * sa) / C.RD;
      o[e + 1] = (-bx * sa + by * ca) / C.RD;
      o[e + 2] = (wx * ca + wy * sa) / C.RVMAX;
      o[e + 3] = (-wx * sa + wy * ca) / C.RVMAX;
    } else { o[e] = 0; o[e + 1] = 0; o[e + 2] = 0; o[e + 3] = 0; }
  }
  for (i = 0; i < inb.n; i++) {
    var ux2 = dwrap(inb.x[i] - self.x, C.W), uy2 = dwrap(inb.y[i] - self.y, C.H);
    var ex = inb.vx[i] - self.vx, ey = inb.vy[i] - self.vy, vv = ex * ex + ey * ey;
    if (vv < 1e-6) continue;
    var tca = -(ux2 * ex + uy2 * ey) / vv;
    if (tca < 0) tca = 0; if (tca > C.BTTL) tca = C.BTTL;
    var miss = Math.hypot(ux2 + ex * tca, uy2 + ey * tca);
    if (miss < minMiss) minMiss = miss;
    var sc = Math.exp(-miss / 45) * Math.exp(-tca / 0.7);
    if (sc > thr) thr = sc;
  }
  if (minMiss > 1e8) minMiss = 1e9;
  var t = intercept(px, py, rvx, rvy, C.BSPD);
  var ax = px + (t > 0 ? rvx * t : 0), ay = py + (t > 0 ? rvy * t : 0), ad = Math.hypot(ax, ay);
  var blk = ad > 1e-6 ? rayBlocked(this.rocks, ax / ad, ay / ad, ad) : 0;
  o[bb + NBUL * 4] = blk;
  o[bb + NBUL * 4 + 1] = thr;
  o[bb + NBUL * 4 + 2] = Math.min(1, minMiss / 150);

  this.lead[who] = t > 0 ? wrapPi(Math.atan2(ay, ax) - self.a) : wrapPi(Math.atan2(py, px) - self.a);
  this.tHit[who] = t;
  this.threat[who] = thr;
  this.rel[who * 2] = (px * ca + py * sa) / C.RD;
  this.rel[who * 2 + 1] = (-px * sa + py * ca) / C.RD;
  if (!who) { this.dist = d; this.blocked = blk; }
  return thr;
};

World.prototype.observeLead = function (who, o, oo) {
  var self = who ? this.b : this.a, opp = who ? this.a : this.b, inb = who ? this.pa : this.pb;
  var ca = Math.cos(self.a), sa = Math.sin(self.a);
  o[oo] = (self.vx * ca + self.vy * sa) / C.VMAX;
  o[oo + 1] = (-self.vx * sa + self.vy * ca) / C.VMAX;
  var px = dwrap(opp.x - self.x, C.W), py = dwrap(opp.y - self.y, C.H), d = Math.hypot(px, py);
  o[oo + 2] = (px * ca + py * sa) / C.RD;
  o[oo + 3] = (-px * sa + py * ca) / C.RD;
  o[oo + 4] = d / C.RD;
  o[oo + 5] = 1 / (1 + d / 200);
  var rvx = opp.vx - self.vx, rvy = opp.vy - self.vy;
  o[oo + 6] = (rvx * ca + rvy * sa) / C.RELV;
  o[oo + 7] = (-rvx * sa + rvy * ca) / C.RELV;
  var br = wrapPi(Math.atan2(py, px) - self.a);
  o[oo + 8] = Math.cos(br); o[oo + 9] = Math.sin(br);
  var t = intercept(px, py, rvx, rvy, C.BSPD), le = br, tt = 0;
  if (t > 0) { le = wrapPi(Math.atan2(py + rvy * t, px + rvx * t) - self.a); tt = Math.min(1, t); }
  o[oo + 10] = Math.cos(le); o[oo + 11] = Math.sin(le);
  o[oo + 12] = tt; o[oo + 13] = t > 0 ? 1 : 0;
  var hb = wrapPi(opp.a - self.a);
  o[oo + 14] = Math.cos(hb); o[oo + 15] = Math.sin(hb);
  o[oo + 16] = self.cd / C.BCD;
  o[oo + 17] = Math.hypot(self.vx, self.vy) / C.VMAX;
  var bs = 0, best = -1, bmiss = 0, bpx = 0, bpy = 0, bvx = 0, bvy = 0;
  for (var i = 0; i < inb.n; i++) {
    var qx = dwrap(inb.x[i] - self.x, C.W), qy = dwrap(inb.y[i] - self.y, C.H);
    var wx = inb.vx[i] - self.vx, wy = inb.vy[i] - self.vy, vv = wx * wx + wy * wy;
    if (vv < 1e-6) continue;
    var tca = -(qx * wx + qy * wy) / vv;
    if (tca < 0) tca = 0;
    if (tca > C.BTTL) tca = C.BTTL;
    var miss = Math.hypot(qx + wx * tca, qy + wy * tca);
    var sc = Math.exp(-miss / 45) * Math.exp(-tca / 0.7);
    if (sc > bs) { bs = sc; best = i; bmiss = miss; bpx = qx; bpy = qy; bvx = wx; bvy = wy; }
  }
  if (best >= 0) {
    o[oo + 18] = (bpx * ca + bpy * sa) / C.RD; o[oo + 19] = (-bpx * sa + bpy * ca) / C.RD;
    o[oo + 20] = (bvx * ca + bvy * sa) / C.RVMAX; o[oo + 21] = (-bvx * sa + bvy * ca) / C.RVMAX;
    o[oo + 22] = Math.min(1, bmiss / 150); o[oo + 23] = bs;
  } else {
    o[oo + 18] = 0; o[oo + 19] = 0; o[oo + 20] = 0; o[oo + 21] = 0; o[oo + 22] = 1; o[oo + 23] = 0;
  }
  // Without this the agent spends the first second of every round firing at a
  // target that cannot be hit, with no way to tell why nothing lands. Measured
  // at roughly a 60% hit to learning speed.
  o[oo + 24] = opp.inv > 0 ? 1 : 0;

  // The NSEE closest rocks, nearest first. Describing all of them cost more in
  // diluted input than it bought in awareness - measured, see NSEE.
  for (i = 0; i < this.rocks.length; i++) {
    var Rk = this.rocks[i];
    Rk.qx = dwrap(Rk.x - self.x, C.W); Rk.qy = dwrap(Rk.y - self.y, C.H);
    Rk.clr = Math.hypot(Rk.qx, Rk.qy) - Rk.r;
    RIDX[i] = i;
  }
  for (i = 1; i < this.rocks.length; i++) {
    for (var jj = i; jj > 0 && this.rocks[RIDX[jj]].clr < this.rocks[RIDX[jj - 1]].clr; jj--) {
      var tt = RIDX[jj]; RIDX[jj] = RIDX[jj - 1]; RIDX[jj - 1] = tt;
    }
  }
  for (i = 0; i < C.NSEE; i++) {
    var rs = oo + 25 + i * 3;
    if (i < this.rocks.length) {
      var Rn = this.rocks[RIDX[i]];
      o[rs] = (Rn.qx * ca + Rn.qy * sa) / C.RD;
      o[rs + 1] = (-Rn.qx * sa + Rn.qy * ca) / C.RD;
      o[rs + 2] = 1 / (1 + Math.max(0, Rn.clr) / 120);
    } else { o[rs] = 0; o[rs + 1] = 0; o[rs + 2] = 0; }
  }
  var aimx = px + (t > 0 ? rvx * t : 0), aimy = py + (t > 0 ? rvy * t : 0);
  var ad = Math.hypot(aimx, aimy);
  o[oo + LEADN - 1] = ad > 1e-6 ? rayBlocked(this.rocks, aimx / ad, aimy / ad, ad) : 0;
  this.blocked = o[oo + LEADN - 1];
  this.lead[who] = le; this.threat[who] = bs; this.tHit[who] = t;
  this.rel[who * 2] = (px * ca + py * sa) / C.RD;
  this.rel[who * 2 + 1] = (-px * sa + py * ca) / C.RD;
  if (!who) this.dist = d;
  return bs;
};

World.prototype.potential = function (who) {
  var d = this.dist;
  return R.DANGER * this.threat[who] + R.RANGE * Math.min(1, Math.abs(d - C.DOPT) / 400);
};

function decode(a) { return { turn: actTurn(a), thrust: actThrust(a), fire: actFire(a) }; }

function nActions(w, who) {
  return (who ? w.b : w.a).cd > 0 ? NACT / 2 : NACT;
}
var NT = TURNS.length;
function actTurn(a) { return TURNS[a % NT]; }
function actThrust(a) { return ((a / NT) | 0) % 2; }
function actFire(a) { return (a / (NT * 2)) | 0; }
var TMID = (NT - 1) >> 1;
function encode(turn, thrust, fire) { return (turn + TMID) + NT * thrust + NT * 2 * fire; }

var SCRATCH = new Float32Array(NOBS);
var HSCRATCH = new Float32Array(FRAME);

function Ev() {
  this.rc = new Float32Array(NRC);
  this.r = 0; this.hitSrc = -2; this.gotHit = 0; this.fired = 0; this.done = 0; this.draw = 0;
}

World.prototype.beginStep = function (actA, actB, ev) {
  var rc = ev.rc, i;
  for (i = 0; i < NRC; i++) rc[i] = 0;
  ev.hitSrc = -2; ev.gotHit = 0; ev.fired = 0; ev.done = 0; ev.draw = 0;

  var s = this._st;
  s.leadA = this.lead[0]; s.phi0 = this.potential(0); s.thr0 = this.threat[0];
  s.tA = actTurn(actA); s.thA = actThrust(actA);
  s.tB = actTurn(actB); s.thB = actThrust(actB);
  s.sub = 0;

  if (actFire(actA) && tryFire(this.a, this.pa, this.step)) {
    ev.fired = 1;
    rc[2] += R.FIRE;
    rc[3] += R.SHOTQ * Math.exp(-s.leadA * s.leadA / (2 * R.SHOTS * R.SHOTS));
  }
  if (actFire(actB)) tryFire(this.b, this.pb, -1);
};

World.prototype.tickOnce = function (ev) {
  var s = this._st;
  stepShip(this.a, s.tA, s.thA, C.DT);
  stepShip(this.b, s.tB, s.thB, C.DT);
  this.stepRocks(C.DT);
  this.shove(this.a);
  this.shove(this.b);
  stepPool(this.pa, C.DT);
  stepPool(this.pb, C.DT);
  this.chip(this.pa);
  this.chip(this.pb);
  var hb = hitScan(this.pa, this.b, C.DT);
  if (hb !== -2) ev.hitSrc = hb;
  var ha = hitScan(this.pb, this.a, C.DT);
  if (ha !== -2) ev.gotHit = 1;
  s.sub++;
  return (ev.hitSrc !== -2 || ev.gotHit) ? 1 : 0;
};

World.prototype.endStep = function (ev, tSec) {
  var rc = ev.rc, i, s = this._st;
  var leadA = s.leadA, phi0 = s.phi0, thr0 = s.thr0;

  if (ev.gotHit) rc[1] += R.GOT;
  var aimK = R.AIM * Math.max(R.AIM_FLOOR, 1 - (tSec || 0) / R.AIM_DECAY_S);
  var cl = Math.cos(leadA);
  if (cl > 0) rc[4] += aimK * cl * cl * cl * cl;

  this.pushProf();
  this.observe(0, SCRATCH, 0);
  this.observe(1, SCRATCH, 0);
  this.pushHist();
  if (R.POT) {
    var shaped = R.GAMMA * this.potential(0) - phi0;
    rc[5] += shaped * 0.5; rc[6] += shaped * 0.5;
  } else {
    rc[5] += R.DANGER * thr0;
    rc[6] += R.RANGE_RAW * Math.min(1, Math.abs(this.dist - C.DOPT) / 400);
  }

  var live = R.LIVE + (R.LIVE_MAX - R.LIVE) * Math.min(1, (this.roundT * C.CDT) / R.LIVE_RAMP_S);
  rc[7] += live;

  this.step++; this.roundT++;
  if (ev.hitSrc !== -2 || ev.gotHit) ev.done = 1;
  else if (this.roundT >= this.roundMax) { ev.done = 1; ev.draw = 1; rc[7] += R.DRAW; }

  var sum = 0;
  for (i = 0; i < NRC; i++) sum += rc[i];
  ev.r = sum;
  return ev;
};

World.prototype.advance = function (actA, actB, ev, tSec) {
  this.beginStep(actA, actB, ev);
  for (var sub = 0; sub < C.REPEAT; sub++) if (this.tickOnce(ev)) break;
  return this.endStep(ev, tSec);
};

World.prototype.observeFrame = MODE === 'lead' ? World.prototype.observeLead
  : MODE === 'rays' ? World.prototype.observeRays
  : World.prototype.observeRaw;

World.prototype.observe = !HLAG.length ? World.prototype.observeFrame : function (who, o, oo) {
  var r = this.observeFrame(who, o, oo), i, k, base, slot;
  for (i = 0; i < HLAG.length; i++) {
    base = oo + FRAME * (1 + i);
    if (this.hn > HLAG[i]) {
      slot = (this.hn - 1 - HLAG[i]) % HMAX;
      for (k = 0; k < FRAME; k++) o[base + k] = this.hist[(who * HMAX + slot) * FRAME + k];
    } else {
      for (k = 0; k < FRAME; k++) o[base + k] = 0;
    }
  }
  return r;
};

World.prototype.pushProf = function () {
  if (!this.prof) return;
  var p = this.prof, m = this.profMem, who;
  for (who = 0; who < 2; who++) {
    var self = who ? this.b : this.a, opp = who ? this.a : this.b;
    var o = who * NPROF, mo = who * 3, seen = this.profN[who];
    var dx = dwrap(opp.x - self.x, C.W), dy = dwrap(opp.y - self.y, C.H);
    var d = Math.hypot(dx, dy), bear = Math.atan2(dy, dx);
    var sp = Math.hypot(opp.vx, opp.vy) / C.VMAX;
    var swing = seen ? wrapPi(bear - m[mo]) / C.CDT / 3 : 0;
    var turn = seen ? Math.abs(wrapPi(opp.a - m[mo + 1])) / C.CDT / C.ROT : 0;
    var shot = seen && opp.cd > m[mo + 2] ? 1 : 0;
    m[mo] = bear; m[mo + 1] = opp.a; m[mo + 2] = opp.cd;
    if (swing > 1) swing = 1; else if (swing < -1) swing = -1;
    if (turn > 1) turn = 1;
    p[o] += (sp - p[o]) * 0.15;
    p[o + 1] += (sp - p[o + 1]) * 0.02;
    p[o + 2] += (swing - p[o + 2]) * 0.02;
    p[o + 3] += (d / C.RD - p[o + 3]) * 0.02;
    p[o + 4] += (turn - p[o + 4]) * 0.02;
    p[o + 5] += (shot - p[o + 5]) * 0.02;
    this.profN[who] = seen + 1;
  }
};

World.prototype.pushHist = function () {
  if (!this.hist) return;
  var slot = this.hn % HMAX, who, k;
  for (who = 0; who < 2; who++) {
    this.observeFrame(who, HSCRATCH, 0);
    for (k = 0; k < FRAME; k++) this.hist[(who * HMAX + slot) * FRAME + k] = HSCRATCH[k];
  }
  this.hn++;
};

function scripted(w, who, rand, skill) {
  var k = skill === undefined ? 1 : skill;
  var le = w.lead[who], thr = w.threat[who];
  var turn = 0, thrust = 0, f = 0;
  if (thr > 0.28) {
    turn = rand() < 0.5 ? -1 : 1;
    thrust = 1;
    if (rand() < 0.25) f = 1;
  } else {
    turn = le > 0.06 ? 1 : (le < -0.06 ? -1 : 0);
    thrust = (w.dist > C.RD * 0.30 || rand() < 0.18) ? 1 : 0;
    if (Math.abs(le) < 0.18 * (2 - k) && rand() < 0.8 * k) f = 1;
  }
  if (rand() < 0.07 * (2 - k)) turn = (rand() * 3 | 0) - 1;
  return encode(turn, thrust, f);
}

root.LC = {
  C: C, R: R, NOBS: NOBS, NACT: NACT, NRC: NRC, MODE: MODE, OBS_FLIP: OBS_FLIP, NBUL: NBUL,
  FRAME: FRAME, HLAG: HLAG,
  OBS_OPP: MODE === 'rays' ? 4 : 4,
  OBS_SWAP: OBS_SWAP,

  RC_NAMES: ['hit', 'got hit', 'shot cost', 'shot aim', 'aim', 'danger', 'range', 'living'],
  rng: rng, dwrap: dwrap, wrapPi: wrapPi, intercept: intercept, rayBlocked: rayBlocked,
  mirrorObs: mirrorObs, mirrorAct: mirrorAct,
  Ship: Ship, Pool: Pool, World: World, Ev: Ev,
  stepShip: stepShip, tryFire: tryFire, stepPool: stepPool, hitScan: hitScan,
  actTurn: actTurn, actThrust: actThrust, actFire: actFire, decode: decode, nActions: nActions,
  encode: encode, TURNS: TURNS,
  scripted: scripted
};

})(typeof self !== 'undefined' ? self : this);
