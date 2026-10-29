// The transformer, by hand. Reads vibeulator.bin (see vibeulator/pack.py), widens
// the int8 matrices back to float32 once, and then runs one token at a time
// with a key/value cache, so each new answer token costs one pass through six
// small blocks: about 2.6M multiply-adds, a couple of milliseconds.
//
// It has to match vibeulator/model.py exactly: pre-LayerNorm, learned
// positions, tanh GELU, output weights tied to the token embedding.
// tests/parity.mjs holds it to PyTorch's logits.
(function (root) {
'use strict';

var EPS = 1e-5;

function Model(buf) {
  var u8 = new Uint8Array(buf);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'VIBU') throw new Error('not a vibeulator weights file');
  var n = new DataView(buf).getUint32(4, true);
  var head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + n)));
  var base = 8 + n, W = {};
  head.tensors.forEach(function (t) {
    var size = t.shape.reduce(function (a, b) { return a * b; }, 1);
    var a = new Float32Array(size);
    if (t.dtype === 'i8') {
      var q = new Int8Array(buf, base + t.offset, size);
      var s = new Float32Array(buf, base + t.scale, t.shape[0]);
      var cols = t.shape[1];
      for (var r = 0; r < t.shape[0]; r++) for (var c = 0; c < cols; c++) a[r * cols + c] = q[r * cols + c] * s[r];
    } else {
      a.set(new Float32Array(buf, base + t.offset, size));
    }
    W[t.name] = a;
  });

  var c = head.config;
  this.config = c; this.meta = head.meta; this.vocab = head.vocab;
  this.id = {}; for (var i = 0; i < head.vocab.length; i++) this.id[head.vocab[i]] = i;
  this.BOS = this.id['<bos>']; this.EOS = this.id['<eos>']; this.EQ = this.id['='];
  this.D = c.d; this.H = c.heads; this.HD = c.d / c.heads; this.F = c.ff; this.L = c.layers; this.T = c.block; this.V = c.vocab;
  this.W = W;
  this.layer = [];
  for (var l = 0; l < c.layers; l++) {
    var p = 'blocks.' + l + '.';
    this.layer.push({
      g1: W[p + 'ln1.weight'], b1: W[p + 'ln1.bias'],
      qkvW: W[p + 'qkv.weight'], qkvB: W[p + 'qkv.bias'],
      projW: W[p + 'proj.weight'], projB: W[p + 'proj.bias'],
      g2: W[p + 'ln2.weight'], b2: W[p + 'ln2.bias'],
      fc1W: W[p + 'fc1.weight'], fc1B: W[p + 'fc1.bias'],
      fc2W: W[p + 'fc2.weight'], fc2B: W[p + 'fc2.bias'],
      K: new Float32Array(c.block * c.d), Vc: new Float32Array(c.block * c.d)
    });
  }
  this.x = new Float32Array(c.d); this.h = new Float32Array(c.d);
  this.qkv = new Float32Array(3 * c.d); this.att = new Float32Array(c.d); this.o = new Float32Array(c.d);
  this.f = new Float32Array(c.ff); this.sc = new Float32Array(c.block);
  this.logits = new Float32Array(c.vocab);
  // attn[(l * H + h) * T + j]: how much head h of layer l looked at position j for the latest token
  this.attn = new Float32Array(c.layers * c.heads * c.block);
  this.t = 0;
}

function layerNorm(x, g, b, out, n) {
  var m = 0, v = 0, i, d;
  for (i = 0; i < n; i++) m += x[i];
  m /= n;
  for (i = 0; i < n; i++) { d = x[i] - m; v += d * d; }
  var r = 1 / Math.sqrt(v / n + EPS);
  for (i = 0; i < n; i++) out[i] = (x[i] - m) * r * g[i] + b[i];
}

// out[o] = b[o] + sum_i W[o, i] x[i], W stored row-major as (out, in) like nn.Linear
function linear(W, b, x, out, nOut, nIn) {
  for (var o = 0; o < nOut; o++) {
    var s = b[o], r = o * nIn;
    for (var i = 0; i < nIn; i++) s += W[r + i] * x[i];
    out[o] = s;
  }
}

var GC = Math.sqrt(2 / Math.PI);
function gelu(x, n) {
  for (var i = 0; i < n; i++) { var v = x[i]; x[i] = 0.5 * v * (1 + Math.tanh(GC * (v + 0.044715 * v * v * v))); }
}

Model.prototype.reset = function () { this.t = 0; };

