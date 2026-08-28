// The policy network. 24 -> 64 -> 64 -> dueling(V:1, A:12), ReLU, LayerNorm on
// both hidden layers. Everything lives in one flat Float32Array so the whole
// thing can be handed to the main thread as a single transferable, and nothing
// in forward/backward/Adam allocates once the net is built.
//
// LayerNorm is not decoration here. Without it the prototype showed the classic
// high-update-ratio churn: return climbs, peaks, then falls apart.
(function (root) {
'use strict';

var NAUX = 4;

function Net(NI, NH, NA) {
  this.NI = NI; this.NH = NH; this.NA = NA; this.NX = NAUX;
  var o = 0;
  this.W0 = o; o += NI * NH;
  this.b0 = o; o += NH;
  this.g1 = o; o += NH;
  this.c1 = o; o += NH;
  this.W1 = o; o += NH * NH;
  this.b1 = o; o += NH;
  this.g2 = o; o += NH;
  this.c2 = o; o += NH;
  this.Wv = o; o += NH;
  this.bv = o; o += 1;
  this.Wa = o; o += NA * NH;
  this.ba = o; o += NA;
  this.Wx = o; o += NAUX * NH;
  this.bx = o; o += NAUX;
  this.NP = o;

  this.z1 = new Float32Array(NH); this.xh1 = new Float32Array(NH); this.h1 = new Float32Array(NH);
  this.z2 = new Float32Array(NH); this.xh2 = new Float32Array(NH); this.h2 = new Float32Array(NH);
  this.sig1 = 1; this.sig2 = 1;
  this.A = new Float32Array(NA); this.q = new Float32Array(NA); this.V = 0;
  this.aux = new Float32Array(NAUX);
  this.d1 = new Float32Array(NH); this.d2 = new Float32Array(NH); this.dA = new Float32Array(NA);
  this.dX = new Float32Array(NAUX);
}

Net.prototype.init = function (rand) {
  var p = new Float32Array(this.NP), j;
  var NI = this.NI, NH = this.NH, NA = this.NA;
  var s0 = Math.sqrt(6 / (NI + NH)), s1 = Math.sqrt(6 / (NH + NH)), s2 = Math.sqrt(6 / (NH + NA));
  for (j = 0; j < NI * NH; j++) p[this.W0 + j] = (rand() * 2 - 1) * s0;
  for (j = 0; j < NH * NH; j++) p[this.W1 + j] = (rand() * 2 - 1) * s1;
  for (j = 0; j < NH; j++) p[this.Wv + j] = (rand() * 2 - 1) * s2 * 0.3;
  for (j = 0; j < NA * NH; j++) p[this.Wa + j] = (rand() * 2 - 1) * s2 * 0.3;
  for (j = 0; j < NAUX * NH; j++) p[this.Wx + j] = (rand() * 2 - 1) * Math.sqrt(6 / (NH + NAUX));
  for (j = 0; j < NH; j++) { p[this.g1 + j] = 1; p[this.g2 + j] = 1; }
  return p;
};

var EPSN = 1e-5;

Net.prototype.fwd = function (p, x, xo) {
  var NI = this.NI, NH = this.NH, NA = this.NA;
  var z1 = this.z1, xh1 = this.xh1, h1 = this.h1, z2 = this.z2, xh2 = this.xh2, h2 = this.h2;
  var i, j, s, r, m, v;

  for (i = 0; i < NH; i++) { s = p[this.b0 + i]; r = this.W0 + i * NI; for (j = 0; j < NI; j++) s += p[r + j] * x[xo + j]; z1[i] = s; }
  m = 0; for (i = 0; i < NH; i++) m += z1[i]; m /= NH;
  v = 0; for (i = 0; i < NH; i++) { var d0 = z1[i] - m; v += d0 * d0; } v /= NH;
  this.sig1 = Math.sqrt(v + EPSN);
  for (i = 0; i < NH; i++) { xh1[i] = (z1[i] - m) / this.sig1; s = p[this.g1 + i] * xh1[i] + p[this.c1 + i]; h1[i] = s > 0 ? s : 0; }

  for (i = 0; i < NH; i++) { s = p[this.b1 + i]; r = this.W1 + i * NH; for (j = 0; j < NH; j++) s += p[r + j] * h1[j]; z2[i] = s; }
  m = 0; for (i = 0; i < NH; i++) m += z2[i]; m /= NH;
  v = 0; for (i = 0; i < NH; i++) { var d1 = z2[i] - m; v += d1 * d1; } v /= NH;
  this.sig2 = Math.sqrt(v + EPSN);
  for (i = 0; i < NH; i++) { xh2[i] = (z2[i] - m) / this.sig2; s = p[this.g2 + i] * xh2[i] + p[this.c2 + i]; h2[i] = s > 0 ? s : 0; }

  s = p[this.bv]; for (j = 0; j < NH; j++) s += p[this.Wv + j] * h2[j];
  this.V = s;
  var am = 0;
  for (i = 0; i < NA; i++) { s = p[this.ba + i]; r = this.Wa + i * NH; for (j = 0; j < NH; j++) s += p[r + j] * h2[j]; this.A[i] = s; am += s; }
  am /= NA;
  for (i = 0; i < NA; i++) this.q[i] = this.V + this.A[i] - am;
  for (i = 0; i < NAUX; i++) {
    s = p[this.bx + i]; r = this.Wx + i * NH;
    for (j = 0; j < NH; j++) s += p[r + j] * h2[j];
    this.aux[i] = s;
  }
  return this.q;
};

Net.prototype.fwdV = function (p, x, xo) {
  var NI = this.NI, NH = this.NH;
  var z1 = this.z1, xh1 = this.xh1, h1 = this.h1, z2 = this.z2, xh2 = this.xh2, h2 = this.h2;
  var i, j, s, m, v;

  for (i = 0; i < NH; i++) { s = p[this.b0 + i]; var r0 = this.W0 + i * NI; for (j = 0; j < NI; j++) s += p[r0 + j] * x[xo + j]; z1[i] = s; }
  m = 0; for (i = 0; i < NH; i++) m += z1[i]; m /= NH;
  v = 0; for (i = 0; i < NH; i++) { var d0 = z1[i] - m; v += d0 * d0; } v /= NH;
  this.sig1 = Math.sqrt(v + EPSN);
  for (i = 0; i < NH; i++) { xh1[i] = (z1[i] - m) / this.sig1; s = p[this.g1 + i] * xh1[i] + p[this.c1 + i]; h1[i] = s > 0 ? s : 0; }

  for (i = 0; i < NH; i++) { s = p[this.b1 + i]; var r1 = this.W1 + i * NH; for (j = 0; j < NH; j++) s += p[r1 + j] * h1[j]; z2[i] = s; }
  m = 0; for (i = 0; i < NH; i++) m += z2[i]; m /= NH;
  v = 0; for (i = 0; i < NH; i++) { var d1 = z2[i] - m; v += d1 * d1; } v /= NH;
  this.sig2 = Math.sqrt(v + EPSN);
  for (i = 0; i < NH; i++) { xh2[i] = (z2[i] - m) / this.sig2; s = p[this.g2 + i] * xh2[i] + p[this.c2 + i]; h2[i] = s > 0 ? s : 0; }

  s = p[this.bv]; for (j = 0; j < NH; j++) s += p[this.Wv + j] * h2[j];
  this.V = s;
  return s;
};

Net.prototype.argmax = function () {
  var b = 0, q = this.q;
  for (var i = 1; i < this.NA; i++) if (q[i] > q[b]) b = i;
  return b;
};

Net.prototype.argmaxN = function (n) {
  var b = 0, q = this.q;
  for (var i = 1; i < n; i++) if (q[i] > q[b]) b = i;
  return b;
};

Net.prototype._tail = function (p, g, x, xo, dV) {
  var NI = this.NI, NH = this.NH, NA = this.NA;
  var h1 = this.h1, h2 = this.h2, xh1 = this.xh1, xh2 = this.xh2;
  var d1 = this.d1, d2 = this.d2, dA = this.dA;
  var i, j, r, e, sd, sdx;

  for (i = 0; i < NH; i++) d2[i] = 0;
  if (dV !== 0) { g[this.bv] += dV; for (j = 0; j < NH; j++) { g[this.Wv + j] += dV * h2[j]; d2[j] += dV * p[this.Wv + j]; } }
  for (i = 0; i < NA; i++) {
    e = dA[i];
    if (e === 0) continue;
    g[this.ba + i] += e; r = this.Wa + i * NH;
    for (j = 0; j < NH; j++) { g[r + j] += e * h2[j]; d2[j] += e * p[r + j]; }
  }
  for (i = 0; i < NAUX; i++) {
    e = this.dX[i];
    if (e === 0) continue;
    g[this.bx + i] += e; r = this.Wx + i * NH;
    for (j = 0; j < NH; j++) { g[r + j] += e * h2[j]; d2[j] += e * p[r + j]; }
  }
  for (i = 0; i < NH; i++) if (h2[i] <= 0) d2[i] = 0;
  sd = 0; sdx = 0;
  for (i = 0; i < NH; i++) { g[this.g2 + i] += d2[i] * xh2[i]; g[this.c2 + i] += d2[i]; var y2 = d2[i] * p[this.g2 + i]; d2[i] = y2; sd += y2; sdx += y2 * xh2[i]; }
  sd /= NH; sdx /= NH;
  for (i = 0; i < NH; i++) d2[i] = (d2[i] - sd - xh2[i] * sdx) / this.sig2;

  for (i = 0; i < NH; i++) d1[i] = 0;
  for (i = 0; i < NH; i++) {
    e = d2[i];
    if (e === 0) continue;
    g[this.b1 + i] += e; r = this.W1 + i * NH;
    for (j = 0; j < NH; j++) { g[r + j] += e * h1[j]; d1[j] += e * p[r + j]; }
  }
  for (i = 0; i < NH; i++) if (h1[i] <= 0) d1[i] = 0;
  sd = 0; sdx = 0;
  for (i = 0; i < NH; i++) { g[this.g1 + i] += d1[i] * xh1[i]; g[this.c1 + i] += d1[i]; var y1 = d1[i] * p[this.g1 + i]; d1[i] = y1; sd += y1; sdx += y1 * xh1[i]; }
  sd /= NH; sdx /= NH;
  for (i = 0; i < NH; i++) d1[i] = (d1[i] - sd - xh1[i] * sdx) / this.sig1;

  for (i = 0; i < NH; i++) {
    e = d1[i];
    if (e === 0) continue;
    g[this.b0 + i] += e; r = this.W0 + i * NI;
    for (j = 0; j < NI; j++) g[r + j] += e * x[xo + j];
  }
};

Net.prototype.bwdQ = function (p, g, x, xo, a, err) {
  var NA = this.NA, dA = this.dA, k = err / NA;
  for (var i = 0; i < NA; i++) dA[i] = -k;
  dA[a] += err;
  for (i = 0; i < NAUX; i++) this.dX[i] = 0;
  this._tail(p, g, x, xo, err);
};

Net.prototype.bwdAux = function (p, g, x, xo, tgt, toff, scale) {
  var i, loss = 0;
  for (i = 0; i < this.NA; i++) this.dA[i] = 0;
  for (i = 0; i < NAUX; i++) {
    var e = this.aux[i] - tgt[toff + i];
    if (e > 1) e = 1; else if (e < -1) e = -1;
    loss += e * e;
    this.dX[i] = e * scale;
  }
  this._tail(p, g, x, xo, 0);
  return loss / NAUX;
};

Net.prototype.bwdCE = function (p, g, x, xo, target, scale) {
  var NA = this.NA, A = this.A, dA = this.dA, i, mx = A[0];
  for (i = 1; i < NA; i++) if (A[i] > mx) mx = A[i];
  var sum = 0;
  for (i = 0; i < NA; i++) { dA[i] = Math.exp(A[i] - mx); sum += dA[i]; }
  for (i = 0; i < NA; i++) dA[i] = (dA[i] / sum - (i === target ? 1 : 0)) * scale;
  for (i = 0; i < NAUX; i++) this.dX[i] = 0;
  var loss = -Math.log(Math.max(1e-9, Math.exp(A[target] - mx) / sum));
  this._tail(p, g, x, xo, 0);
  return loss;
};

Net.prototype.sample = function (rand, temp) {
  var NA = this.NA, A = this.A, i, mx = A[0];
  for (i = 1; i < NA; i++) if (A[i] > mx) mx = A[i];
  var t = temp || 1, sum = 0, e = this.dA;
  for (i = 0; i < NA; i++) { e[i] = Math.exp((A[i] - mx) / t); sum += e[i]; }
  var u = rand() * sum, c = 0;
  for (i = 0; i < NA; i++) { c += e[i]; if (u <= c) return i; }
  return NA - 1;
};

function Adam(NP, lr) {
  this.m = new Float32Array(NP); this.v = new Float32Array(NP);
  this.t = 0; this.lr = lr; this.b1 = 0.9; this.b2 = 0.99; this.eps = 1e-7;
  this.warm = 200; this.clip = 10;
  this.gnorm = 0;
}
Adam.prototype.step = function (p, g) {
  var NP = p.length, i, s = 0;
  for (i = 0; i < NP; i++) s += g[i] * g[i];
  s = Math.sqrt(s);
  this.gnorm = s;
  var sc = s > this.clip ? this.clip / s : 1;
  this.t++;
  var lr = this.lr * Math.min(1, this.t / this.warm);
  var bc1 = 1 - Math.pow(this.b1, this.t), bc2 = 1 - Math.pow(this.b2, this.t);
  for (i = 0; i < NP; i++) {
    var gi = g[i] * sc;
    var mi = this.m[i] = this.b1 * this.m[i] + (1 - this.b1) * gi;
    var vi = this.v[i] = this.b2 * this.v[i] + (1 - this.b2) * gi * gi;
    if (vi < 1e-20) vi = 1e-20;
    p[i] -= lr * (mi / bc1) / (Math.sqrt(vi / bc2) + this.eps);
  }
};

function polyak(target, src, tau) {
  for (var i = 0; i < target.length; i++) target[i] += tau * (src[i] - target[i]);
}

root.LCNet = { Net: Net, Adam: Adam, polyak: polyak, NAUX: NAUX };

})(typeof self !== 'undefined' ? self : this);
