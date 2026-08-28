// The page side: input, the arena, the round/lives state machine, and the pipe
// to the learner. Everything expensive happens in the worker; all this thread
// does per decision is one forward pass, which costs about 4 microseconds.
(function () {
'use strict';

var $ = function (id) { return document.getElementById(id); };
var LC = window.LC, NetC = window.LCNet.Net;
var C = LC.C, NOBS = LC.NOBS, NACT = LC.NACT, NRC = LC.NRC;
var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
var DEBUG = /[?&]debug=1/.test(location.search);
var REC = NOBS * 2 + NRC + 7;
var NH = 64;

var world = new LC.World(), ev = new LC.Ev();
world.roundMax = Infinity;
var net = new NetC(NOBS, NH, NACT), P = null;
var obsA = new Float32Array(NOBS), obsH = new Float32Array(NOBS);
var rand = LC.rng((Math.random() * 1e9) | 0);

var lives = 3, roundNo = 0, survived = 0, state = 'ready';
var ranked = true;

var scoreGrad = 0, winBase = 0, winSteps = 0, winHit = false, stepped = false;

function closeWindow() {
  var g = stats ? stats.grad : 0;
  if (winHit) scoreGrad += Math.max(0, g - winBase);
  winBase = g; winSteps = 0; winHit = false;
}
function resetScore() {
  scoreGrad = 0; winBase = stats ? stats.grad : 0; winSteps = 0; winHit = false;
}
var running = false, rafId = 0, last = 0, acc = 0, sub = 0, visible = true;
var curAgentAct = 0, curHumanAct = 4, stepIdx = 0, pending = false;
var ex = 0;
var cardTimer = 0;
var panelsSeen = true;
var mix = 0, wantMix = 0;

var keys = {};
var worker = null, solo = null, soloPacer = null;
var OUTCAP = 4, outStage = new Float32Array(OUTCAP * REC), outN = 0, outStep = -1;
var stats = null, wEps = 1;
var hitsOnHuman = 0, hitsOnAgent = 0, shotsFired = 0;

var cv = $('game'), ctx = cv.getContext('2d', { alpha: false });
var cw = 0, ch = 0, scale = 1, dpr = 1;

var lastW = 0, lastDpr = 0;
function resize(force) {
  var box = $('arena').getBoundingClientRect();
  var w = Math.max(320, Math.round(box.width));
  var d = Math.min(window.devicePixelRatio || 1, 2);
  if (!force && w === lastW && d === lastDpr) return;
  lastW = w; lastDpr = d;
  var h = Math.round(w * C.H / C.W);
  dpr = d;
  cw = w; ch = h; scale = w / C.W;
  cv.style.height = h + 'px';
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (window.LCViz) LCViz.resize(w, h);
  draw();
}

var HULL = [1.7, 0, -0.9, 0.9, -0.45, 0, -0.9, -0.9];
function shipPath(g, x, y, c, sn, r) {
  var k = r * scale;
  g.beginPath();
  for (var i = 0; i < 8; i += 2) {
    var lx = HULL[i] * k, ly = HULL[i + 1] * k;
    var qx = x + lx * c - ly * sn, qy = y + lx * sn + ly * c;
    if (i === 0) g.moveTo(qx, qy); else g.lineTo(qx, qy);
  }
  g.closePath();
}

var GH = new Float64Array(18), ghN = 0;
function ghosts(wx, wy) {
  var m = 60;
  ghN = 0;
  for (var gx = -1; gx <= 1; gx++) {
    for (var gy = -1; gy <= 1; gy++) {
      var x = wx + gx * C.W, y = wy + gy * C.H;
      if (x < -m || x > C.W + m || y < -m || y > C.H + m) continue;
      GH[ghN * 2] = x * scale; GH[ghN * 2 + 1] = y * scale; ghN++;
    }
  }
}

function drawShip(s, colour, thrusting, turn) {
  ctx.strokeStyle = colour; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
  var a = s.a + turn * C.ROT * ex;
  var c = Math.cos(a), sn = Math.sin(a), k;
  var inv = s.inv - ex;
  ghosts(s.x + s.vx * ex, s.y + s.vy * ex);
  for (k = 0; k < ghN; k++) {
    var px = GH[k * 2], py = GH[k * 2 + 1];
    shipPath(ctx, px, py, c, sn, C.SR);
    ctx.stroke();
    if (thrusting) {
      ctx.beginPath();
      ctx.moveTo(px - c * C.SR * 0.9 * scale, py - sn * C.SR * 0.9 * scale);
      ctx.lineTo(px - c * C.SR * (1.5 + rand() * 0.7) * scale, py - sn * C.SR * (1.5 + rand() * 0.7) * scale);
      ctx.stroke();
    }
    if (inv > 0) {
      ctx.globalAlpha = 0.25 + 0.25 * Math.sin(inv * 22);
      ctx.beginPath();
      ctx.arc(px, py, C.SR * 2.1 * scale, 0, 6.2832);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

function rockR(seed, i, r) {
  var h = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return r * (0.80 + 0.30 * (h - Math.floor(h)));
}
var NV = 9;
var rkPts = new Float64Array(C.NROCK * NV * 2);
var rkSeed = new Int32Array(C.NROCK), rkR = new Float64Array(C.NROCK), rkSc = new Float64Array(C.NROCK);
function rockShape(i, R) {
  if (rkSeed[i] === R.seed && rkR[i] === R.r && rkSc[i] === scale) return;
  rkSeed[i] = R.seed; rkR[i] = R.r; rkSc[i] = scale;
  var o = i * NV * 2;
  for (var v = 0; v < NV; v++) {
    var a = v / NV * 6.2831853, rr = rockR(R.seed, v, R.r) * scale;
    rkPts[o + v * 2] = Math.cos(a) * rr;
    rkPts[o + v * 2 + 1] = Math.sin(a) * rr;
  }
}
function drawRocks() {
  ctx.strokeStyle = 'rgba(243,241,236,0.30)';
  ctx.lineWidth = 1.2;
  ctx.lineJoin = 'round';
  for (var i = 0; i < world.rocks.length; i++) {
    var R = world.rocks[i], o = i * NV * 2;
    rockShape(i, R);
    ghosts(R.x + R.vx * ex, R.y + R.vy * ex);
    for (var k = 0; k < ghN; k++) {
      var px = GH[k * 2], py = GH[k * 2 + 1];
      ctx.beginPath();
      ctx.moveTo(px + rkPts[o], py + rkPts[o + 1]);
      for (var v = 1; v < NV; v++) ctx.lineTo(px + rkPts[o + v * 2], py + rkPts[o + v * 2 + 1]);
      ctx.closePath();
      ctx.stroke();
    }
  }
}

function drawPool(p, colour) {
  ctx.fillStyle = colour;
  var r = Math.max(1.4, C.BR * scale * 0.6);
  for (var i = 0; i < p.n; i++) {
    ghosts(p.x[i] + p.vx[i] * ex, p.y[i] + p.vy[i] * ex);
    for (var k = 0; k < ghN; k++) ctx.fillRect(GH[k * 2] - r, GH[k * 2 + 1] - r, r * 2, r * 2);
  }
}

function draw() {
  if (!cw) return;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);
  ctx.strokeStyle = 'rgba(243,241,236,0.05)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, cw - 1, ch - 1);
  drawRocks();
  drawPool(world.pb, '#f3f1ec');
  drawPool(world.pa, '#E85A1A');
  drawShip(world.b, '#f3f1ec', world._st.thB, world._st.tB);
  drawShip(world.a, '#E85A1A', world._st.thA, world._st.tA);
  if (window.LCViz) LCViz.vision(world, obsA, net, P, mix, curAgentAct);
}

function humanAction() {
  var turn = 0, thrust = 0, fire = 0;
  if (keys.ArrowLeft || keys.a) turn -= 1;
  if (keys.ArrowRight || keys.d) turn += 1;
  if (keys.ArrowUp || keys.w) thrust = 1;
  if (keys[' ']) fire = 1;
  return LC.encode(turn, thrust, fire);
}

function onKey(e) {
  var k = e.key;
  if (k === ' ' || k.indexOf('Arrow') === 0) e.preventDefault();
  var down = e.type === 'keydown';
  keys[k.length === 1 ? k.toLowerCase() : k] = down;
  if (!down) return;
  if (k === 'p' || k === 'P') togglePause();
  if (k === 'v' || k === 'V') onVis();
}

function onVis() {
  var b = $('vis'), on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.className = 'btn' + (on ? ' on' : '');
  wantMix = on ? 1 : 0;
  $('legend').hidden = !on;
  $('obsWrap').hidden = !on;
  // the strip has no width to be measured against until it is on the page
  if (on) resize(true);
}

var learnerHeld = true;

function releaseLearner() {
  learnerHeld = false;
}

var trainOn = false;
function setTraining(on) {
  if (learnerHeld) on = false;
  if (on === trainOn) return;
  trainOn = on;
  if (worker) worker.postMessage({ type: 'pause', on: !on });
}

function bootLearner() {
  var seed = (Math.random() * 1e9) | 0;
  try {
    worker = new Worker('curve-worker.js?v=3');
    worker.onmessage = onWorkerMsg;
    worker.postMessage({ type: 'init', seed: seed, mode: 'normal' });
    worker.postMessage({ type: 'pause', on: true });
  } catch (err) {
    worker = null;
    var sc = document.createElement('script');
    sc.src = 'curve-worker.js?v=3';
    sc.onload = function () {
      solo = new window.LCLearner(seed);
      soloPacer = new window.LCPacer(Math.round(window.LCRates.normal * 0.45));
      P = new Float32Array(solo.P);
      $('chipSolo').hidden = false;
    };
    document.head.appendChild(sc);
  }
}

function noop() {}

function onWorkerMsg(e) {
  var m = e.data;
  if (m.type === 'ready') {
    noop();
  } else if (m.type === 'weights') {
    var buf = m.buf;
    if (!P || P.length !== buf.length) P = new Float32Array(buf.length);
    P.set(buf);
    worker.postMessage({ type: 'recycle', buf: buf.buffer }, [buf.buffer]);
  } else if (m.type === 'stats') {
    onStats(m.s);
  }
}

function pumpSolo() {
  if (!solo || learnerHeld || !trainOn) return;
  soloPacer.run(solo, performance.now(), 4);
  if (!P || P.length !== solo.P.length) P = new Float32Array(solo.P.length);
  P.set(solo.P);
  if (performance.now() - soloStat > 200) {
    soloStat = performance.now();
    var s = solo.stats();
    s.ms = soloPacer.busy; s.duty = 0; s.mode = 'solo'; s.rate = soloPacer.rate;
    s.events = solo.events.splice(0, solo.events.length);
    onStats(s);
  }
}
var soloStat = 0;

function flushLive() {
  if (!outN) return;
  var n = outN, d = new Float32Array(outStage.subarray(0, n * REC)), i;
  var msg = { type: 'live', d: d, n: n, step0: outStep };
  if (worker) worker.postMessage(msg, [d.buffer]);
  else if (solo) {
    for (i = 0; i < n; i++) {
      var o = i * REC;
      solo.addLive(outStep + i, d, o, d[o + NOBS * 2 + NRC], d[o + NOBS * 2 + NRC + 1],
        d[o + NOBS * 2 + NRC + 2], d[o + NOBS * 2 + NRC + 3], d, o + NOBS * 2,
        d[o + NOBS * 2 + NRC + 5], d[o + NOBS * 2 + NRC + 6]);
      solo.addHuman(d, o + NOBS, d[o + NOBS * 2 + NRC + 4]);
    }
  }
  outN = 0; outStep = -1;
}

function recordLive(st, act, hact, r, done, hitSrc) {
  var o = outN * REC, i;
  outStage.set(obsA, o);
  outStage.set(obsH, o + NOBS);
  for (i = 0; i < NRC; i++) outStage[o + NOBS * 2 + i] = ev.rc[i];
  var b = o + NOBS * 2 + NRC;
  outStage[b] = act; outStage[b + 1] = r; outStage[b + 2] = done ? 1 : 0;
  outStage[b + 3] = hitSrc; outStage[b + 4] = hact;
  outStage[b + 5] = world.rel[0]; outStage[b + 6] = world.rel[1];
  if (outStep < 0) outStep = st;
  outN++;
  if (outN >= OUTCAP) flushLive();
}

function beginRound() {
  world.reset(rand);
  sub = 0; pending = false; acc = 0;
  roundNo++;
  $('sRound').textContent = roundNo;
  setTraining(true);
}

function endRound(agentWon, draw_) {
  flushLive();
  setTraining(false);
  closeWindow();
  var restored = false;
  if (agentWon) {
    lives--;
    hitsOnHuman++;
  } else if (!draw_) {
    hitsOnAgent++;
    restored = lives < 3;
    lives = 3;
  }
  paintLives();
  if (lives <= 0) return gameOver();
  state = 'between';
  showCard('',
    agentWon ? (lives + (lives === 1 ? ' life left' : ' lives left'))
      : restored ? ('Round ' + roundNo + ', back to 3 lives')
      : ('Round ' + roundNo),
    '', null);
  cardTimer = performance.now() + 1200;
}

var ID_KEY = 'lc.id.v1';
var playerId = null;
function myId() {
  if (playerId) return playerId;
  try { playerId = localStorage.getItem(ID_KEY); } catch (e) {}
  if (!playerId || !/^[0-9a-f-]{8,40}$/.test(playerId)) {
    playerId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : (Date.now().toString(16) + Math.random().toString(16).slice(2, 10));
    try { localStorage.setItem(ID_KEY, playerId); } catch (e) {}
  }
  return playerId;
}

var BOARD_SHOWN = 5;

function setBoardOpen(on, extra) {
  $('board').classList.toggle('open', !!on);
  var btn = $('boardMore');
  btn.textContent = on ? 'Show less' : 'Show ' + extra + ' more';
  btn.setAttribute('aria-expanded', on ? 'true' : 'false');
}

function paintBoard(rows, note) {
  if (!rows || !rows.length) return;
  var ol = $('boardList');
  ol.innerHTML = '';
  var mine = -1;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var li = document.createElement('li');
    var cls = '';
    if (r.me) { cls = 'me'; mine = i; }
    if (i >= BOARD_SHOWN) cls += (cls ? ' ' : '') + 'hid';
    li.className = cls;
    var b = document.createElement('b');
    b.textContent = fmt(r.grad) + ' steps';
    var mid = document.createElement('span');
    mid.textContent = r.name;
    var when = document.createElement('span');
    when.className = 'when';
    when.textContent = r.rounds + ' rounds';
    li.appendChild(b); li.appendChild(mid); li.appendChild(when);
    ol.appendChild(li);
  }
  $('boardNote').textContent = note || '';
  var extra = rows.length - BOARD_SHOWN;
  $('boardMore').hidden = extra <= 0;
  setBoardOpen(extra > 0 && mine >= BOARD_SHOWN, extra);
  $('board').hidden = false;
}

function loadBoard() {
  fetch('/api/curve-board?me=' + encodeURIComponent(myId()), { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d) paintBoard(d.rows, d.total ? d.total + ' recorded' : ''); })
    .catch(function () {});
}

function submitScore(grad, rounds, seconds, done) {
  if (!grad) { done(false); return; }
  fetch('/api/curve-board', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: myId(), grad: grad, rounds: rounds, seconds: Math.round(seconds) })
  })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) { done(false); return; }
      paintBoard(d.rows, d.total ? d.total + ' recorded' : '');
      done(!!d.improved && d.rank === 1);
    })
    .catch(function () { done(false); });
}

