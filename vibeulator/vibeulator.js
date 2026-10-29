// The page side: the keypad, streaming the answer out of engine.js one token at
// a time, and checking it against calc.js. The model and its training live in
// their own repo, github.com/emarotethz/vibeulator; engine.js and calc.js are
// copied from there unchanged.
(function () {
'use strict';

var $ = function (id) { return document.getElementById(id); };
var Calc = window.VibCalc;
var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
var WEIGHTS = 'vibeulator.bin?v=5', EVAL = 'eval.json?v=17';
var MAXK = 30, DELAY = reduce ? 0 : 70, TEMP = 1;   // MAXK becomes the model's own limit once it loads

var SHOW = { '*': '×', '/': '÷', '-': '−', 'r': '√', 's': 'sin', 'c': 'cos', 't': 'tan', 'l': 'log', 'n': 'ln', 'p': 'π',
             'R': 'rad ', 'E': 'Error', 'S': 'Syntax error', '<eos>': 'end' };
function show(t) { return SHOW[t] || t; }
function showAll(s) { var o = ''; for (var i = 0; i < s.length; i++) o += show(s[i]); return o; }

var model = null, state = 'loading';
var keys = [];        // the expression being typed, one token per entry
var result = null;    // { keys, input, text, steps, truth, done } for the answer on screen
var run = 0;          // bumped to abandon an answer that is still streaming
var rad = false;      // angles in radians; the model is told with a leading R
var REV = false;      // weights that write answers backwards, least significant digit first

function flip(s) { return s.split('').reverse().join(''); }

// ---- answering ---------------------------------------------------------------

// What the model reads for k: multiplication written out, brackets closed, and
// an R in front when it's in radians and there's an angle to read.
function input(k, closed) {
  var s = Calc.explicit(k.join('')), r = rad && /[sct]/.test(s) ? Calc.RAD : '';
  return r + (closed ? Calc.close(s, MAXK - r.length) : s);
}

// Every answer is sampled, one token at a time, so asking again can differ.
function ask() {
  if (!keys.length) return;
  var my = ++run, inp = input(keys, true);
  keys = (inp.charAt(0) === Calc.RAD ? inp.slice(1) : inp).split('');
  result = { keys: keys.slice(), input: inp, text: '', steps: [], truth: Calc.answer(inp), done: false };
  // the weights on the page may predate a key; it can't read what it never learned
  if (model && inp.split('').some(function (t) { return model.id[t] === undefined; })) result.unknown = true;
  if (!model || result.unknown) { result.done = true; render(); return; }
  result.macs = 0;
  stream(my, inp);
}

// Stream the answer to what the model reads, one token at a time.
function stream(my, read) {
  var lg = model.prompt(model.encode(read.split('')));
  render();
  var tick = function () {
    if (my !== run) return;
    var s = model.pick(lg, TEMP);
    s.dist = spread(lg);
    var end = s.id === model.EOS;
    if (!end) {
      result.steps.push(s);
      // a backwards model's answer fills in from the right, like column arithmetic
      result.text = REV ? s.tok + result.text : result.text + s.tok;
    }
    if (end || result.steps.length > model.meta.max_ans || model.t >= model.T) {
      result.done = true;
      result.macs += macs(model.t);
      render();
      return;
    }
    lg = model.step(s.id);
    render();
    setTimeout(tick, DELAY);
  };
  setTimeout(tick, DELAY);
}

// Multiply-adds for a pass over n positions: each block's four matrices and its
// attention over the positions so far, then the logits.
function macs(n) {
  var c = model.config, total = 0;
  for (var t = 1; t <= n; t++) total += c.layers * (4 * c.d * c.d + 2 * c.d * c.ff + 2 * t * c.d) + c.vocab * c.d;
  return total;
}

// How far off an answer is, in percent of the bigger of the two numbers, scored the
// way evaluate.py scores the error-by-length chart: 0 when exact, null when there's
// no number to compare. Too big and too small count the same: 10 times off either
// way is 90%, and 0, the wrong sign or something wildly too big are all 100%.
var NUM = /^-?\d+(\.\d+)?(e-?\d+)?$/;
function offBy(text, truth) {
  if (text === truth) return 0;
  var e = signed(text, truth);
  return e === null ? null : Math.abs(e);
}

// A % error that always keeps its % sign: from six digits up it goes to
// scientific notation (1.2e5%) so it stays short enough to show whole.
function offText(pct) {
  if (pct === 0) return '0%';
  if (pct < 0.01) return '<0.01%';
  if (pct < 10) return pct.toPrecision(2) + '%';
  if (Math.round(pct) < 1e5) return Math.round(pct).toLocaleString('en') + '%';
  return pct.toExponential(1).replace('.0e', 'e').replace('e+', 'e') + '%';
}

// ---- input --------------------------------------------------------------------

function press(k) {
  if (k === '=') { if (keys.length && state !== 'loading') ask(); return; }
  if (k === 'AC') { run++; keys = []; result = null; render(); return; }
  if (k === 'MODE') { rad = !rad; render(); return; }
  if (k === 'DEL') {
    if (result) { run++; result = null; }
    else keys.pop();
    render();
    return;
  }
  var add = /^[sctln]$/.test(k) ? [k, '('] : k === 'EXP' ? ['e', '^', '('] : k === 'SQ' ? ['^', '2'] : [k];
  if (result) {
    // an operator carries the answer on, the way a calculator does, wrong or not
    var carry = /^[+\-*/^]$/.test(k) && result.done && /^-?[0-9.]+$/.test(result.text);
    keys = carry ? result.text.split('') : [];
    run++; result = null;
  }
  // count the × that 2(3) implies, and the R for radians, since the model reads them
  if (input(keys.concat(add)).length > MAXK) { nudge(); return; }
  keys = keys.concat(add);
  render();
}

function nudge() {
  var e = $('expr');
  e.style.color = 'var(--accent)';
  setTimeout(function () { e.style.color = ''; }, 260);
}

var KEYMAP = { 'x': '*', 'X': '*', ',': '.', 'Enter': '=', '=': '=', 'Backspace': 'DEL', 'Escape': 'AC', 'Delete': 'AC',
               'R': 'r', 'S': 's', 'C': 'c', 'T': 't', 'L': 'l', 'N': 'n', 'P': 'p', 'E': 'e' };
function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  var t = e.target;
  // Enter on a link-like button (an example, a bar) should press that, not =
  if (e.key === 'Enter' && t && t.tagName === 'BUTTON' && !t.classList.contains('key')) return;
  var k = KEYMAP[e.key] || e.key;
  if (!/^([0-9.+\-*/^()rsctlnpe=]|DEL|AC)$/.test(k)) return;
  e.preventDefault();
  press(k);
  var b = document.querySelector('.key[data-k="' + k + '"]');
  if (b) { b.classList.add('hit'); setTimeout(function () { b.classList.remove('hit'); }, 120); }
}

function load(expr) {
  run++;
  if (/[sct]/.test(expr)) rad = expr.charAt(0) === Calc.RAD;
  keys = expr.replace(Calc.RAD, '').split('');
  result = null;
  ask();
  var stage = document.querySelector('.stage');
  if (stage.getBoundingClientRect().top < 0) stage.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
}

// ---- drawing ----------------------------------------------------------------------

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) setText(e, text);
  return e;
}

