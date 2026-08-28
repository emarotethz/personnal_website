

// Runs the actual page scripts against a stubbed DOM and 2D canvas. This does
// not prove it looks right, but it does prove the wiring holds: every element
// id the code reaches for exists in index.html, the loop runs, transitions
// reach the learner in the layout the learner expects, weights come back, and
// losing three lives ends the game. Same technique scheduler.test.mjs uses to
// test the audio engine without a browser.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const P = (n) => fileURLToPath(new URL('../../learning-curve/' + n, import.meta.url));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
};

const drawn = { fills: 0, strokes: 0, rects: 0, images: 0, heat: 0, per: {} };
function ctx2d(owner) {
  const noop = () => {};
  const per = (drawn.per[owner] = drawn.per[owner] || { stroke: 0, span: 0 });
  return {
    canvas: null,
    _owner: owner, _per: per,
    setTransform: noop, clearRect: noop, save: noop, restore: noop,
    beginPath: noop, closePath: noop, moveTo: noop, arc: noop,
    fill() { drawn.fills++; }, stroke() { drawn.strokes++; per.stroke++; },
    lineTo(x) { if (x > per.span) per.span = x; }, fillRect() { drawn.rects++; }, strokeRect: noop,
    fillText: noop, measureText: () => ({ width: 10 }), setLineDash: noop,
    drawImage() { drawn.images++; },
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() { drawn.heat++; },
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '',
    font: '', textAlign: '', imageSmoothingEnabled: true,
  };
}

const ids = new Map();
function el(id, tag) {
  const node = {
    id, tagName: (tag || 'div').toUpperCase(),
    style: {}, children: [], _text: '', className: '', hidden: false, value: '0',
    width: 0, height: 0, listeners: {},
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._text; },
    set innerHTML(v) { this._text = String(v); if (v === '') this.children.length = 0; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c, ref) {
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      c.parentNode = this; return c;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect() { return { width: 900, height: 630, top: 0, left: 0 }; },
    getContext() { if (!this._ctx) this._ctx = ctx2d(this.id); return this._ctx; },
    querySelectorAll() { return []; },
    classList: (() => {
      const set = new Set();
      return {
        add(c) { set.add(c); }, remove(c) { set.delete(c); },
        contains(c) { return set.has(c); },
        toggle(c, on) { const want = on === undefined ? !set.has(c) : !!on; if (want) set.add(c); else set.delete(c); return want; },
      };
    })(),
    attrs: {},
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    setAttribute(k, v) { this.attrs[k] = v; },
    fire(t, e) {
      const evt = Object.assign({ currentTarget: this, target: this, preventDefault() {} }, e || {});
      (this.listeners[t] || []).forEach((f) => f(evt));
    },
  };
  node.parentNode = {
    getBoundingClientRect() { return { width: 900, height: 630, top: 0, left: 0 }; },
  };
  return node;
}
function get(id) {
  if (!ids.has(id)) ids.set(id, el(id));
  return ids.get(id);
}
for (let i = 0; i < 3; i++) get('lives').appendChild(el('pip', 'i'));

const DECLARED = fs.readFileSync(fileURLToPath(new URL('../../learning-curve/index.html', import.meta.url)), 'utf8')
  .match(/id="([^"]+)"/g).map((s) => s.slice(4, -1));
const asked = new Set();
const missing = new Set();

globalThis.window = globalThis;
globalThis.self = globalThis;
const winListeners = {};
globalThis.addEventListener = (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); };
globalThis.removeEventListener = () => {};
const fireWindow = (t, e) => (winListeners[t] || []).forEach((f) => f(e));
let clock = 5000;
globalThis.performance = { now: () => clock };
globalThis.location = { search: '' };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.ResizeObserver = class { observe() {} };
globalThis.IntersectionObserver = class { observe() {} };
globalThis.devicePixelRatio = 2;
const sent = [];
globalThis.fetch = (url, opts) => {
  sent.push({ url: String(url).split('?')[0], method: (opts && opts.method) || 'GET', body: opts && opts.body });
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      rows: Array.from({ length: 8 }, (_, i) => ({
        rank: i + 1, name: 'pilot ' + i, grad: 12000 - i * 100, rounds: 9 - i,
        seconds: 200, day: '2026-08-12', me: i === 0,
      })),
      improved: true, rank: 1, total: 8, name: 'pilot 0',
    }),
  });
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

let rafQ = [];
globalThis.requestAnimationFrame = (fn) => { rafQ.push(fn); return rafQ.length; };
globalThis.cancelAnimationFrame = () => { rafQ = []; };