function gameOver() {
  state = 'over';
  running = false;
  setTraining(false);
  var mm = Math.floor(survived / 60), ss = Math.floor(survived % 60);
  var t = mm + ':' + (ss < 10 ? '0' : '') + ss;
  var steps = fmt(scoreGrad);
  var counted = ranked;
  ranked = false;
  if (counted) {
    submitScore(scoreGrad, roundNo, survived, function (top) {
      if (top) $('cardK').textContent = 'Game over, top of the board';
    });
  }
  showCard('Game over', 'It beat you after ' + t + '.',
    'It needed ' + steps + ' training steps to win three rounds in a row.'
      + (counted ? '' : ' Not on the board: these weights had already played a game.'),
    [['Play on', retry], ['Reset the weights', newBrain]]);
}

function retry() {
  lives = 3; survived = 0; roundNo = 0;
  resetScore();
  paintLives(); hideCard();
  state = 'playing'; running = true;
  beginRound(); start();
}

function newBrain() {
  lives = 3; survived = 0; roundNo = 0;
  ranked = true;
  var seed = (Math.random() * 1e9) | 0;
  if (worker) worker.postMessage({ type: 'newBrain', seed: seed });
  else if (solo) solo.newBrain(seed);
  stats = null;
  resetScore();
  if (window.LCViz) LCViz.clear();
  paintLives(); hideCard();
  state = 'playing'; running = true;
  beginRound(); start();
}