// Text with every π in the maths font and every √ drawn as a small radical, since
// Inter Tight's are small and thin. The text itself stays readable to copy.
var ROOT = '<svg class="rt" viewBox="0 0 11 14" aria-hidden="true"><path d="M.8 8.4 2.7 7.3 5.2 12.9 9 1.1H10.6"/></svg>';
function setText(node, text) {
  node.textContent = '';
  String(text).split(/([π√])/).forEach(function (part) {
    if (!part) return;
    if (part === 'π') node.appendChild(el('span', 'm')).textContent = 'π';
    else if (part === '√') {
      var r = document.createElement('span');
      r.innerHTML = ROOT;
      r.firstChild.setAttribute('aria-label', '√');
      node.appendChild(r.firstChild);
    } else node.appendChild(document.createTextNode(part));
  });
  return node;
}

function pct(p) { return p >= 0.995 ? '>99%' : p < 0.005 ? '<1%' : Math.round(p * 100) + '%'; }

function render() {
  var shown = result ? result.keys : keys;
  var ex = $('expr'), ans = $('ans');
  setText(ex, shown.length ? showAll(shown) + (result ? ' =' : '') : '');
  ex.scrollLeft = ex.scrollWidth;

  $('mode').textContent = (result ? result.input.charAt(0) === Calc.RAD : rad) ? 'RAD' : 'DEG';
  var mk = document.querySelector('.key.deg').children;
  mk[0].classList.toggle('on', !rad);
  mk[1].classList.toggle('on', rad);

  ans.className = 'ans';
  if (!result) { ans.classList.add('idle'); ans.textContent = '0'; }
  else if (!model) { ans.classList.add('msg'); ans.textContent = 'No weights yet'; }
  else if (result.unknown) { ans.classList.add('msg'); ans.textContent = 'Not learned yet'; }
  else {
    // sized for the longer of the answer so far and the right one, so it rarely changes size mid-answer
    var a = showAll(result.text), w = Math.max(a.length, word(result.truth) ? 0 : showAll(result.truth).length);
    if (word(result.text)) ans.classList.add('msg');
    else if (w > 11) ans.classList.add(w > 15 ? 'longer' : 'long');
    ans.textContent = a;
    ans.title = result.done ? a : '';
    if (!result.done) ans.appendChild(el('span', 'caret'));
  }

  renderPair();
  renderCands();
  renderHundred();
  renderDetail();
}