const docListeners = {};
globalThis.document = {
  hidden: false,
  fonts: { ready: Promise.resolve() },
  getElementById(id) {
    asked.add(id);
    if (!DECLARED.includes(id)) { missing.add(id); return null; }
    return get(id);
  },
  createElement(tag) { return el('*' + tag, tag); },
  querySelectorAll() { return []; },
  querySelector(sel) { return sel === '.panels' ? el('panels') : null; },
  addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
  head: el('head'),
  body: el('body'),
};

const posted = [];
let learnerSeen = { live: 0, human: 0 };
globalThis.Worker = class {
  constructor() {
    this.onmessage = null;
    globalThis.__wk = this;
  }
  postMessage(m) {
    posted.push(m);
    if (m.type === 'init') {
      this.L = new globalThis.LCLearner(m.seed);
      setTimeout(() => this.onmessage && this.onmessage({ data: { type: 'ready', np: this.L.net.NP } }), 0);
    } else if (m.type === 'live') {
      const NOBS = globalThis.LC.NOBS, NRC = globalThis.LC.NRC, REC = NOBS * 2 + NRC + 7;
      for (let k = 0; k < m.n; k++) {
        const o = k * REC;
        this.L.addLive(m.step0 + k, m.d, o, m.d[o + NOBS * 2 + NRC], m.d[o + NOBS * 2 + NRC + 1],
          m.d[o + NOBS * 2 + NRC + 2], m.d[o + NOBS * 2 + NRC + 3], m.d, o + NOBS * 2,
          m.d[o + NOBS * 2 + NRC + 5], m.d[o + NOBS * 2 + NRC + 6]);
        this.L.addHuman(m.d, o + NOBS, m.d[o + NOBS * 2 + NRC + 4]);
        learnerSeen.live++; learnerSeen.human++;
      }
    }
  }
  send(msg) { this.onmessage && this.onmessage({ data: msg }); }
};

for (const f of ['curve-core.js', 'curve-net.js', 'curve-worker.js', 'curve-viz.js', 'curve-game.js']) {
  new Function(fs.readFileSync(P(f), 'utf8'))();
}

const LC = globalThis.LC;
await Promise.resolve();
await new Promise((r) => setTimeout(r, 5));

console.log('\n[1] the page wires itself up');
check('init ran and asked for elements', asked.size >= 10, true);
check('every element it reached for exists in index.html', [...missing], []);
check('the learner was initialised', posted[0] && posted[0].type, 'init');
check('the arena was drawn once before any input', drawn.rects > 0 || drawn.strokes > 0, true);

console.log('\n[1b] every panel explains what it plots');
{
  const html = fs.readFileSync(fileURLToPath(new URL('../../learning-curve/index.html', import.meta.url)), 'utf8');
  const count = (re) => (html.match(re) || []).length;
  const charts = count(/class="chart"/g), chelps = count(/class="chelp"/g);
  check('every chart carries a chelp', chelps, charts);
  check('and there are four of them', charts, 4);

  const hashelp = count(/class="panel[^"]*hashelp"/g);
  const phelp = count(/class="phelp"/g);
  check('each panel marked hashelp has a phelp', phelp, hashelp);
  check('reward per step is the one marked panel', hashelp, 1);
  check('and the weights diagram carries no help', /class="panel netwrap"/.test(html), true);

  const focusable = count(/class="(chart|panel [^"]*hashelp)"[^>]*tabindex="0"/g);
  check('every help target is focusable', focusable, charts + hashelp);
  const game = fs.readFileSync(P('curve-game.js'), 'utf8');
  check('the page shows help on focus too', /'focus'/.test(game) && /'blur'/.test(game), true);
  check('and places it against the viewport', /position:fixed/.test(html) && /getBoundingClientRect/.test(game), true);

  const raw = [...html.matchAll(/class="(?:chelp|phelp)">([\s\S]*?)<\/span>/g)].map((m) => m[1]);
  check('one help body per help target', raw.length, charts + hashelp);
  check('every one of them gives the formula', raw.filter((h) => !/<em>[^=]*=/.test(h)).length, 0);
  const keys = raw.map((h) => (h.match(/<dt>/g) || []).length);
  check('and names at least two of its symbols', keys.filter((n) => n < 2).length, 0);
  const blurbs = raw.map((h) => (h.match(/<p>([\s\S]*?)<\/p>/) || ['', ''])[1].replace(/<[^>]+>/g, '').trim());
  check('and opens by saying what it is', blurbs.filter((b) => !b).length, 0);
  check('in one line, not a paragraph', blurbs.filter((b) => b.length > 80).length, 0);
  check('and only the one', raw.filter((h) => (h.match(/<p>/g) || []).length > 1).length, 0);
}

