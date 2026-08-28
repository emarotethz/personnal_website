

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const NET_JS = fileURLToPath(new URL('../../learning-curve/curve-net.js', import.meta.url));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

global.self = global;
new Function(fs.readFileSync(NET_JS, 'utf8'))();
const { Net, Adam, polyak } = global.LCNet;

let seed = 12345;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const NI = 24, NH = 64, NA = 12;
const net = new Net(NI, NH, NA);
const P = net.init(rand);

console.log('\n[1] shape and forward invariants');
const NAUX = global.LCNet.NAUX;
check('parameter count matches the layout', net.NP,
  NI * NH + NH + NH + NH + NH * NH + NH + NH + NH + NH + 1 + NA * NH + NA + NAUX * NH + NAUX);

const x = new Float32Array(NI * 8);
for (let i = 0; i < x.length; i++) x[i] = rand() * 2 - 1;

net.fwd(P, x, 0);
let m = 0; for (let i = 0; i < NH; i++) m += net.xh1[i]; m /= NH;
let v = 0; for (let i = 0; i < NH; i++) v += (net.xh1[i] - m) ** 2; v /= NH;
check('layernorm 1 output has zero mean', near(m, 0, 1e-5), true);
check('layernorm 1 output has unit variance', near(v, 1, 1e-4), true);
m = 0; for (let i = 0; i < NH; i++) m += net.xh2[i]; m /= NH;
v = 0; for (let i = 0; i < NH; i++) v += (net.xh2[i] - m) ** 2; v /= NH;
check('layernorm 2 output has zero mean', near(m, 0, 1e-5), true);
check('layernorm 2 output has unit variance', near(v, 1, 1e-4), true);

let okDiff = true, meanQ = 0;
for (let a = 0; a < NA; a++) {
  meanQ += net.q[a];
  for (let b = 0; b < NA; b++) if (!near(net.q[a] - net.q[b], net.A[a] - net.A[b], 1e-5)) okDiff = false;
}
meanQ /= NA;
check('dueling: Q[a]-Q[b] === A[a]-A[b]', okDiff, true);
check('dueling: mean_a Q[a] === V', near(meanQ, net.V, 1e-5), true);

console.log('\n[2] backward pass against finite differences');
const B = 6;
const acts = [], ys = [];
for (let k = 0; k < B; k++) { acts.push((rand() * NA) | 0); ys.push(rand() * 2 - 1); }

function loss(p) {
  let L = 0;
  for (let k = 0; k < B; k++) { const q = net.fwd(p, x, k * NI); const e = q[acts[k]] - ys[k]; L += 0.5 * e * e; }
  return L;
}
const G = new Float32Array(net.NP);
for (let k = 0; k < B; k++) { const q = net.fwd(P, x, k * NI); net.bwdQ(P, G, x, k * NI, acts[k], q[acts[k]] - ys[k]); }

const idxs = [];
for (let i = 0; i < 60; i++) idxs.push((rand() * net.NP) | 0);
const h = 3e-3;
function compare(G, lossFn) {
  const num = [], ana = [];
  for (const i of idxs) {
    const o = P[i];
    P[i] = o + h; const Lp = lossFn(P);
    P[i] = o - h; const Lm = lossFn(P);
    P[i] = o;
    num.push((Lp - Lm) / (2 * h)); ana.push(G[i]);
  }
  let dot = 0, na = 0, nn = 0;
  for (let k = 0; k < num.length; k++) { dot += num[k] * ana[k]; na += ana[k] * ana[k]; nn += num[k] * num[k]; }
  const rms = Math.sqrt(na / num.length);
  const rel = [];
  for (let k = 0; k < num.length; k++) {
    if (Math.abs(ana[k]) < 0.05 * rms) continue;
    rel.push(Math.abs(num[k] - ana[k]) / Math.abs(ana[k]));
  }
  rel.sort((p, q) => p - q);
  const median = rel.length ? rel[rel.length >> 1] : 0;
  return {
    median, worst: rel.length ? rel[rel.length - 1] : 0, counted: rel.length,
    cos: dot / Math.sqrt(na * nn + 1e-30), ratio: Math.sqrt(na) / Math.sqrt(nn + 1e-30),
  };
}
const qc = compare(G, loss);
const worst = qc.worst, cos = qc.cos, ratio = qc.ratio;
console.log(`     ${qc.counted} coords, median rel err ${qc.median.toExponential(2)}, worst ${qc.worst.toExponential(2)}, cosine ${cos.toFixed(8)}, norm ratio ${ratio.toFixed(5)}`);
check('enough coordinates carried real gradient to judge', qc.counted >= 10, true);
check('typical coordinate agrees within 2%', qc.median < 0.02, true);
check('gradient direction matches (cosine > 0.999)', cos > 0.999, true);
check('gradient magnitude matches within 2%', Math.abs(ratio - 1) < 0.02, true);