// Long answers step down in size inside a box that never changes height, sized for
// `fit` characters when given so a streaming answer doesn't jump, and anything still
// too wide ends in an ellipsis with the whole value in its title.
function setV(id, text, cls, fit) {
  var v = $(id), n = Math.max(text.length, fit || 0);
  v.textContent = text;
  v.title = text.length > 9 ? text : '';
  v.className = 'v' + (cls ? ' ' + cls : '') + (/word/.test(cls) || n <= 9 ? '' : n > 13 ? ' longer' : ' long');
}

function word(t) { return t === 'S' || t === 'E'; }

// When the answer and the right one aren't both numbers there is no % to give,
// so the error box says plainly what the answer should have been.
function mismatch(text, truth) {
  if (truth === 'S') return 'Should be Syntax error';
  if (truth === 'E') return 'Should be Error';
  if (text === 'S' || text === 'E') return 'Should be a number';
  return 'Not a valid number';
}

function renderPair() {
  var r = result;
  $('waste').textContent = r && r.done && r.macs ? 'That took ' + (r.macs / 1e6).toFixed(1) + ' million multiply-adds.' : '';
  if (!r || !model || r.unknown) { setV('said', '—'); setV('right', r ? showAll(r.truth) : '—', r && word(r.truth) ? 'word' : ''); setV('err', '—'); return; }
  setV('said', showAll(r.text) || '…', word(r.text) ? 'word' : '', word(r.truth) ? 0 : showAll(r.truth).length);
  if (!r.done) { setV('right', '—'); setV('err', '—'); return; }
  setV('right', showAll(r.truth), word(r.truth) ? 'word' : '');
  var off = offBy(r.text, r.truth);
  if (off !== null) {
    // signed, so a dropped digit reads as −90% (too low) and an extra one as +90% (too high)
    var sg = off < 0.01 ? 0 : signed(r.text, r.truth);   // '<0.01%' needs no direction
    setV('err', (sg > 0 ? '+' : sg < 0 ? '−' : '') + offText(off), off > 1 ? 'off' : '');
    return;
  }
  setV('err', mismatch(r.text, r.truth), 'word off');
}

// The answer token by token, one column per token: the right answer on top when
// it differs, then what it wrote (white where right, orange where not), and under
// them every other token it gave any real chance to, most likely first, shaded by
// probability. Those scroll on their own and fade out at the edges.
var SQ = { '<eos>': 'end', 'E': 'Error', 'S': 'Syntax' };