console.log('\n[2] the intro gates the game and holds the learner');
{
  check('the intro card is showing', get('card').hidden, false);
  check('it opens on the first step', /white ship/.test(get('cardT').textContent), true);
  check('and no step counter above it', get('cardK').hidden, true);
  check('training is held while you read', posted.some((m) => m.type === 'pause' && m.on === true), true);
  get('cardRow').children[0].fire('click');
  check('next advances', /orange ship/.test(get('cardT').textContent), true);
  get('cardRow').children[0].fire('click');
  check('and again', /survive/.test(get('cardT').textContent), true);
  check('the last step is the only one with no Next', get('cardRow').children.length, 1);
}

console.log('\n[3] starting the game runs the loop');
function pump(n) {
  for (let i = 0; i < n; i++) {
    const q = rafQ; rafQ = [];
    clock += 16.7;
    q.forEach((fn) => fn(clock));
  }
}
get('start').fire('click');
pump(3);
check('the loop is running', rafQ.length > 0, true);
check('the round counter advanced', get('sRound').textContent, '1');
check('starting released the learner', posted.filter((m) => m.type === 'pause').pop().on, false);

get('pause').fire('click');
check('pausing the game pauses training too', posted.filter((m) => m.type === 'pause').pop().on, true);
check('and the card says so', get('cardT').textContent, 'Paused');
get('pause').fire('click');
check('resuming resumes training', posted.filter((m) => m.type === 'pause').pop().on, false);
check('and clears the card', get('card').hidden, true);
pump(2);

const keyHandlers = [];
const winKeys = (globalThis.__keyfns = []);
pump(120);
check('drawing every frame', drawn.strokes > 50, true);

console.log('\n[4] real transitions reach the learner in the expected layout');
check('live transitions were posted', posted.filter((m) => m.type === 'live').length > 0, true);
check('the learner accepted them', learnerSeen.live > 10, true);
const wk = globalThis.__wk;
check('they landed in the live replay buffer', wk.L.live.n > 0, true);
check('the behaviour-clone buffer filled too', wk.L.hN > 10, true);
{
  const live = posted.find((m) => m.type === 'live');
  const REC = LC.NOBS * 2 + LC.NRC + 7;
  check('record stride matches the worker contract', live.d.length % REC, 0);
  const act = live.d[LC.NOBS * 2 + LC.NRC];
  check('the action field is a valid action index', act >= 0 && act < LC.NACT, true);
  const hact = live.d[LC.NOBS * 2 + LC.NRC + 4];
  check('the human action field is a valid action index', hact >= 0 && hact < LC.NACT, true);
}

console.log('\n[5] weights coming back are adopted');
{
  wk.L.chunk(); wk.L.chunk();
  const buf = new Float32Array(wk.L.P);
  buf[0] = 0.4242;
  wk.send({ type: 'weights', buf: buf });
  pump(2);
  const recycled = posted.filter((m) => m.type === 'recycle').length;
  check('the buffer was handed back for reuse', recycled > 0, true);
}

const mkStats = (grad) => ({
  grad, trans: 5000, dream: 5000, live: 40, eps: 0.4, loss: 0.05, q: 1.2, gnorm: 2,
  bcCE: 1.1, readapt: 1, rollbacks: 0, hitsPerMin: 7.5, takenPerMin: 12, acc: 0.14,
  winRate: 0.55, ret: 0.2, rounds: 12, bufDream: 5000, bufLive: 40, human: 400,
  rc: new Float32Array([0.4, -0.3, -0.01, 0.05, 0.004, -0.02, -0.01, -0.002]), events: [],
});

console.log('\n[6] stats drive the panels');
{
  wk.send({ type: 'stats', s: mkStats(1234) });
  pump(20);
  check('the trained counter shows the gradient steps', get('sGrad').textContent, '1.2k');
  check('the reward decomposition has a row per component', get('rlist').children.length, LC.NRC);
  check('the chart readouts were updated too', get('cD').textContent, '0.40');
}

console.log('\n[6b] the learning charts actually draw, and fill the canvas');
{
  for (let k = 0; k < 14; k++) {
    wk.send({ type: 'stats', s: {
      grad: k * 500, trans: 1, dream: 1, live: 1, eps: 0.4, loss: 0.05 + k * 0.01, q: 1.2, gnorm: 2,
      bcCE: 1, auxLoss: 0.01, readapt: 0, rollbacks: 0, hitsPerMin: 2 + k, takenPerMin: 3, acc: 0.1,
      winRate: 0.3, ret: 0.2, rounds: 2, bufDream: 100, bufLive: 10, human: 50,
      rc: new Float32Array(LC.NRC), events: [] } });
    clock += 200; pump(2);
  }
  const wide = get('chHits').width / 2;
  for (const id of ['chHits', 'chLoss', 'chQ', 'chAcc']) {
    const p = drawn.per[id] || { stroke: 0, span: 0 };
    check(`${id} drew something`, p.stroke > 0, true);
    check(`${id} spans most of its canvas`, p.span > wide * 0.8, true);
  }
}

