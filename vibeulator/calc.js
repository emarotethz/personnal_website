// The real answer, for comparison. A port of vibeulator/calc.py, which is what
// the model was trained on: same grammar, float64 arithmetic, and the same
// 10-digit display with halves rounded away from zero (toExponential's rule,
// which calc.py copies). tests/parity.mjs checks the two agree.
(function (root) {
'use strict';

var LIMIT = 1e100, SIG = 10, ERR = 'E', SYN = 'S', RAD = 'R', FUNCS = 'rsctln';

function MathError() {}
function SyntaxErr() {}

function check(v) {
  if (!isFinite(v) || Math.abs(v) >= LIMIT) throw new MathError();
  return v;
}

function pow(b, e) {
  if (b === 0 && e < 0) throw new MathError();
  if (b < 0 && e !== Math.floor(e)) throw new MathError();
  return check(Math.pow(b, e));
}

function trig(c, x, rad) {
  var a = x;
  if (!rad) {
    var r = x % 360;
    if (r < 0) r += 360;
    if (c === 't' && r % 180 === 90) throw new MathError();
    a = r * (Math.PI / 180);
  }
  // tan at a right angle has no value, in radians too, where pi/2 is only close
  if (c === 't' && Math.floor(Math.cos(a) * 1e12 + 0.5) / 1e12 === 0) throw new MathError();
  var v = (c === 's' ? Math.sin : c === 'c' ? Math.cos : Math.tan)(a);
  return Math.floor(v * 1e12 + 0.5) / 1e12;
}

function func(c, x, rad) {
  if (c === 'r') {
    if (x < 0) throw new MathError();
    return Math.sqrt(x);
  }
  if (c === 'l' || c === 'n') {
    if (x <= 0) throw new MathError();
    return c === 'l' ? Math.log10(x) : Math.log(x);
  }
  return trig(c, x, rad);
}

function Parser(s, rad) { this.s = s; this.rad = rad; this.i = 0; }
Parser.prototype.peek = function () { return this.i < this.s.length ? this.s[this.i] : ''; };
Parser.prototype.expr = function () {
  var v = this.term();
  while (this.peek() === '+' || this.peek() === '-') {
    var op = this.s[this.i++], w = this.term();
    v = check(op === '+' ? v + w : v - w);
  }
  return v;
};
Parser.prototype.term = function () {
  var v = this.unary();
  while (this.peek() === '*' || this.peek() === '/') {
    var op = this.s[this.i++], w = this.unary();
    if (op === '*') v = check(v * w);
    else {
      if (w === 0) throw new MathError();
      v = check(v / w);
    }
  }
  return v;
};
Parser.prototype.unary = function () {
  if (this.peek() === '-') { this.i++; return -this.unary(); }
  return this.power();
};
Parser.prototype.power = function () {
  var b = this.prim();
  if (this.peek() === '^') { this.i++; return pow(b, this.unary()); }
  return b;
};
Parser.prototype.prim = function () {
  var c = this.peek();
  if (c && FUNCS.indexOf(c) >= 0) { this.i++; return check(func(c, this.prim(), this.rad)); }
  if (c === 'p' || c === 'e') { this.i++; return c === 'p' ? Math.PI : Math.E; }
  if (c === '(') {
    this.i++;
    var v = this.expr();
    if (this.peek() !== ')') throw new SyntaxErr();
    this.i++;
    return v;
  }
  var j = this.i;
  while (/[0-9.]/.test(this.peek())) this.i++;
  var num = this.s.slice(j, this.i);
  if (num === '' || num === '.' || num.indexOf('.') !== num.lastIndexOf('.')) throw new SyntaxErr();
  return parseFloat(num.charAt(0) === '.' ? '0' + num : num);
};

// s with the multiplications it implies written out: 2(3) is 2*(3), and so are
// (1+2)(3), (2)3, 2r9 and 2p. The model only ever saw them written, so the page
// sends it this form too.
function explicit(s) {
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var prev = i ? s[i - 1] : '', ch = s[i];
    var ends = prev !== '' && '0123456789.)pe'.indexOf(prev) >= 0, starts = ('(pe' + FUNCS).indexOf(ch) >= 0;
    if (ends && (starts || (')pe'.indexOf(prev) >= 0 && /[0-9.]/.test(ch)))) out += '*';
    out += ch;
  }
  return out;
}

// s with every bracket still open closed at the end, which the page does before
// it asks, so the model never has to guess where an open bracket stops.
function close(s, max) {
  var open = 0;
  for (var i = 0; i < s.length; i++) open += s[i] === '(' ? 1 : s[i] === ')' ? -1 : 0;
  while (open-- > 0 && s.length < max) s += ')';
  return s;
}

function evaluate(s, rad) {
  var p = new Parser(s, !!rad), v = p.expr();
  if (p.i !== s.length) throw new SyntaxErr();
  return v;
}

function fmt(x) {
  if (x === 0) return '0';
  var s = Math.abs(x).toExponential(SIG - 1), k = s.indexOf('e');
  var digits = s.slice(0, k).replace('.', ''), exp = +s.slice(k + 1), out;
  if (exp >= -4 && exp < SIG) {
    var whole, frac;
    if (exp >= 0) { whole = digits.slice(0, exp + 1); frac = digits.slice(exp + 1); }
    else { whole = '0'; frac = new Array(-exp).join('0') + digits; }
    frac = frac.replace(/0+$/, '');
    out = whole + (frac ? '.' + frac : '');
  } else {
    out = (digits[0] + '.' + digits.slice(1)).replace(/0+$/, '').replace(/\.$/, '') + 'e' + exp;
  }
  return (x < 0 ? '-' : '') + out;
}

// The display string for s, 'E' for a math error and 'S' for a syntax error.
// A leading R means its angles are in radians.
function answer(s) {
  var rad = s.charAt(0) === RAD;
  try {
    return fmt(evaluate(explicit(rad ? s.slice(1) : s), rad));
  } catch (e) {
    if (e instanceof MathError) return ERR;
    if (e instanceof SyntaxErr) return SYN;
    throw e;
  }
}

root.VibCalc = { answer: answer, explicit: explicit, close: close, evaluate: evaluate, fmt: fmt, ERR: ERR, SYN: SYN, RAD: RAD };

})(typeof self !== 'undefined' ? self : this);