function paintLives() {
  var el = $('lives'), kids = el.children;
  for (var i = 0; i < kids.length; i++) kids[i].className = i < lives ? '' : 'gone';
}

var TUTORIAL = [
  ['',
   'You fly the white ship.',
   'Arrows or WASD to turn and thrust, space to fire.'],
  ['',
   'The orange ship is a neural network that starts from random weights.',
   'It trains in the background on games it plays against itself, and once it has watched you for a while the opponent in those games is a copy of how you play. It also learns from the real rounds against you.'],
  ['',
   'See how long you can survive.',
   '']
];
function tutorial(step) {
  state = 'tutorial';
  var t = TUTORIAL[step];
  var last = step === TUTORIAL.length - 1;
  showCard(t[0], t[1], t[2], last
    ? [['▶ Start', onStart]]
    : [['Next', function () { tutorial(step + 1); }], ['Skip', onStart]]);
}

function showCard(k, t, p, buttons) {
  $('cardK').textContent = k;
  $('cardK').hidden = !k;
  $('cardT').textContent = t;
  $('cardP').textContent = p || '';
  var row = $('cardRow');
  row.innerHTML = '';
  if (buttons) {
    buttons.forEach(function (b, i) {
      var el = document.createElement('button');
      el.className = 'btn' + (i === 0 ? ' primary' : '');
      el.type = 'button';
      el.textContent = b[0];
      el.addEventListener('click', b[1]);
      row.appendChild(el);
    });
  }
  $('card').hidden = false;
}
function hideCard() { $('card').hidden = true; }

