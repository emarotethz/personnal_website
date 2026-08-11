

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const AUDIO_JS = fileURLToPath(new URL('../../universal-beat/audio.js', import.meta.url));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

let now = 0;
const starts = [];
const peaks = [];
const param = () => ({
  value: 0,
  setValueAtTime() { return this; },
  linearRampToValueAtTime(v) { peaks.push(v); return this; },
  exponentialRampToValueAtTime() { return this; },
  setTargetAtTime() { return this; },
  cancelScheduledValues() { return this; },
});
const node = (extra = {}) => ({
  connect() { return this; }, disconnect() {},
  start(t) { if (typeof t === 'number') starts.push(t); },
  stop() {},
  ...extra,
});

class FakeCtx {
  constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = node(); }
  get currentTime() { return now; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  createOscillator() { return node({ frequency: param(), detune: param(), type: 'sine' }); }
  createGain() { return node({ gain: param() }); }
  createBiquadFilter() { return node({ frequency: param(), Q: param(), type: 'lowpass' }); }
  createBufferSource() { return node({ playbackRate: param(), buffer: null, loop: false }); }
  createDelay() { return node({ delayTime: param() }); }
  createDynamicsCompressor() {
    return node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
  }
  createBuffer(ch, len, sr) {
    return { duration: len / sr, getChannelData: () => new Float32Array(len) };
  }
}

let tick = null;
global.window = global;
global.AudioContext = FakeCtx;
global.document = { hidden: false, addEventListener() {} };
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
global.setInterval = (fn) => { tick = fn; return 1; };
global.clearInterval = () => {};

new Function(fs.readFileSync(AUDIO_JS, 'utf8'))();
const A = global.UB.audio;

const BPM = 96, SWING = 0.12, STEPS = 16;
const base = 60 / BPM / 4;
const even = base * (1 + SWING), odd = base * (1 - SWING);

A.setConfig({ bpm: BPM, swing: SWING, steps: STEPS, scale: [50, 53, 55, 57, 60, 62, 65, 67, 69, 72] });

const dense = Array.from({ length: STEPS }, (_, i) => ({ id: 'n' + i, inst: 'kick', step: i, pitch: 0, vel: 0.8, decay: 0.1 }));
A.setPattern(dense, 1, true);

await A.start();

const advance = (seconds, dt = 0.005) => {
  for (let t = 0; t < seconds; t += dt) { now += dt; tick(); }
};

console.log('\n[1] swing shape and bar length');
advance(12);
const times = [...new Set(starts.map((t) => +t.toFixed(9)))].sort((a, b) => a - b);

const deltas = [];
for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);

check('scheduled at least 3 bars of steps', times.length >= STEPS * 3, true);
const evens = deltas.filter((_, i) => i % 2 === 0);
const odds = deltas.filter((_, i) => i % 2 === 1);
check('long swing steps all equal', evens.every((d) => near(d, evens[0])), true);
check('short swing steps all equal', odds.every((d) => near(d, odds[0])), true);
check('long/short are the 1+s / 1-s pair', near(Math.max(evens[0], odds[0]), even) && near(Math.min(evens[0], odds[0]), odd), true);
check('swing is actually audible (not a no-op)', Math.abs(evens[0] - odds[0]) > 0.01, true);

const bar = deltas.slice(0, STEPS).reduce((a, b) => a + b, 0);
check('16 steps sum to exactly one bar', near(bar, base * STEPS, 1e-9), true);
check('bar length matches barSeconds()', near(A.barSeconds(), base * STEPS, 1e-9), true);

console.log('\n[2] no drift over many bars');
const first = times[0];
const idx = STEPS * 3;
const expected = first + 3 * base * STEPS;
check('step 48 lands exactly 3 bars after step 0', near(times[idx], expected, 1e-6), true);

console.log('\n[3] a new version swaps in only at a bar boundary');

const swapped = [{ id: 'x', inst: 'clap', step: 3, pitch: 0, vel: 0.9, decay: 0.2 }];
let sawApplied = -1, barsThisTick = 0, appliedOnABar = null, appliedWithinBars = null;
A.onBar(() => { barsThisTick++; });
A.onApplied = (v) => { sawApplied = v; appliedOnABar = barsThisTick > 0; };