console.log('\n[3] cross-entropy head used for behaviour cloning');
const G2 = new Float32Array(net.NP);
function ceLoss(p) {
  let L = 0;
  for (let k = 0; k < B; k++) {
    p === P ? net.fwd(p, x, k * NI) : net.fwd(p, x, k * NI);
    const A = net.A; let mx = A[0];
    for (let i = 1; i < NA; i++) if (A[i] > mx) mx = A[i];
    let s = 0; for (let i = 0; i < NA; i++) s += Math.exp(A[i] - mx);
    L += -(A[acts[k]] - mx - Math.log(s));
  }
  return L;
}
for (let k = 0; k < B; k++) { net.fwd(P, x, k * NI); net.bwdCE(P, G2, x, k * NI, acts[k], 1); }
let cworst = 0, cdot = 0, cna = 0, cnn = 0;
for (const i of idxs) {
  const o = P[i];
  P[i] = o + h; const Lp = ceLoss(P);
  P[i] = o - h; const Lm = ceLoss(P);
  P[i] = o;
  const num = (Lp - Lm) / (2 * h), ana = G2[i];
  cworst = Math.max(cworst, Math.abs(num - ana) / Math.max(1, Math.abs(ana)));
  cdot += num * ana; cna += ana * ana; cnn += num * num;
}
const ccos = cdot / Math.sqrt(cna * cnn + 1e-30);
console.log(`     worst per-coord rel err ${cworst.toExponential(2)}, cosine ${ccos.toFixed(8)}`);
check('CE gradient within 2% per coordinate', cworst < 0.02, true);
check('CE gradient direction matches', ccos > 0.999, true);

console.log('\n[3b] the auxiliary head, and that it reaches the shared trunk');
{
  const G3 = new Float32Array(net.NP);
  const tgt = new Float32Array(B * NAUX);
  for (let i = 0; i < tgt.length; i++) tgt[i] = rand() * 2 - 1;
  function auxLoss(p) {
    let L = 0;
    for (let k = 0; k < B; k++) {
      net.fwd(p, x, k * NI);
      for (let i = 0; i < NAUX; i++) {
        const e = net.aux[i] - tgt[k * NAUX + i];
        L += Math.abs(e) <= 1 ? 0.5 * e * e : Math.abs(e) - 0.5;
      }
    }
    return L;
  }
  for (let k = 0; k < B; k++) { net.fwd(P, x, k * NI); net.bwdAux(P, G3, x, k * NI, tgt, k * NAUX, 1); }
  const ac = compare(G3, auxLoss);
  let trunkTouched = 0;
  for (const i of idxs) if (i < net.W1 && Math.abs(G3[i]) > 1e-7) trunkTouched++;
  console.log(`     ${ac.counted} coords, median rel err ${ac.median.toExponential(2)}, worst ${ac.worst.toExponential(2)}, cosine ${ac.cos.toFixed(8)}`);
  check('aux gradient agrees within 2% at the median', ac.median < 0.02, true);
  check('aux gradient direction matches', ac.cos > 0.995, true);
  check('and it does reach the first layer', trunkTouched > 0, true);
}

console.log('\n[4] Adam');
{
  const p = new Float32Array([3.0]);
  const g = new Float32Array(1);
  const opt = new Adam(1, 1e-3);
  opt.warm = 1;
  const first = [];
  const marks = [];
  for (let i = 0; i < 4000; i++) {
    g[0] = p[0];
    opt.step(p, g);
    if (i === 0) first.push(Math.abs(3.0 - p[0]));
    if (i % 500 === 499) marks.push(Math.abs(p[0]));
  }
  let shrinking = true;
  for (let i = 1; i < marks.length; i++) if (marks[i] > marks[i - 1]) shrinking = false;
  check('first step size is about lr (bias correction working)', near(first[0], 1e-3, 2e-4), true);
  check('envelope shrinks every 500 steps on 0.5w^2', shrinking, true);
  check('converges to the minimum', Math.abs(p[0]) < 1e-2, true);
}
{
  const p = new Float32Array([1.0]);
  const g = new Float32Array(1);
  const opt = new Adam(1, 1e-3);
  g[0] = 1;
  opt.step(p, g);
  check('warmup makes the very first step tiny', Math.abs(1.0 - p[0]) < 1e-4, true);
}
{
  const p = new Float32Array([0, 0]);
  const g = new Float32Array([30, 40]);
  const opt = new Adam(2, 1e-3);
  opt.step(p, g);
  check('global grad norm is measured', near(opt.gnorm, 50, 1e-4), true);
}

console.log('\n[5] polyak and determinism');
{
  const a = new Float32Array([0, 10]), b = new Float32Array([1, 0]);
  polyak(a, b, 0.5);
  check('polyak moves halfway at tau 0.5', [a[0], a[1]], [0.5, 5]);
}
{
  let s1 = 999; const r1 = () => { s1 = (s1 * 1103515245 + 12345) & 0x7fffffff; return s1 / 0x7fffffff; };
  let s2 = 999; const r2 = () => { s2 = (s2 * 1103515245 + 12345) & 0x7fffffff; return s2 / 0x7fffffff; };
  const n = new Net(NI, NH, NA);
  const pa = n.init(r1), pb = n.init(r2);
  let same = true;
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) same = false;
  check('same seed gives byte-identical weights', same, true);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