function renderCands() {
  var box = $('cands');
  box.textContent = '';
  if (!result || !result.steps.length) return;
  // the columns read the way the answer does, even from a model that wrote it backwards
  var steps = REV ? result.steps.slice().reverse() : result.steps, right = result.done ? result.truth : null, bad = -1, i, j;
  if (right !== null) {
    for (i = 0; i < Math.max(steps.length, right.length) && bad < 0; i++) if (!steps[i] || steps[i].tok !== right[i]) bad = i;
  }
  var cols = right !== null ? Math.max(steps.length, right.length) : steps.length, last = result.done ? -1 : REV ? 0 : steps.length - 1;
  var others = steps.map(function (s) { return (s.dist || s.top).filter(function (c) { return c.id !== s.id; }); });
  var depth = Math.max.apply(null, others.map(function (o) { return o.length; }));
  var grid = function () { var g = el('div', 'tg'); g.style.gridTemplateColumns = '96px repeat(' + cols + ', 64px)'; return g; };
  var square = function (tok, p, cls) {
    var q = el('div', 'sq ' + cls), name = SQ[tok] || show(tok);
    q.appendChild(el('span', 't' + (name.length > 2 ? ' wd' : ''), name));
    if (p !== undefined) q.appendChild(el('span', 'p', pct(p)));
    q.title = show(tok) + (p !== undefined ? ': ' + (p * 100).toFixed(2) + '%' : '');
    return q;
  };

  var head = grid(), body = el('div', 'tbody'), list = grid();
  // the right answer's row is there from the first token, blank until the answer is in
  head.appendChild(el('span', 'tl', 'Right answer'));
  for (j = 0; j < cols; j++) {
    if (right === null) head.appendChild(el('div', 'sq ref' + (j === last ? ' new' : '')));
    else head.appendChild(right[j] ? square(right[j], undefined, 'ref' + (steps[j] && steps[j].tok === right[j] ? '' : ' diff')) : el('span'));
  }
  head.appendChild(el('span', 'tl', 'It wrote'));
  for (j = 0; j < cols; j++) {
    var s = steps[j];
    head.appendChild(s ? square(s.tok, s.p, (right !== null && s.tok !== right[j] ? 'bad' : 'mine') + (j === last ? ' new' : '')) : el('span'));
  }
  for (i = 0; i < depth; i++) {
    list.appendChild(el('span', 'tl', i ? '' : 'Other guesses'));
    for (j = 0; j < cols; j++) {
      var c = others[j] && others[j][i];
      if (!c) { list.appendChild(el('span')); continue; }
      var hit = right !== null && steps[j].tok !== right[j] && c.tok === right[j];
      var q = square(c.tok, c.p, (c.p > 0.45 ? 'dark' : '') + (hit ? ' hit' : '') + (j === last ? ' new' : ''));
      q.style.background = 'rgba(243,241,236,' + (0.06 + 0.88 * c.p).toFixed(3) + ')';
      list.appendChild(q);
    }
  }
  body.appendChild(list);
  body.addEventListener('scroll', fade, { passive: true });
  box.appendChild(head);
  box.appendChild(body);
  fade();
}

// The guesses fade out at whichever edge has more of them past it.
function fade() {
  var b = document.querySelector('#cands .tbody');
  if (!b) return;
  b.classList.toggle('up', b.scrollTop > 1);
  b.classList.toggle('down', b.scrollTop + b.clientHeight < b.scrollHeight - 2);
}

// Every token the model gave at least 0.05% to, most likely first, at the
// temperature-1 probabilities the page shows.
function spread(lg) {
  var mx = -Infinity, sum = 0, out = [], i;
  for (i = 0; i < lg.length; i++) if (lg[i] > mx) mx = lg[i];
  for (i = 0; i < lg.length; i++) sum += Math.exp(lg[i] - mx);
  for (i = 0; i < lg.length; i++) {
    var p = Math.exp(lg[i] - mx) / sum;
    if (p >= 0.0005) out.push({ id: i, tok: model.vocab[i], p: p });
  }
  return out.sort(function (a, b) { return b.p - a.p; });
}

// ---- ask it 100 times ------------------------------------------------------------

var hundred = null;   // { result, bins, n, start, target, dom } for the answer on screen

// The signed error of one answer in percent of the bigger number, below zero when it
// came out too low; null when either side isn't a number.
function signed(text, truth) {
  if (!NUM.test(text) || !NUM.test(truth)) return null;
  var p = Number(text), t = Number(truth);
  if (!isFinite(p) || !isFinite(t)) return null;
  if (p === t) return 0;
  // a wrong sign comes out above 100%: it is as wrong as 0
  return (p > t ? 1 : -1) * Math.min(100, Math.abs(p - t) / Math.max(Math.abs(p), Math.abs(t)) * 100);
}