function controlStep() {
  world.observe(0, obsA, 0);
  world.observe(1, obsH, 0);
  var q = null;
  var na = LC.nActions(world, 0);
  if (P) {
    q = net.fwd(P, obsA, 0);
    var eps = Math.min(0.03, wEps);
    curAgentAct = rand() < eps ? (rand() * na) | 0 : net.argmaxN(na);
  } else {
    curAgentAct = (rand() * na) | 0;
  }
  curHumanAct = humanAction();
  stepIdx = world.step;
  world.beginStep(curAgentAct, curHumanAct, ev);
  if (ev.fired) shotsFired++;
  pending = true; sub = 0;
}

function finishStep() {
  world.endStep(ev, world.roundT * C.CDT);
  pending = false;
  recordLive(stepIdx, curAgentAct, curHumanAct, ev.r, ev.done, ev.hitSrc);
  stepped = true;
  if (ev.hitSrc !== -2 || ev.gotHit) winHit = true;
  if (++winSteps >= C.ROUND_STEPS) closeWindow();
  if (ev.done) endRound(ev.hitSrc !== -2, ev.draw);
}

function physics(dt) {
  acc += dt;
  var guard = 0;
  while (acc >= C.DT && guard < 8) {
    if (!pending) {
      if (state !== 'playing') { acc = 0; break; }
      controlStep();
    }
    var resolved = world.tickOnce(ev);
    acc -= C.DT; guard++;
    if (resolved || world._st.sub >= C.REPEAT) { finishStep(); if (state !== 'playing') { acc = 0; break; } }
  }
  if (guard >= 8) acc = 0;
  ex = acc;
}