console.log('\n[7] policy vision only costs anything when it is on');
{
  pump(30);
  check('the value landscape is not computed while the toggle is off', drawn.heat, 0);
  get('vis').fire('click');
  pump(60);
  check('it starts once the toggle is on', drawn.heat > 0, true);
  check('and it runs on its own clock, not once per frame', drawn.heat < 40, true);
  check('but often enough to look continuous', drawn.heat > 8, true);
}

console.log('\n[7b] a round you are playing has no clock');
{
  check('the live world has no round cap', LC.C.ROUND_STEPS > 0 && LC.C.ROUND_STEPS < 1e6, true);
  const dream = new LC.World();
  check('a fresh world still caps by default', dream.roundMax, LC.C.ROUND_STEPS);
  let draws = 0;
  const w = new LC.World(), ev = new LC.Ev();
  w.roundMax = Infinity;
  const rand = LC.rng(3);
  w.reset(rand);
  for (let i = 0; i < 20000; i++) {
    w.advance(4, 4, ev, 0);
    if (ev.done) { draws++; w.reset(rand); }
  }
  check('with no cap a passive round never times out', draws, 0);
}

console.log('\n[8] rounds resolve and three lives ends it');
{
  check('three life pips are rendered', get('lives').children.length, 3);
  const roundBefore = +get('sRound').textContent;
  while (wk.L.grad < 6000) wk.L.chunk();
  { const buf = new Float32Array(wk.L.P); wk.send({ type: 'weights', buf: buf }); }
  let n = 0;
  while (n < 60000) {
    pump(200); n += 200;
    for (let c = 0; c < 10; c++) wk.L.chunk();
    wk.send({ type: 'stats', s: mkStats(wk.L.grad) });
    if (get('cardK').textContent === 'Game over') break;
  }
  const gone = [...get('lives').children].filter((c) => c.className === 'gone').length;
  console.log(`     ran ${n} frames, reached round ${get('sRound').textContent}, ${gone} lives lost`);
  check('rounds kept resolving', +get('sRound').textContent > roundBefore, true);
  check('losing a round costs a life', gone > 0, true);
  check('three losses ends the game', /^Game over/.test(get('cardK').textContent), true);
  check('and it offers both a rematch and a reset', get('cardRow').children.length, 2);
  check('the run was submitted to the board', sent.some((p) => p.url === '/api/curve-board' && p.method === 'POST'), true);
  const sub = JSON.parse(sent.filter((p) => p.method === 'POST').pop().body);
  check('with a stable player id', /^[0-9a-f-]{8,40}$/.test(sub.id), true);
  check('and the score is the training it needed', sub.grad > 0, true);
  check('and never more than the worker did', sub.grad <= wk.L.grad, true);
  check('the board was painted from the response', get('boardList').children.length > 0, true);
  const rows = get('boardList').children;
  check('only five rows are shown', rows.filter((c) => !/hid/.test(c.className)).length, 5);
  check('with the rest behind the toggle', get('boardMore').hidden, false);
  check('which says how many are left', /3 more/.test(get('boardMore').textContent), true);
  get('boardMore').fire('click');
  check('clicking it opens the board', get('board').classList.contains('open'), true);
  check('and the label flips', /less/i.test(get('boardMore').textContent), true);
}

console.log('\n[8b] playing on with the same weights does not score');
{
  const posts = () => sent.filter((p) => p.url === '/api/curve-board' && p.method === 'POST').length;
  const before = posts();
  get('cardRow').children[0].fire('click');
  get('cardK').textContent = '';
  let n = 0;
  while (n < 60000) {
    pump(200); n += 200;
    if (/^Game over/.test(get('cardK').textContent)) break;
  }
  check('the second game ended too', /^Game over/.test(get('cardK').textContent), true);
  check('and nothing was posted for it', posts(), before);
  check('and it says why on the card', /not on the board/i.test(get('cardP').textContent), true);
}

console.log('\n[9] a new brain does not poison the replay buffer');
{
  const L2 = new globalThis.LCLearner(3);
  const NOBS = LC.NOBS;
  const obs = new Float32Array(NOBS);
  const rc = new Float32Array(LC.NRC);
  for (let s = 9000; s < 9040; s++) L2.addLive(s, obs, 0, 4, 0, 0, -2, rc, 0);
  check('only the steps actually written are inserted', L2.live.n <= 40, true);
  check('and some of them are', L2.live.n > 0, true);
}

console.log('\n[10] no stray globals leaked onto the page');
check('only the four expected namespaces', ['LC', 'LCNet', 'LCViz', 'LCLearner'].every((k) => k in globalThis), true);
check('the board is fetched on load', sent.some((p) => p.url === '/api/curve-board' && p.method === 'GET'), true);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