// Eleven bins, a decade wide on each side of exact up to 10%, then one for answers
// that weren't numbers at all: -100..-90 (over 10 times too low), -90..-10, -10..-1,
// -1..-0.1, -0.1..0, exact, 0..0.1, 0.1..1, 1..10, 10..90, 90..100, not a number.
function bin(e) {
  if (e === null) return 11;
  if (e === 0) return 5;
  var a = Math.abs(e), k = a > 90 ? 0 : a > 10 ? 1 : a > 1 ? 2 : a > 0.1 ? 3 : 4;
  return e < 0 ? k : 10 - k;
}

// Sample the same sum a hundred more times, adding to whatever is already in the
// histogram. The sum's keys and values stay in the engine's cache, so each go only
// redoes the answer; and each frame does as many as fit in about 12 ms, so a slow
// machine just fills the bar more slowly.
function askHundred() {
  if (!result || !result.done || !model || result.unknown) return;
  var r = result, my = run;
  var lg0 = Float32Array.from(model.prompt(model.encode(r.input.split('')))), t0 = model.t;
  if (!hundred || hundred.result !== r) hundred = { result: r, bins: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], n: 0, dom: null };
  hundred.start = hundred.n;
  hundred.target = hundred.n + 100;
  var chunk = function () {
    if (my !== run || result !== r) return;
    var until = performance.now() + 12;
    while (hundred.n < hundred.target && performance.now() < until) {
      model.t = t0;
      var lg = lg0, text = '';
      for (var k = 0; k <= model.meta.max_ans && model.t < model.T; k++) {
        var s = model.pick(lg, TEMP);
        if (s.id === model.EOS) break;
        text += s.tok;
        lg = model.step(s.id);
      }
      if (REV) text = flip(text);
      // the right answer is exact even when it's Syntax error or Error, which have no %
      hundred.bins[text === r.truth ? 5 : bin(signed(text, r.truth))]++;
      hundred.n++;
    }
    renderHundred();
    if (hundred.n < hundred.target) requestAnimationFrame(chunk);
  };
  renderHundred();
  requestAnimationFrame(chunk);
}

function renderHundred() {
  var ready = result && result.done && model && !result.unknown, btn = $('h100'), out = $('hres');
  var h = ready && hundred && hundred.result === result ? hundred : null, going = h && h.n < h.target;
  btn.disabled = !ready || !!going;
  btn.textContent = going ? 'Asking… ' + h.n : h ? 'Ask it 100 more times' : 'Ask it 100 times';
  // everything keeps its place: Clear is greyed out while it asks, and only invisible before there's anything to clear
  $('hclear').classList.toggle('gone', !h);
  $('hclear').disabled = !h || !!going;
  $('hline').classList.toggle('on', !!going);
  $('hline').firstChild.style.width = (going ? h.n - h.start : 0) + '%';
  if (!h) { out.textContent = ''; return; }
  if (!h.dom) h.dom = buildHundred(out, h);

  var d = h.dom, top = Math.max.apply(null, h.bins) || 1;
  d.cols.forEach(function (c, i) {
    c.bar.style.height = (h.bins[i] / top * 100).toFixed(1) + '%';
    c.n.textContent = h.bins[i] ? String(h.bins[i]) : '';
  });
}

// The histogram's frame, built once per hundred so its bars can grow in place.
function buildHundred(out, h) {
  out.textContent = '';
  var hist = el('div', 'hist'), cols = [];
  var names = ['−100% to −90%', '−90% to −10%', '−10% to −1%', '−1% to −0.1%', '−0.1% to 0', 'exact',
               '0 to +0.1%', '+0.1% to +1%', '+1% to +10%', '+10% to +90%', '+90% to +100%', 'not a number'];
  names.forEach(function (name, i) {
    if (i === 11) hist.appendChild(el('span'));
    var c = el('div', 'c' + (i === 5 ? ' ok' : i === 11 ? ' nan' : '')), n = el('b'), bar = el('i');
    c.title = name;
    c.appendChild(n);
    c.appendChild(bar);
    hist.appendChild(c);
    cols.push({ bar: bar, n: n });
  });
  hist.appendChild(el('span', 'base'));
  hist.appendChild(el('span'));
  hist.appendChild(el('span', 'base2'));
  var ax = el('div', 'ax');
  [[1, '−90%'], [2, '−10%'], [3, '−1%'], [4, '−0.1%'], [5.5, 'exact'], [7, '+0.1%'], [8, '+1%'], [9, '+10%'], [10, '+90%']]
    .forEach(function (t) { var s = el('span', '', t[1]); s.style.left = (t[0] / 11 * 100).toFixed(2) + '%'; ax.appendChild(s); });
  hist.appendChild(ax);
  hist.appendChild(el('span'));
  hist.appendChild(el('span', 'ax2', 'not a number'));
  out.appendChild(hist);
  return { hist: hist, cols: cols };
}