function loop(ts) {
  if (!running && state !== 'between') { rafId = 0; return; }
  var dt = last ? Math.min(0.1, (ts - last) / 1000) : 1 / 60;
  last = ts;
  mix += (wantMix - mix) * Math.min(1, dt * 8);
  if (mix < 0.002) mix = 0;

  if (state === 'between' && ts >= cardTimer) { hideCard(); state = 'playing'; beginRound(); }
  if (state === 'playing') { physics(dt); survived += dt; } else { acc = 0; ex = 0; }
  if (solo) pumpSolo();
  draw();
  if (panelsSeen && window.LCViz) LCViz.frame(world, obsA, net, P, mix, curAgentAct);
  hud(ts);
  rafId = requestAnimationFrame(loop);
}

function start() {
  if (rafId || !visible) return;
  last = 0; acc = 0;
  rafId = requestAnimationFrame(loop);
}
function stop() { if (rafId) cancelAnimationFrame(rafId); rafId = 0; }

function togglePause() {
  if (state !== 'playing' && state !== 'paused') return;
  if (state === 'playing') {
    state = 'paused'; running = false; stop();
    setTraining(false);
    showCard('', 'Paused', 'Press P or the button to resume.', [['Resume', togglePause]]);
  } else {
    state = 'playing'; running = true; hideCard();
    setTraining(true);
    start();
  }
}

