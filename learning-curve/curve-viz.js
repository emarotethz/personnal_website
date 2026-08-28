// Everything under and over the arena: the learning curves, the live activation
// panel, and the agent's-eye view.
//
// None of it runs at frame rate. Charts redraw at ~6Hz and the network panel at
// 10Hz; the value landscape is computed a quarter of the grid at a time at 20Hz
// so no single frame carries the whole cost. The entire robot-vision layer is
// skipped while the slider is at zero.
(function () {
'use strict';

var $ = function (id) { return document.getElementById(id); };
var LC = window.LC;
var C = LC.C, NOBS = LC.NOBS, NACT = LC.NACT, NRC = LC.NRC;

var INK = '#f3f1ec', ACC = '#E85A1A', DIM = '#7a766f', LINE = 'rgba(243,241,236,0.10)';
var COLD0 = [22, 32, 44], COLD1 = [92, 168, 206];
var dpr = Math.min(window.devicePixelRatio || 1, 2);

function Trace(cap) {
  this.v = new Float32Array(cap); this.cap = cap;
  this.n = 0; this.every = 1; this.pend = 0; this.acc = 0;
}
Trace.prototype.push = function (x) {
  if (!isFinite(x)) return;
  this.acc += x; this.pend++;
  if (this.pend < this.every) return;
  var v = this.acc / this.pend;
  this.acc = 0; this.pend = 0;
  if (this.n < this.cap) { this.v[this.n++] = v; return; }
  var half = this.cap >> 1;
  for (var i = 0; i < half; i++) this.v[i] = (this.v[i * 2] + this.v[i * 2 + 1]) / 2;
  this.n = half; this.every *= 2;
  this.v[this.n++] = v;
};
Trace.prototype.at = function (k) { return this.v[k]; };
Trace.prototype.last = function () { return this.n ? this.v[this.n - 1] : 0; };

var CAPN = 512;
var rHits = new Trace(CAPN), rLoss = new Trace(CAPN), rQ = new Trace(CAPN),
    rEps = new Trace(CAPN);

function fitCanvas(cv, h) {
  if (!cv || !cv.parentNode) return null;
  var w = Math.max(80, Math.round(cv.parentNode.getBoundingClientRect().width));
  cv.style.height = h + 'px';
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  var g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g: g, w: w, h: h };
}

function plot(cv, series) {
  if (!cv || !cv.width) return;
  var w = cv.width / dpr, h = cv.height / dpr;
  var g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.strokeStyle = LINE; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, h - 0.5); g.lineTo(w, h - 0.5); g.stroke();

  var lo = Infinity, hi = -Infinity, s, k, most = 0;
  for (s = 0; s < series.length; s++) {
    var r = series[s].r;
    if (r.n > most) most = r.n;
    for (k = 0; k < r.n; k++) { var v = r.at(k); if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  if (!isFinite(lo)) return;
  var xspan = Math.max(2, most) - 1;
  if (hi - lo < 1e-6) { hi = lo + 1; lo -= 0.5; }
  var pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  if (lo < 0 && hi > 0) {
    var zy = h - (0 - lo) / (hi - lo) * h;
    g.strokeStyle = 'rgba(243,241,236,0.06)';
    g.beginPath(); g.moveTo(0, zy); g.lineTo(w, zy); g.stroke();
  }
  for (s = 0; s < series.length; s++) {
    var rr = series[s].r;
    if (rr.n < 2) continue;
    g.strokeStyle = series[s].c; g.lineWidth = series[s].lw || 1.4;
    g.beginPath();
    for (k = 0; k < rr.n; k++) {
      var x = (k / xspan) * w;
      var y = h - (rr.at(k) - lo) / (hi - lo) * h;
      if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
}

var rowsBuilt = false;
function buildRows() {
  var host = $('rlist');
  if (!host) return;
  host.innerHTML = '';
  for (var i = 0; i < NRC; i++) {
    var row = document.createElement('div');
    row.className = 'rrow';
    var name = document.createElement('span');
    name.textContent = LC.RC_NAMES[i];
    var bar = document.createElement('span');
    bar.className = 'rbar';
    bar.appendChild(document.createElement('span'));
    var val = document.createElement('b');
    val.textContent = '0';
    row.appendChild(name); row.appendChild(bar); row.appendChild(val);
    host.appendChild(row);
  }
  rowsBuilt = true;
}
function paintRows(rc) {
  if (!rowsBuilt) buildRows();
  var host = $('rlist');
  if (!host) return;
  var mx = 1e-6, i;
  for (i = 0; i < NRC; i++) mx = Math.max(mx, Math.abs(rc[i]));
  for (i = 0; i < NRC; i++) {
    var row = host.children[i];
    if (!row) continue;
    var bar = row.children[1].firstChild;
    var f = Math.abs(rc[i]) / mx;
    var neg = rc[i] < 0;
    var tf = 'translateX(' + (neg ? (100 - f * 100).toFixed(2) : '100') + '%) scaleX(' + f.toFixed(4) + ')';
    if (bar._tf !== tf) { bar._tf = tf; bar.style.transform = tf; }
    var cls = neg ? 'neg' : '';
    if (bar.className !== cls) bar.className = cls;
    var txt = (neg ? '' : '+') + rc[i].toFixed(3);
    if (row.children[2]._v !== txt) { row.children[2]._v = txt; row.children[2].textContent = txt; }
  }
}

var netCv = null, edgeCv = null, layout = null, lastEdges = 0, lastNet = 0;

function buildLayout(w, h) {
  var cols = [NOBS, 64, 64, NACT];
  var padL = 52, padR = 96, usable = w - padL - padR;
  var L = [];
  for (var c = 0; c < cols.length; c++) {
    var n = cols[c], x = padL + (usable * c) / (cols.length - 1);
    var gap = Math.min(6, (h - 24) / n);
    var nh = Math.max(2, gap - 1.4);
    var top = (h - gap * n) / 2;
    var pts = new Float32Array(n * 2);
    for (var i = 0; i < n; i++) { pts[i * 2] = x; pts[i * 2 + 1] = top + gap * i + gap / 2; }
    var entry = { n: n, x: x, pts: pts, nh: nh, w: c === 0 || c === 3 ? 9 : 6 };
    if (c === 3) { entry.bw = Math.min(58, w * 0.16); entry.left = x - entry.bw / 2; }
    L.push(entry);
  }
  return L;
}

function drawEdges(net, P) {
  if (!edgeCv || !layout) return;
  var w = edgeCv.width / dpr, h = edgeCv.height / dpr;
  var g = edgeCv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.lineWidth = 0.6;
  var specs = [
    { src: 0, dst: 1, off: net.W0, ni: net.NI },
    { src: 1, dst: 2, off: net.W1, ni: net.NH },
    { src: 2, dst: 3, off: net.Wa, ni: net.NH }
  ];
  var K = 3;
  for (var s = 0; s < specs.length; s++) {
    var sp = specs[s], A = layout[sp.src], B = layout[sp.dst];
    var mx = 1e-6, q;
    for (q = 0; q < B.n * sp.ni; q++) { var av = Math.abs(P[sp.off + q]); if (av > mx) mx = av; }
    binReset();
    for (var j = 0; j < B.n; j++) {
      var base = sp.off + j * sp.ni;
      var b0 = -1, b1 = -1, b2 = -1, v0 = 0, v1 = 0, v2 = 0, i, k;
      for (i = 0; i < sp.ni; i++) {
        var a = Math.abs(P[base + i]);
        if (a > v0) { v2 = v1; b2 = b1; v1 = v0; b1 = b0; v0 = a; b0 = i; }
        else if (a > v1) { v2 = v1; b2 = b1; v1 = a; b1 = i; }
        else if (a > v2) { v2 = a; b2 = i; }
      }
      var dx = B.left === undefined ? B.pts[j * 2] : B.left, dy = B.pts[j * 2 + 1];
      for (k = 0; k < K; k++) {
        var bi = k === 0 ? b0 : k === 1 ? b1 : b2;
        if (bi < 0) continue;
        var wv = P[base + bi], t = Math.min(1, Math.abs(wv) / mx);
        binPush((wv > 0 ? NBIN : 0) + Math.min(NBIN - 1, (t * NBIN) | 0),
          A.pts[bi * 2], A.pts[bi * 2 + 1], dx, dy);
      }
    }
    binStroke(g);
  }
}

var NBIN = 6, EBUF = [], ELEN = [];
function binReset() {
  for (var i = 0; i < NBIN * 2; i++) {
    if (!EBUF[i]) EBUF[i] = new Float32Array(512);
    ELEN[i] = 0;
  }
}
function binPush(bin, x1, y1, x2, y2) {
  var buf = EBUF[bin], n = ELEN[bin];
  if (n + 4 > buf.length) {
    var wider = new Float32Array(buf.length * 2);
    wider.set(buf); EBUF[bin] = buf = wider;
  }
  buf[n] = x1; buf[n + 1] = y1; buf[n + 2] = x2; buf[n + 3] = y2;
  ELEN[bin] = n + 4;
}
function binStroke(g) {
  for (var bin = 0; bin < NBIN * 2; bin++) {
    var n = ELEN[bin];
    if (!n) continue;
    var pos = bin >= NBIN, t = ((bin % NBIN) + 0.5) / NBIN;
    g.strokeStyle = pos
      ? 'rgba(232,90,26,' + (0.05 + 0.40 * t).toFixed(3) + ')'
      : 'rgba(243,241,236,' + (0.03 + 0.22 * t).toFixed(3) + ')';
    g.lineWidth = 0.4 + 0.7 * t;
    var buf = EBUF[bin];
    g.beginPath();
    for (var i = 0; i < n; i += 4) { g.moveTo(buf[i], buf[i + 1]); g.lineTo(buf[i + 2], buf[i + 3]); }
    g.stroke();
  }
}

function heat(v) {
  var t = Math.max(-1, Math.min(1, v));
  if (t >= 0) {
    var a = 0.10 + 0.90 * t;
    return 'rgba(232,90,26,' + a.toFixed(3) + ')';
  }
  return 'rgba(122,118,111,' + (0.10 + 0.70 * -t).toFixed(3) + ')';
}

var NB2 = LC.NBUL * 4;
var OBS_GROUPS = [
  [0, 4, 'self'],
  [4, 14, 'target'],
  [14, 14 + NB2, 'shots'],
  [14 + NB2, NOBS - 3, 'rocks'],
  [NOBS - 3, NOBS, 'risk']
];
var netEase = null;

function drawNet(net, P, obs, act) {
  if (!netCv || !layout || !P) return;
  var w = netCv.width / dpr, h = netCv.height / dpr;
  var g = netCv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (edgeCv) g.drawImage(edgeCv, 0, 0, w, h);

  var i, L, y, gi;
  if (!netEase) netEase = { h1: new Float32Array(net.NH), h2: new Float32Array(net.NH), q: new Float32Array(NACT) };
  for (i = 0; i < net.NH; i++) {
    netEase.h1[i] += (net.h1[i] - netEase.h1[i]) * 0.45;
    netEase.h2[i] += (net.h2[i] - netEase.h2[i]) * 0.45;
  }
  for (i = 0; i < NACT; i++) netEase.q[i] += (net.q[i] - netEase.q[i]) * 0.35;

  g.font = '8.5px ui-monospace, Menlo, monospace';
  g.textAlign = 'right';

  L = layout[0];
  for (gi = 0; gi < OBS_GROUPS.length; gi++) {
    var grp = OBS_GROUPS[gi];
    for (i = grp[0]; i < grp[1]; i++) {
      g.fillStyle = heat(obs[i]);
      g.fillRect(L.pts[i * 2] - L.w / 2, L.pts[i * 2 + 1] - L.nh / 2, L.w, L.nh);
    }
    var top = L.pts[grp[0] * 2 + 1], bot = L.pts[(grp[1] - 1) * 2 + 1];
    g.strokeStyle = 'rgba(243,241,236,0.13)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(L.x - L.w / 2 - 5, top - L.nh / 2);
    g.lineTo(L.x - L.w / 2 - 5, bot + L.nh / 2);
    g.stroke();
    g.fillStyle = DIM;
    g.fillText(grp[2], L.x - L.w / 2 - 9, (top + bot) / 2 + 3);
  }

  var hs = [netEase.h1, netEase.h2];
  for (var c = 0; c < 2; c++) {
    L = layout[c + 1];
    for (i = 0; i < L.n; i++) {
      g.fillStyle = heat(hs[c][i] / 2.5);
      g.fillRect(L.pts[i * 2] - L.w / 2, L.pts[i * 2 + 1] - L.nh / 2, L.w, L.nh);
    }
  }

  L = layout[3];
  var q = netEase.q, lo = q[0], hi = q[0];
  for (i = 1; i < NACT; i++) { if (q[i] < lo) lo = q[i]; if (q[i] > hi) hi = q[i]; }
  var span = Math.max(1e-3, hi - lo);
  var bw = L.bw || Math.min(58, w * 0.16);
  for (i = 0; i < NACT; i++) {
    var f = (q[i] - lo) / span;
    y = L.pts[i * 2 + 1];
    g.fillStyle = 'rgba(243,241,236,0.05)';
    g.fillRect(L.x - bw / 2, y - L.nh / 2, bw, L.nh);
    g.fillStyle = i === act ? ACC : 'rgba(232,90,26,0.28)';
    g.fillRect(L.x - bw / 2, y - L.nh / 2, Math.max(1, bw * f), L.nh);
  }
  var ay = L.pts[act * 2 + 1];
  g.strokeStyle = ACC; g.lineWidth = 1;
  g.strokeRect(L.x - bw / 2 - 2.5, ay - L.nh / 2 - 2.5, bw + 5, L.nh + 5);

  g.font = '9px ui-monospace, Menlo, monospace';
  g.fillStyle = ACC;
  var nm = actionName(act), nx = L.x + bw / 2 + 8;
  if (nx + g.measureText(nm).width <= w - 4) {
    g.textAlign = 'left';
    g.fillText(nm, nx, ay + 3);
  } else {
    g.textAlign = 'right';
    g.fillText(nm, w - 4, 11);
  }

  g.textAlign = 'center';
  g.fillStyle = DIM;
  g.fillText('observation', layout[0].x, h - 4);
  g.fillText('hidden layers', (layout[1].x + layout[2].x) / 2, h - 4);
  g.fillText('action values', L.x, h - 4);

  var vy = L.pts[(NACT - 1) * 2 + 1] + L.nh / 2 + 13;
  g.textAlign = 'left';
  g.fillStyle = DIM;
  g.fillText('V(s)', L.x - bw / 2, vy);
  g.fillStyle = ACC;
  g.textAlign = 'right';
  g.fillText(net.V.toFixed(2), L.x + bw / 2, vy);
}

var visCv = null, obsCv = null, hmCv = null, hmImg = null, hmData = null, lastHm = 0;
var HMX = 36, HMY = 26, HMBANDS = 4, hmBand = 0;
var vobs = new Float32Array(NOBS);
var obsEase = new Float32Array(NOBS), lastObs = 0;
var hmVals = new Float32Array(HMX * HMY);
var hmSm = new Float32Array(HMX * HMY), hmBlur = new Float32Array(HMX * HMY);
var hmLo = -1, hmHi = 1, hmSeen = false;
var gpx = 0, gpy = 0, gpAt = 0, gpRound = -1, GPK = 8;

function valueLandscape(world, net, P) {
  if (!hmCv) {
    hmCv = document.createElement('canvas');
    hmCv.width = HMX; hmCv.height = HMY;
    hmImg = hmCv.getContext('2d');
    hmData = hmImg.createImageData(HMX, HMY);
  }
  var a = world.a, sx = a.x, sy = a.y, i, j;
  for (j = hmBand; j < HMY; j += HMBANDS) {
    for (i = 0; i < HMX; i++) {
      a.x = (i + 0.5) * C.W / HMX;
      a.y = (j + 0.5) * C.H / HMY;
      world.observe(0, vobs, 0);
      hmVals[j * HMX + i] = net.fwdV(P, vobs, 0);
    }
  }
  a.x = sx; a.y = sy;
  world.observe(0, vobs, 0);
  world.observe(1, vobs, 0);
  hmBand = (hmBand + 1) % HMBANDS;
  if (!hmSeen && hmBand === 0) hmSeen = true;

  var sm = hmSm, x2, y2;
  for (y2 = 0; y2 < HMY; y2++) {
    for (x2 = 0; x2 < HMX; x2++) {
      var o = y2 * HMX + x2;
      sm[o] = (hmVals[o] * 2 + hmVals[x2 > 0 ? o - 1 : o] + hmVals[x2 < HMX - 1 ? o + 1 : o]) / 4;
    }
  }
  for (x2 = 0; x2 < HMX; x2++) {
    for (y2 = 0; y2 < HMY; y2++) {
      var o2 = y2 * HMX + x2;
      hmBlur[o2] = (sm[o2] * 2 + sm[y2 > 0 ? o2 - HMX : o2] + sm[y2 < HMY - 1 ? o2 + HMX : o2]) / 4;
    }
  }

  var lo = Infinity, hi = -Infinity;
  for (i = 0; i < hmBlur.length; i++) { var v = hmBlur[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  hmLo += (lo - hmLo) * 0.12; hmHi += (hi - hmHi) * 0.12;
  var span = Math.max(1e-4, hmHi - hmLo);
  var d = hmData.data;
  for (i = 0; i < HMX * HMY; i++) {
    var t = Math.max(0, Math.min(1, (hmBlur[i] - hmLo) / span));
    t = t * t * (3 - 2 * t);
    d[i * 4] = Math.round(COLD0[0] + (COLD1[0] - COLD0[0]) * t);
    d[i * 4 + 1] = Math.round(COLD0[1] + (COLD1[1] - COLD0[1]) * t);
    d[i * 4 + 2] = Math.round(COLD0[2] + (COLD1[2] - COLD0[2]) * t);
    d[i * 4 + 3] = Math.round(140 * (0.05 + 0.95 * t * t));
  }
  hmImg.putImageData(hmData, 0, 0);
}

function box(g, x, y, w, h) {
  g.fillStyle = 'rgba(6,6,6,0.86)';
  g.fillRect(x, y, w, h);
  g.strokeStyle = LINE; g.lineWidth = 1;
  g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function ghostLine(g, x1, y1, x2, y2, sc, colour, dash) {
  var W = C.W * sc, H = C.H * sc;
  g.strokeStyle = colour; g.lineWidth = 1;
  g.setLineDash(dash || []);
  for (var gx = -1; gx <= 1; gx++) {
    for (var gy = -1; gy <= 1; gy++) {
      g.beginPath();
      g.moveTo(x1 + gx * W, y1 + gy * H);
      g.lineTo(x2 + gx * W, y2 + gy * H);
      g.stroke();
    }
  }
  g.setLineDash([]);
}

function cone(g, bx, by, vx, vy, life, strength, sc) {
  var sp = Math.hypot(vx, vy);
  if (sp < 1e-3) return;
  var ux = vx / sp, uy = vy / sp, len = Math.min(life, 1.0) * sp * sc;
  var half = 0.14;
  var c1 = Math.cos(half), s1 = Math.sin(half);
  var ax = (ux * c1 - uy * s1) * len, ay = (ux * s1 + uy * c1) * len;
  var bx2 = (ux * c1 + uy * s1) * len, by2 = (-ux * s1 + uy * c1) * len;
  g.strokeStyle = 'rgba(243,241,236,' + (0.14 + 0.46 * strength).toFixed(3) + ')';
  g.lineWidth = 1;
  g.setLineDash([3, 4]);
  var W = C.W * sc, H = C.H * sc, px = bx * sc, py = by * sc;
  for (var gx = -1; gx <= 1; gx++) {
    for (var gy = -1; gy <= 1; gy++) {
      var ox = px + gx * W, oy = py + gy * H;
      if (ox < -len - 20 || ox > W + len + 20 || oy < -len - 20 || oy > H + len + 20) continue;
      g.beginPath();
      g.moveTo(ox, oy);
      g.lineTo(ox + ax, oy + ay);
      g.lineTo(ox + bx2, oy + by2);
      g.closePath();
      g.stroke();
    }
  }
  g.setLineDash([]);
}

var visOp = -1;
function drawVision(world, obs, net, P, mix, act) {
  if (!visCv) return;
  if (mix !== visOp) { visOp = mix; visCv.style.opacity = mix; }
  if (mix <= 0.002 || !P) return;
  var w = visCv.width / dpr, h = visCv.height / dpr, sc = w / C.W;
  var g = visCv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  var now = performance.now();
  if (now - lastHm > 40) { lastHm = now; valueLandscape(world, net, P); }
  net.fwd(P, obs, 0);
  if (hmCv && hmSeen) {
    g.imageSmoothingEnabled = true;
    g.globalAlpha = 0.55;
    g.drawImage(hmCv, 0, 0, w, h);
    g.globalAlpha = 1;
  }

  var a = world.a, b = world.b, ri;

  var px = LC.dwrap(b.x - a.x, C.W), py = LC.dwrap(b.y - a.y, C.H);
  var rvx = b.vx - a.vx, rvy = b.vy - a.vy;
  var t = LC.intercept(px, py, rvx, rvy, C.BSPD);
  var aimx = px + (t > 0 ? rvx * t : 0), aimy = py + (t > 0 ? rvy * t : 0);
  var ad = Math.hypot(aimx, aimy);
  var lead = LC.wrapPi(Math.atan2(aimy, aimx) - a.a);

  var nearest = -1, nd = 1e9, blocked = 0;
  for (ri = 0; ri < world.rocks.length; ri++) {
    var Rk = world.rocks[ri];
    Rk.qx = LC.dwrap(Rk.x - a.x, C.W); Rk.qy = LC.dwrap(Rk.y - a.y, C.H);
    var rd = Math.hypot(Rk.qx, Rk.qy) - Rk.r;
    if (rd < nd) { nd = rd; nearest = ri; }
  }
  if (ad > 1e-6) blocked = LC.rayBlocked(world.rocks, aimx / ad, aimy / ad, ad);

  var ax = a.x * sc, ay = a.y * sc;

  ghostLine(g, ax, ay, (a.x + px) * sc, (a.y + py) * sc, sc, 'rgba(243,241,236,0.28)', [3, 4]);

  for (ri = 0; ri < world.rocks.length; ri++) {
    var Rr = world.rocks[ri];
    g.strokeStyle = ri === nearest ? 'rgba(243,241,236,0.45)' : 'rgba(243,241,236,0.14)';
    g.lineWidth = ri === nearest ? 1.4 : 1;
    g.setLineDash(ri === nearest ? [] : [2, 3]);
    g.beginPath();
    g.arc(Rr.x * sc, Rr.y * sc, (Rr.r + C.BR) * sc, 0, 6.2832);
    g.stroke();
  }
  g.setLineDash([]);

  if (net.aux) {
    var pa = Math.atan2(net.aux[1], net.aux[0]) + a.a;
    var pt = Math.max(0.05, Math.min(1.5, net.aux[2])) * C.BSPD;
    var dt = (now - gpAt) / 1000;
    var fresh = gpRound < 0 || world.roundT < gpRound || !(dt < 0.3);
    gpAt = now; gpRound = world.roundT;
    if (fresh) { gpx = a.x + aimx; gpy = a.y + aimy; }
    else {
      var k = 1 - Math.exp(-dt * GPK);
      gpx += LC.dwrap(a.x + Math.cos(pa) * pt - gpx, C.W) * k;
      gpy += LC.dwrap(a.y + Math.sin(pa) * pt - gpy, C.H) * k;
    }
    var gxw = (gpx % C.W + C.W) % C.W, gyw = (gpy % C.H + C.H) % C.H;
    gpx = gxw; gpy = gyw;
    pa = Math.atan2(LC.dwrap(gyw - a.y, C.H), LC.dwrap(gxw - a.x, C.W));
    pt = Math.hypot(LC.dwrap(gxw - a.x, C.W), LC.dwrap(gyw - a.y, C.H));
    var gxp = gxw * sc, gyp = gyw * sc;
    g.strokeStyle = blocked ? DIM : ACC; g.lineWidth = 1.3;
    g.beginPath(); g.arc(gxp, gyp, 7, 0, 6.2832); g.stroke();
    g.beginPath();
    g.moveTo(gxp - 11, gyp); g.lineTo(gxp - 8, gyp);
    g.moveTo(gxp + 8, gyp); g.lineTo(gxp + 11, gyp);
    g.moveTo(gxp, gyp - 11); g.lineTo(gxp, gyp - 8);
    g.moveTo(gxp, gyp + 8); g.lineTo(gxp, gyp + 11);
    g.stroke();
    ghostLine(g, ax, ay, (a.x + Math.cos(pa) * pt) * sc, (a.y + Math.sin(pa) * pt) * sc, sc,
      blocked ? 'rgba(122,118,111,0.5)' : 'rgba(232,90,26,0.5)', [2, 3]);
    if (blocked) {
      g.font = '10px ui-monospace, Menlo, monospace';
      g.fillStyle = DIM; g.textAlign = 'left';
      g.fillText('blocked', gxp + 14, gyp - 11);
    }
    g.strokeStyle = 'rgba(232,90,26,0.45)'; g.lineWidth = 2;
    g.beginPath();
    g.arc(ax, ay, 30, a.a, pa, LC.wrapPi(pa - a.a) < 0);
    g.stroke();
    g.lineWidth = 1;
  }

  for (var i = 0; i < world.pb.n; i++) {
    var qx = LC.dwrap(world.pb.x[i] - a.x, C.W), qy = LC.dwrap(world.pb.y[i] - a.y, C.H);
    var wx = world.pb.vx[i] - a.vx, wy = world.pb.vy[i] - a.vy;
    var vv = wx * wx + wy * wy;
    if (vv < 1e-6) continue;
    var tca = Math.max(0, Math.min(C.BTTL, -(qx * wx + qy * wy) / vv));
    var miss = Math.hypot(qx + wx * tca, qy + wy * tca);
    var str = Math.exp(-miss / 45) * Math.exp(-tca / 0.7);
    cone(g, world.pb.x[i], world.pb.y[i], wx, wy, world.pb.t[i], str, sc);
    if (str > 0.05) {
      var cx = ((a.x + qx + wx * tca) % C.W + C.W) % C.W;
      var cy = ((a.y + qy + wy * tca) % C.H + C.H) % C.H;
      var mx = cx * sc, my = cy * sc;
      g.strokeStyle = 'rgba(243,241,236,' + (0.25 + 0.5 * str).toFixed(3) + ')';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(mx - 3.5, my - 3.5); g.lineTo(mx + 3.5, my + 3.5);
      g.moveTo(mx + 3.5, my - 3.5); g.lineTo(mx - 3.5, my + 3.5);
      g.stroke();
    }
  }

  drawObs(obs, now);

  g.font = '10px ui-monospace, Menlo, monospace';
  var kv = [['V(s)', net.V.toFixed(2)], ['max Q', net.q[net.argmax()].toFixed(2)]];
  var name = actionName(act), gap = 18;
  var row = 0;
  for (i = 0; i < kv.length; i++) {
    kv[i][2] = g.measureText(kv[i][0]).width + 6;
    row += kv[i][2] + g.measureText(kv[i][1]).width + (i ? 0 : gap);
  }
  var hw = Math.max(row, g.measureText(name).width) + 24;
  var hx = w - 10 - hw, hy = 10;
  box(g, hx, hy, hw, 46);
  g.textAlign = 'left';
  var cx2 = hx + 12;
  for (i = 0; i < kv.length; i++) {
    g.fillStyle = DIM; g.fillText(kv[i][0], cx2, hy + 18);
    g.fillStyle = INK; g.fillText(kv[i][1], cx2 + kv[i][2], hy + 18);
    cx2 += kv[i][2] + g.measureText(kv[i][1]).width + gap;
  }
  g.fillStyle = ACC;
  g.fillText(name, hx + 12, hy + 34);
}

function drawObs(obs, now) {
  if (!obsCv) return;
  var w = obsCv.width / dpr, h = obsCv.height / dpr;
  var g = obsCv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  var ease = Math.min(1, (now - lastObs) / 90), i;
  lastObs = now;
  for (i = 0; i < NOBS; i++) obsEase[i] += (obs[i] - obsEase[i]) * ease;

  var pad = 2, bw = (w - pad * 2) / NOBS, bh = h - 30, zero = 12 + bh / 2;
  for (i = 0; i < NOBS; i++) {
    var v = Math.max(-1, Math.min(1, obsEase[i]));
    var hgt = Math.max(1, Math.abs(v) * (bh / 2));
    g.fillStyle = v >= 0 ? 'rgba(243,241,236,0.78)' : 'rgba(122,118,111,0.85)';
    g.fillRect(pad + i * bw, v >= 0 ? zero - hgt : zero, Math.max(1, bw - 2), hgt);
  }
  g.strokeStyle = 'rgba(243,241,236,0.16)'; g.lineWidth = 1;
  g.beginPath();
  g.moveTo(pad, zero + 0.5); g.lineTo(w - pad, zero + 0.5); g.stroke();

  g.font = '9px ui-monospace, Menlo, monospace';
  for (var gi = 0; gi < OBS_GROUPS.length; gi++) {
    var gp = OBS_GROUPS[gi], x0 = pad + gp[0] * bw, x1 = pad + gp[1] * bw - 2;
    if (gi) {
      g.strokeStyle = 'rgba(243,241,236,0.10)';
      g.beginPath();
      g.moveTo(x0 - 1, 12); g.lineTo(x0 - 1, 12 + bh); g.stroke();
    }
    g.textAlign = 'center'; g.fillStyle = DIM;
    g.fillText(gp[2], (x0 + x1) / 2, h - 5);
  }
}

function actionName(a) {
  var t = LC.actTurn(a), th = LC.actThrust(a), f = LC.actFire(a);
  var s = t < 0 ? 'LEFT' : (t > 0 ? 'RIGHT' : 'HOLD');
  if (th) s += ' + THRUST';
  if (f) s += ' + FIRE';
  return s;
}

var lastPlot = 0, panelsOn = true;

function redraw() {
  plot($('chHits'), [{ r: rHits, c: ACC }]);
  plot($('chLoss'), [{ r: rLoss, c: INK }]);
  plot($('chQ'), [{ r: rQ, c: ACC }]);
  plot($('chAcc'), [{ r: rEps, c: ACC }]);
  $('cA').textContent = rHits.last().toFixed(1);
  $('cB').textContent = rLoss.last().toFixed(4);
  $('cC').textContent = rQ.last().toFixed(2);
  $('cD').textContent = rEps.last().toFixed(2);
}

window.LCViz = {
  resize: function (w, h) {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    visCv = $('vision');
    if (visCv) {
      visCv.style.width = w + 'px'; visCv.style.height = h + 'px';
      visCv.width = Math.round(w * dpr); visCv.height = Math.round(h * dpr);
    }
    obsCv = $('obs');
    if (obsCv) {
      var ow = Math.max(240, Math.round(obsCv.parentNode.getBoundingClientRect().width) - 24);
      var oh = 62;
      obsCv.style.width = ow + 'px'; obsCv.style.height = oh + 'px';
      obsCv.width = Math.round(ow * dpr); obsCv.height = Math.round(oh * dpr);
    }
    ['chHits', 'chLoss', 'chQ', 'chAcc'].forEach(function (id) { fitCanvas($(id), 64); });
    var shape = $('nShape');
    if (shape) shape.textContent = NOBS + ' → 64 → 64 → ' + NACT;
    netCv = $('net');
    if (netCv) {
      var nw = Math.max(280, Math.round(netCv.parentNode.getBoundingClientRect().width) - 32);
      var nh = 320;
      netCv.style.height = nh + 'px';
      netCv.width = Math.round(nw * dpr); netCv.height = Math.round(nh * dpr);
      if (!edgeCv) edgeCv = document.createElement('canvas');
      edgeCv.width = netCv.width; edgeCv.height = netCv.height;
      layout = buildLayout(nw, nh);
      lastEdges = 0;
    }
    redraw();
  },

  stats: function (s) {
    rHits.push(s.hitsPerMin);
    rLoss.push(s.loss);
    rQ.push(s.q);
    rEps.push(s.eps);
    if (!panelsOn) return;
    if (s.rc) paintRows(s.rc);
    var now = performance.now();
    if (now - lastPlot > 160) { lastPlot = now; redraw(); }
  },

  panels: function (on) {
    panelsOn = on;
    if (on) { lastNet = 0; lastEdges = 0; redraw(); }
  },

  frame: function (world, obs, net, P, mix, act) {
    if (!P || !layout) return;
    var now = performance.now();
    if (now - lastNet < 100) return;
    lastNet = now;
    if (now - lastEdges > 1500) { lastEdges = now; drawEdges(net, P); }
    drawNet(net, P, obs, act);
  },

  vision: drawVision,
  redraw: redraw,
  clear: function () {
    rHits = new Trace(CAPN); rLoss = new Trace(CAPN); rQ = new Trace(CAPN);
    rEps = new Trace(CAPN);
    hmLo = -1; hmHi = 1;
    lastEdges = 0;
    if (netEase) { netEase.h1.fill(0); netEase.h2.fill(0); netEase.q.fill(0); }
    redraw();
  }
};

})();