// Feed one token at the next position; returns the logits for the token after it.
Model.prototype.step = function (tok) {
  if (this.t >= this.T) throw new Error('context full');
  var D = this.D, H = this.H, HD = this.HD, F = this.F, T = this.T, t = this.t;
  var W = this.W, x = this.x, h = this.h, qkv = this.qkv, att = this.att, o = this.o, f = this.f, sc = this.sc;
  var tokE = W['tok.weight'], posE = W['pos.weight'], i, j, k;
  for (i = 0; i < D; i++) x[i] = tokE[tok * D + i] + posE[t * D + i];

  var scale = 1 / Math.sqrt(HD);
  for (var l = 0; l < this.L; l++) {
    var L = this.layer[l];
    layerNorm(x, L.g1, L.b1, h, D);
    linear(L.qkvW, L.qkvB, h, qkv, 3 * D, D);
    for (i = 0; i < D; i++) { L.K[t * D + i] = qkv[D + i]; L.Vc[t * D + i] = qkv[2 * D + i]; }
    for (var hh = 0; hh < H; hh++) {
      var q0 = hh * HD, mx = -Infinity, sum = 0;
      for (j = 0; j <= t; j++) {
        var s = 0, kr = j * D + q0;
        for (k = 0; k < HD; k++) s += qkv[q0 + k] * L.K[kr + k];
        s *= scale; sc[j] = s; if (s > mx) mx = s;
      }
      for (j = 0; j <= t; j++) { sc[j] = Math.exp(sc[j] - mx); sum += sc[j]; }
      var ab = (l * H + hh) * T;
      for (k = 0; k < HD; k++) att[q0 + k] = 0;
      for (j = 0; j <= t; j++) {
        var p = sc[j] / sum, vr = j * D + q0;
        this.attn[ab + j] = p;
        for (k = 0; k < HD; k++) att[q0 + k] += p * L.Vc[vr + k];
      }
      for (j = t + 1; j < T; j++) this.attn[ab + j] = 0;
    }
    linear(L.projW, L.projB, att, o, D, D);
    for (i = 0; i < D; i++) x[i] += o[i];
    layerNorm(x, L.g2, L.b2, h, D);
    linear(L.fc1W, L.fc1B, h, f, F, D);
    gelu(f, F);
    linear(L.fc2W, L.fc2B, f, o, D, F);
    for (i = 0; i < D; i++) x[i] += o[i];
  }
  layerNorm(x, W['ln.weight'], W['ln.bias'], h, D);
  for (var v = 0; v < this.V; v++) {
    var z = 0, r = v * D;
    for (i = 0; i < D; i++) z += h[i] * tokE[r + i];
    this.logits[v] = z;
  }
  this.t++;
  return this.logits;
};

// Calculator keys -> token ids: <bos>, the expression, '='.
Model.prototype.encode = function (keys) {
  var ids = [this.BOS];
  for (var i = 0; i < keys.length; i++) {
    var id = this.id[keys[i]];
    if (id === undefined) throw new Error('no token for ' + JSON.stringify(keys[i]));
    ids.push(id);
  }
  ids.push(this.EQ);
  return ids;
};

// Start a fresh answer: reset the cache and feed the whole prompt.
Model.prototype.prompt = function (ids) {
  this.reset();
  var lg = null;
  for (var i = 0; i < ids.length; i++) lg = this.step(ids[i]);
  return lg;
};

function softmax(lg, temp) {
  var n = lg.length, p = new Float64Array(n), mx = -Infinity, s = 0, i;
  for (i = 0; i < n; i++) if (lg[i] > mx) mx = lg[i];
  for (i = 0; i < n; i++) { p[i] = Math.exp((lg[i] - mx) / temp); s += p[i]; }
  for (i = 0; i < n; i++) p[i] /= s;
  return p;
}

// Choose the next token from logits. temp 0 is greedy. Returns the choice, its
// probability under the model as it is (temperature 1), and the top five.
Model.prototype.pick = function (lg, temp, rand) {
  var p = softmax(lg, 1), id = 0, i;
  if (!temp) {
    for (i = 1; i < p.length; i++) if (lg[i] > lg[id]) id = i;
  } else {
    var q = softmax(lg, temp), u = (rand || Math.random)(), acc = 0;
    id = q.length - 1;
    for (i = 0; i < q.length; i++) { acc += q[i]; if (u < acc) { id = i; break; } }
  }
  var order = [];
  for (i = 0; i < p.length; i++) order.push(i);
  order.sort(function (a, b) { return p[b] - p[a]; });
  var top = order.slice(0, 5).map(function (k) { return { id: k, tok: this.vocab[k], p: p[k] }; }, this);
  return { id: id, tok: this.vocab[id], p: p[id], top: top };
};

// The whole answer at once (the page streams it step by step instead).
Model.prototype.answer = function (keys, temp, rand) {
  var ids = this.encode(keys), lg = this.prompt(ids), steps = [], text = '';
  while (true) {
    var s = this.pick(lg, temp, rand);
    steps.push(s);
    if (s.id === this.EOS) break;
    text += s.tok;
    if (steps.length > this.meta.max_ans || this.t >= this.T) break;
    lg = this.step(s.id);
  }
  return { text: text, steps: steps };
};

root.Vibeulator = { Model: Model };

})(typeof self !== 'undefined' ? self : this);