var lastHud = 0;
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return '' + Math.round(n);
}
var hudT = '', hudG = '';
function hud(ts) {
  if (ts - lastHud < 160) return;
  lastHud = ts;
  var mm = Math.floor(survived / 60), ss = Math.floor(survived % 60);
  var t = mm + ':' + (ss < 10 ? '0' : '') + ss;
  if (t !== hudT) { hudT = t; $('sTime').textContent = t; }
  if (stats) {
    var g = fmt(stats.grad);
    if (g !== hudG) { hudG = g; $('sGrad').textContent = g; }
  }
  if (DEBUG && stats) {
    $('dbg').textContent =
      'grad/s target ' + Math.round(stats.rate) + '   worker ' + stats.ms.toFixed(1) + 'ms/slice' +
      '\nduty ' + (100 * (stats.duty || 0)).toFixed(0) + '%   mode ' + stats.mode +
      '\nbuf dream ' + stats.bufDream + '  live ' + stats.bufLive + '  human ' + stats.human +
      '\nq ' + stats.q.toFixed(2) + '  loss ' + stats.loss.toFixed(4) + '  |g| ' + stats.gnorm.toFixed(2) +
      '\nrollbacks ' + stats.rollbacks + '   eps ' + stats.eps.toFixed(3);
  }
}

function onStats(s) {
  if (!stats || !stepped) winBase = s.grad;
  stepped = false;
  stats = s;
  wEps = s.eps;
  if (window.LCViz) LCViz.stats(s);
}