// ---- error by length ------------------------------------------------------------

var LEN = null;       // eval.json's by_length rows, one per expression length
var hover = 0;        // the bar under the pointer or focus
var pinned = 20;      // the bar the detail shows when nothing is typed or hovered

function median(r) { return r.median === null ? 100 : r.median; }
function tick(n) { return n === 1 || n % (LEN.length > 30 ? 10 : 5) === 0; }

function renderLength(ev) {
  LEN = ev.by_length.rows;
  var cols = $('cols'), xax = $('xax');
  // the axis runs to the next 10% above the tallest bar, so small errors still show
  var top = Math.min(100, Math.max(10, Math.ceil(Math.max.apply(null, LEN.map(median)) / 10) * 10));
  cols.style.gridTemplateColumns = xax.style.gridTemplateColumns = 'repeat(' + LEN.length + ',minmax(0,1fr))';
  $('yTop').textContent = top + '%';
  $('yMid').textContent = top / 2 + '%';
  LEN.forEach(function (r) {
    var m = median(r), b = el('button', m === 0 ? 'zero' : ''), bar = el('i');
    b.type = 'button';
    b.setAttribute('aria-label', r.tokens + ' tokens: median error ' + offText(m) + ', ' + Math.round(r.exact * 100) + '% exact');
    bar.style.height = Math.min(100, m / top * 100) + '%';
    b.appendChild(bar);
    var pick = function () { hover = pinned = r.tokens; renderDetail(); };
    b.addEventListener('mouseenter', pick);
    b.addEventListener('focus', pick);
    b.addEventListener('click', pick);
    cols.appendChild(b);
    xax.appendChild(el('span', '', tick(r.tokens) ? String(r.tokens) : ''));
  });
  cols.addEventListener('mouseleave', function () { hover = 0; renderDetail(); });
  cols.addEventListener('focusout', function () { hover = 0; renderDetail(); });

  $('lenSec').hidden = false;
  renderDetail();
}

function renderDetail() {
  if (!LEN) return;
  var you = result ? result.input.length : keys.length ? input(keys).length : 0;
  var n = hover || (you >= 1 && you <= LEN.length ? you : pinned), r = LEN[n - 1], d = $('detail');
  var bars = $('cols').children, ticks = $('xax').children;
  for (var i = 0; i < bars.length; i++) {
    bars[i].classList.toggle('sel', i === n - 1);
    bars[i].classList.toggle('you', i === you - 1);
    ticks[i].classList.toggle('sel', i === n - 1);
    // the selected length gets its number; regular ticks too close to it make room
    var near = Math.abs(i + 1 - n) <= Math.ceil(LEN.length / 40);
    ticks[i].textContent = i === n - 1 || (tick(i + 1) && !near) ? String(i + 1) : '';
  }

  d.textContent = '';
  d.appendChild(el('h3', '', n + (n === 1 ? ' token' : ' tokens')));
  d.appendChild(el('p', 'sum', 'Median error ' + offText(median(r)) + ', ' + Math.round(r.exact * 100) + '% exactly right.'));
  var sp = el('div', 'split');
  ['Exact', 'Within 1%', '1 to 10%', '10 to 90%', 'Over 90%', 'Not a number'].forEach(function (k, j) {
    if (r.split[j] === undefined) return;
    var tr = el('span', 'tr'), f = el('i', j >= 4 ? 'hot' : '');
    f.style.width = (r.split[j] * 100).toFixed(1) + '%';
    tr.appendChild(f);
    sp.appendChild(el('span', 'k', k));
    sp.appendChild(tr);
    sp.appendChild(el('span', 'n', Math.round(r.split[j] * 100) + '%'));
  });
  d.appendChild(sp);
  example(d, 'Typical', r.typical);
  example(d, 'Worst of ' + r.n, r.worst);
}