A.setPattern(swapped, 2, false);
check('version does not change immediately', A.version(), 1);
check('a swap is pending', A.pendingVersion(), 2);

const tStart = now, dt = 0.005;
for (let i = 0; i < Math.ceil((base * STEPS * 2) / dt); i++) {
  barsThisTick = 0;
  now += dt;
  tick();
  if (appliedWithinBars === null && A.version() === 2) appliedWithinBars = (now - tStart) / (base * STEPS);
}

check('the swap did happen', A.version(), 2);
check('it landed on a bar wrap, never mid-bar', appliedOnABar, true);
check('and within one bar of arriving', appliedWithinBars !== null && appliedWithinBars <= 1.01, true);
check('onApplied fired with the new version', sawApplied, 2);
check('nothing left pending', A.pendingVersion(), 0);

console.log('\n[4] overlay preview is heard but never part of the pattern');

const distinctOver = (bars) => {
  starts.length = 0;
  advance(base * STEPS * bars);
  return new Set(starts.map((t) => +t.toFixed(9))).size;
};

A.setPattern([{ id: 'k', inst: 'kick', step: 3, pitch: 0, vel: 0.9, decay: 0.2 }], 3, true);
const baseline = distinctOver(8);
A.setOverlay({ inst: 'tom', step: 11, pitch: 2, vel: 0.5, decay: 0.2 });
const withOverlay = distinctOver(8);
A.setOverlay(null);
const after = distinctOver(8);

check('pattern alone: one hit per bar', Math.abs(baseline - 8) <= 1, true);
check('overlay adds exactly one more hit per bar', Math.abs(withOverlay - baseline * 2) <= 1, true);
check('clearing the overlay restores the baseline', Math.abs(after - baseline) <= 1, true);
check('pattern version untouched by the overlay', A.version(), 3);

console.log('\n[5] a note being previewed is audible over a crowded step');
// Four voices on one step used to mask whatever you were adding. The rest of
// the step is now pulled back while a candidate is being previewed.
const amp = (v) => Math.pow(v, 1.6);
const crowd = Array.from({ length: 4 }, (_, i) => ({ id: 'c' + i, inst: 'tom', step: 0, pitch: 0, vel: 0.8, decay: 0.2 }));
A.setOverlay(null);
A.setPattern(crowd, 9, true);
peaks.length = 0;
advance(base * STEPS * 1.05);
const full = peaks.filter((v) => Math.abs(v - amp(0.8)) < 1e-6).length;
check('four crowded voices play at full level normally', full >= 4, true);

A.setOverlay({ inst: 'tom', step: 0, pitch: 0, vel: 0.8, decay: 0.2 });
peaks.length = 0;
advance(base * STEPS * 1.05);
const atFull    = peaks.filter((v) => Math.abs(v - amp(0.8)) < 1e-6).length;
const pulledBack = peaks.filter((v) => v < amp(0.8) * 0.5 && v > 0).length;
check('the crowd is pulled back while previewing', pulledBack >= 4, true);
check('the previewed note still plays at full level', atFull >= 1, true);
check('and it is now the loudest thing on that step', Math.max(...peaks) - amp(0.8) < 1e-6, true);

A.setOverlay(null);
peaks.length = 0;
advance(base * STEPS * 1.05);
check('clearing the preview restores the crowd', peaks.filter((v) => Math.abs(v - amp(0.8)) < 1e-6).length >= 4, true);

console.log('\n[6] an explicit audition cuts through the running loop');
A.setPattern(crowd, 10, true);
peaks.length = 0;
advance(base * 2);
const beforeAudition = peaks.filter((v) => v < 0.35 && v > 0).length;
A.audition('tom', 0, 0.8, 0.2);
advance(base * 2);
const afterAudition = peaks.filter((v) => v < 0.35 && v > 0).length;
check('auditioning while playing ducks the loop underneath it', afterAudition > beforeAudition, true);
check('and the audition itself still fires at full level',
  peaks.some((v) => Math.abs(v - amp(0.8)) < 1e-6), true);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