function init() {
  paintLives();
  resize();
  bootLearner();

  if ('ResizeObserver' in window) new ResizeObserver(function () { resize(); }).observe($('arena'));
  else window.addEventListener('resize', function () { resize(); });

  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  $('vis').addEventListener('click', onVis);
  $('start').addEventListener('click', onStart);
  $('cardBtn').addEventListener('click', onStart);
  $('brain').addEventListener('click', newBrain);
  $('pause').addEventListener('click', togglePause);
  $('boardMore').addEventListener('click', function () {
    var extra = $('boardList').children.length - BOARD_SHOWN;
    setBoardOpen(!$('board').classList.contains('open'), extra);
  });
  if (DEBUG) $('dbg').hidden = false;

  document.addEventListener('visibilitychange', function () {
    var hid = document.hidden;
    if (hid) { setTraining(false); stop(); }
    else { if (state === 'playing') setTraining(true); if (running || state === 'between') start(); }
  });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        visible = en.isIntersecting;
        if (!visible) { setTraining(false); stop(); }
        else {
          if (state === 'playing') setTraining(true);
          if (running || state === 'between') start();
        }
      });
    }, { threshold: 0.05 }).observe($('arena'));

    var panelHost = document.querySelector('.panels');
    if (panelHost) new IntersectionObserver(function (es) {
      var on = es[es.length - 1].isIntersecting;
      if (on === panelsSeen) return;
      panelsSeen = on;
      if (window.LCViz) LCViz.panels(on);
    }, { threshold: 0 }).observe(panelHost);
  }

  wireHelp();

  if (reduce) {
    showCard('Reduced motion', 'Animation is off, so this runs a step at a time.',
      'The agent still trains in the background. Step the duel forward to watch the panels move.',
      [['Run 5 seconds', function () { stepFor(5); }], ['Train 30 seconds', function () { trainFor(30); }]]);
    world.reset(rand);
    draw();
    setInterval(function () { if (solo) pumpSolo(); if (stats && window.LCViz) LCViz.redraw(); }, 400);
    return;
  }

  world.reset(rand);
  draw();
  loadBoard();
  tutorial(0);
  var els = document.querySelectorAll('.reveal');
  requestAnimationFrame(function () { for (var i = 0; i < els.length; i++) els[i].classList.add('in'); });
}

function wireHelp() {
  var tips = document.querySelectorAll('.chelp,.phelp');
  if (!tips.length) return;
  var open = null, M = 12, PAD = 10;

  function place(tip) {
    var host = tip.parentNode, near = host.closest && host.closest('.panel');
    var far = host.closest && host.closest('.panels');
    var r = host.getBoundingClientRect();
    var b = (near || host).getBoundingClientRect();
    var s = (far || near || host).getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    var w = tip.offsetWidth, h = tip.offsetHeight, left, top;
    if (s.left - M - w >= PAD) {
      left = s.left - M - w; top = r.top + r.height / 2 - h / 2;
    } else if (s.right + M + w <= vw - PAD) {
      left = s.right + M; top = r.top + r.height / 2 - h / 2;
    } else {
      left = b.left; top = b.bottom + M;
      if (top + h > vh - PAD) top = b.top - M - h;
    }
    tip.style.left = Math.max(PAD, Math.min(vw - w - PAD, left)) + 'px';
    tip.style.top = Math.max(PAD, Math.min(vh - h - PAD, top)) + 'px';
  }
  function hide() { if (open) { open.classList.remove('on'); open = null; } }
  function show(tip) {
    if (open === tip) return;
    hide();
    place(tip);
    tip.classList.add('on');
    open = tip;
  }

  for (var i = 0; i < tips.length; i++) (function (tip) {
    var host = tip.parentNode;
    host.addEventListener('pointerenter', function () { show(tip); });
    host.addEventListener('pointerleave', hide);
    host.addEventListener('focus', function () { show(tip); });
    host.addEventListener('blur', hide);
  })(tips[i]);

  addEventListener('scroll', function () { if (open) place(open); }, { passive: true });
  addEventListener('resize', function () { if (open) place(open); });
  addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
}

function stepFor(secs) {
  var n = Math.round(secs / C.CDT);
  state = 'playing';
  for (var i = 0; i < n && state === 'playing'; i++) {
    controlStep();
    for (var k = 0; k < C.REPEAT; k++) if (world.tickOnce(ev)) break;
    finishStep();
    survived += C.CDT;
  }
  if (state === 'between') { state = 'playing'; beginRound(); }
  draw();
  if (window.LCViz) { LCViz.frame(world, obsA, net, P, mix, curAgentAct); LCViz.redraw(); }
}
function trainFor(secs) {
  var end = performance.now() + secs * 1000;
  (function pump() {
    if (solo) pumpSolo();
    if (window.LCViz) LCViz.redraw();
    if (performance.now() < end) setTimeout(pump, 50);
  })();
}

function onStart() {
  if (state === 'playing') return;
  releaseLearner();
  hideCard();
  lives = 3; survived = 0; roundNo = 0;
  resetScore();
  paintLives();
  state = 'playing'; running = true;
  $('start').textContent = '▶ Restart';
  beginRound();
  start();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