// A number cut to its first five digits, with an ellipsis when there was more.
function short(s) {
  var digits = 0;
  for (var i = 0; i < s.length; i++) {
    if (/[0-9]/.test(s[i]) && ++digits === 5) return i + 1 < s.length ? s.slice(0, i + 1) + '…' : s;
  }
  return s;
}

function example(d, title, x) {
  var box = el('div', 'ex'), b = el('button', '', showAll(x.expr) + ' =');
  b.type = 'button';
  b.title = 'Try it';
  b.addEventListener('click', function () { load(x.expr); });
  box.appendChild(el('span', 'label', title));
  box.appendChild(b);
  var r = el('div', 'r');
  r.appendChild(document.createTextNode('said '));
  r.appendChild(el('b', '', short(showAll(x.said)) || 'nothing'));
  r.appendChild(document.createTextNode(', right is '));
  r.appendChild(el('b', '', short(showAll(x.right))));
  r.appendChild(document.createTextNode(', '));
  r.appendChild(el('b', x.off === 0 ? '' : 'off', x.off === null ? 'not a number' : x.off === 0 ? 'exact' : offText(x.off) + ' off'));
  box.appendChild(r);
  d.appendChild(box);
}

// ---- error by operations ----------------------------------------------------------

function renderFamilies(ev) {
  var box = $('fams'), groups = {}, order = [];
  ev.rows.forEach(function (r) {
    var g = r.group || 'Everything else';
    if (!groups[g]) { groups[g] = el('div', 'fam'); groups[g].appendChild(el('h4', '', g)); order.push(g); }
    var b = el('button', 'frow'), bar = el('span', 'fb'), c = el('i', 'c'), x = el('i', 'x');
    b.type = 'button';
    b.title = 'Try a random one · ' + Math.round(r.close * 100) + '% within 1%';
    // a different case from the eval each time, not the same example
    b.addEventListener('click', function () {
      var pool = r.pool && r.pool.length ? r.pool : [r.example];
      load(pool[Math.floor(Math.random() * pool.length)]);
    });
    // capitalised, unless it starts with a symbol or the constant e ('π and e', 'e to the x')
    var name = /^[a-z]/.test(r.label) && !/^e /.test(r.label) ? r.label.charAt(0).toUpperCase() + r.label.slice(1) : r.label;
    b.appendChild(el('span', 'fl', name));
    b.appendChild(el('span', 'fv', Math.round(r.exact * 100) + '%'));
    c.style.width = (r.close * 100).toFixed(1) + '%';
    x.style.width = (r.exact * 100).toFixed(1) + '%';
    bar.appendChild(c);
    bar.appendChild(x);
    b.appendChild(bar);
    groups[g].appendChild(b);
  });
  order.forEach(function (g) { box.appendChild(groups[g]); });
  $('famSec').hidden = false;
}

// ---- boot -----------------------------------------------------------------------

function facts() {
  var f = $('facts');
  if (!model) { f.textContent = state === 'missing' ? 'The weights are not published yet.' : 'Loading the weights…'; return; }
  var c = model.config, mt = model.meta;
  f.textContent = (mt.params / 1e6).toFixed(1) + 'M parameters, ' + c.layers + ' layers, trained on '
    + (mt.seen / 1e6).toFixed(0) + 'M worked examples.';
}

function boot() {
  Array.prototype.forEach.call(document.querySelectorAll('.key'), function (b) {
    b.addEventListener('click', function () { press(b.getAttribute('data-k')); });
  });
  document.addEventListener('keydown', onKey);
  $('h100').addEventListener('click', askHundred);
  $('hclear').addEventListener('click', function () { hundred = null; renderHundred(); });
  render();
  facts();

  fetch(WEIGHTS).then(function (r) {
    if (!r.ok) throw new Error(r.status);
    return r.arrayBuffer();
  }).then(function (buf) {
    model = new window.Vibeulator.Model(buf);
    REV = !!model.meta.reversed;
    MAXK = model.meta.max_expr || MAXK;
    state = 'ready';
    facts();
    render();
  }).catch(function () {
    state = 'missing';
    facts();
    render();
  });
  fetch(EVAL).then(function (r) { return r.ok ? r.json() : null; }).then(function (ev) {
    if (ev && ev.by_length) renderLength(ev);
    if (ev && ev.rows) renderFamilies(ev);
  }).catch(function () {});
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
