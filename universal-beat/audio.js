
(function () {
  'use strict';

  var UB = (window.UB = window.UB || {});

  var LOOKAHEAD_MS = 25;
  var AHEAD_VISIBLE = 0.12;
  var AHEAD_HIDDEN = 1.0;
  var AUDITION_GAP_MS = 60;
  var DUCK = 0.34;
  var SOLO_DUCK = 0.28;

  var ctx = null;
  var bus = null;
  var soloBus = null;
  var voiceOut = null;
  var autoGain = 0.9;
  var comp = null;
  var delaySend = null;
  var noiseBuf = null;

  var cfg = { bpm: 96, swing: 0.12, steps: 16, scale: [50, 53, 55, 57, 60, 62, 65, 67, 69, 72] };

  var pattern = [];
  var pendingPattern = null;
  var pendingVersion = 0;
  var appliedVersion = 0;
  var overlay = null;
  var noteCount = 0;

  var running = false;
  var timer = null;
  var nextNoteTime = 0;
  var schedStep = 0;
  var uiQueue = [];
  var visibleStep = -1;
  var rafId = 0;
  var lastAudition = 0;
  var openHatGain = null;

  var stepHandlers = [];
  var barHandlers = [];

  function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  function pitchHz(pitch, octaveShift) {
    var s = cfg.scale;
    var idx = Math.max(0, Math.min(s.length - 1, pitch | 0));
    return midiToHz(s[idx] + (octaveShift || 0));
  }

  function amp(vel) { return Math.pow(Math.max(0, Math.min(1, vel)), 1.6); }

  function env(param, t, peak, attack, decay) {
    param.setValueAtTime(1e-4, t);
    param.linearRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(1e-4, t + attack + decay);
  }

  function osc(type, freq, t) {
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    return o;
  }

  function noise(t, dur) {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    s.playbackRate.value = 1;
    s.start(t, (Math.random() * (noiseBuf.duration - dur - 0.01)) || 0);
    s.stop(t + dur + 0.02);
    return s;
  }

  function filt(type, freq, q, t) {
    var f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (q != null) f.Q.setValueAtTime(q, t);
    return f;
  }

  function noiseHit(t, dur, type, freq, q, peak, attack, dest) {
    var n = noise(t, dur);
    var f = filt(type, freq, q, t);
    var g = ctx.createGain();
    env(g.gain, t, peak, attack || 0.001, dur);
    n.connect(f); f.connect(g); g.connect(dest || voiceOut);
    return g;
  }

  var VOICES = {
    kick: function (t, n) {
      var g0 = amp(n.vel);
      var o = osc('sine', 160, t);
      o.frequency.exponentialRampToValueAtTime(48, t + 0.045);
      var g = ctx.createGain();
      env(g.gain, t, g0, 0.002, n.decay);
      o.connect(g); g.connect(voiceOut);
      o.start(t); o.stop(t + n.decay + 0.06);
      noiseHit(t, 0.002, 'highpass', 1500, 0.7, g0 * 0.25);
    },

    snare: function (t, n) {
      var g0 = amp(n.vel);
      var o = osc('triangle', 185, t);
      var g = ctx.createGain();
      env(g.gain, t, g0 * 0.5, 0.001, Math.min(n.decay, 0.12));
      o.connect(g); g.connect(voiceOut);
      o.start(t); o.stop(t + 0.2);
      noiseHit(t, n.decay, 'highpass', 1200, 0.7, g0);
    },

    hat: function (t, n) { metalHat(t, n, 0.02, 0.12, false); },
    openhat: function (t, n) { metalHat(t, n, 0.15, 0.9, true); },

    clap: function (t, n) {
      var g0 = amp(n.vel);

      var offs = [0, 0.011, 0.023];
      var gains = [0.6, 0.8, 1.0];
      for (var i = 0; i < offs.length; i++) {
        noiseHit(t + offs[i], 0.012, 'bandpass', 1100, 2, g0 * gains[i]);
      }
      noiseHit(t + 0.032, Math.max(0.1, n.decay), 'bandpass', 1100, 2, g0 * 0.55);
    },

    rim: function (t, n) {
      var g0 = amp(n.vel);
      var d = Math.min(n.decay, 0.06);
      var f = filt('bandpass', 1700, 6, t);
      var g = ctx.createGain();
      env(g.gain, t, g0, 0.0005, d);
      var a = osc('square', 1700, t);
      var b = osc('square', 520, t);
      a.connect(f); b.connect(f); f.connect(g); g.connect(voiceOut);
      a.start(t); b.start(t);
      a.stop(t + d + 0.02); b.stop(t + d + 0.02);
    },

    tom: function (t, n) {
      var g0 = amp(n.vel);
      var base = pitchHz(n.pitch, -12);
      var o = osc('sine', base * 1.6, t);
      o.frequency.exponentialRampToValueAtTime(base, t + Math.max(0.05, n.decay * 0.6));
      var g = ctx.createGain();
      env(g.gain, t, g0, 0.002, n.decay);
      o.connect(g); g.connect(voiceOut);
      o.start(t); o.stop(t + n.decay + 0.06);
    },

    bass: function (t, n) {
      var g0 = amp(n.vel);
      var f0 = pitchHz(n.pitch, -24);
      var o = osc('sawtooth', f0, t);
      var lp = filt('lowpass', 800, 6, t);
      lp.frequency.exponentialRampToValueAtTime(120, t + Math.max(0.06, n.decay * 0.6));
      var g = ctx.createGain();
      env(g.gain, t, g0, 0.005, n.decay);
      o.connect(lp); lp.connect(g); g.connect(voiceOut); g.connect(delaySend);
      o.start(t); o.stop(t + n.decay + 0.08);
    },

    pluck: function (t, n) {
      var g0 = amp(n.vel);
      var f0 = pitchHz(n.pitch, 0);
      var a = osc('triangle', f0, t); a.detune.setValueAtTime(-7, t);
      var b = osc('triangle', f0, t); b.detune.setValueAtTime(7, t);
      var lp = filt('lowpass', 2500, 1, t);
      lp.frequency.exponentialRampToValueAtTime(600, t + Math.max(0.06, n.decay));
      var g = ctx.createGain();
      env(g.gain, t, g0 * 0.8, 0.002, n.decay);
      a.connect(lp); b.connect(lp); lp.connect(g); g.connect(voiceOut); g.connect(delaySend);
      a.start(t); b.start(t);
      a.stop(t + n.decay + 0.08); b.stop(t + n.decay + 0.08);
    },
  };

  var HAT_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];

  function metalHat(t, n, dmin, dmax, isOpen) {
    var g0 = amp(n.vel);
    var d = Math.max(dmin, Math.min(dmax, n.decay));
    var bp = filt('bandpass', 8000, 1.2, t);
    var hp = filt('highpass', 6000, null, t);
    var g = ctx.createGain();
    env(g.gain, t, g0 * 0.6, 0.001, d);
    for (var i = 0; i < HAT_RATIOS.length; i++) {
      var o = osc('square', 40 * HAT_RATIOS[i], t);
      o.connect(bp);
      o.start(t);
      o.stop(t + d + 0.03);
    }
    bp.connect(hp); hp.connect(g); g.connect(voiceOut);

    if (isOpen) {
      openHatGain = g;
    } else if (openHatGain) {
      try {
        openHatGain.gain.cancelScheduledValues(t);
        openHatGain.gain.setTargetAtTime(1e-4, t, 0.01);
      } catch (e) {}
      openHatGain = null;
    }
  }

  function buildGraph() {
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 22;
    comp.ratio.value = 3;
    comp.attack.value = 0.008;
    comp.release.value = 0.22;

    bus = ctx.createGain();
    bus.gain.value = 0.9;
    soloBus = ctx.createGain();
    soloBus.gain.value = 1;
    voiceOut = bus;

    delaySend = ctx.createGain();
    delaySend.gain.value = 0.18;
    var dl = ctx.createDelay(1.5);
    dl.delayTime.value = 60 / cfg.bpm / 2;
    var fb = ctx.createGain();
    fb.gain.value = 0.3;
    delaySend.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(comp);
    delaySend._delay = dl;

    bus.connect(comp);
    soloBus.connect(comp);
    comp.connect(ctx.destination);

    var len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  function applyAutoGain() {
    if (!bus) return;
    autoGain = 0.9 / Math.sqrt(1 + noteCount / 16);
    bus.gain.setTargetAtTime(autoGain, ctx.currentTime, 0.05);
  }

  function stepDur(i) {
    var base = 60 / cfg.bpm / 4;
    var s = cfg.swing || 0;
    return i % 2 === 0 ? base * (1 + s) : base * (1 - s);
  }

  function barSeconds() {
    var t = 0;
    for (var i = 0; i < cfg.steps; i++) t += stepDur(i);
    return t;
  }

  function indexNotes(notes) {
    var by = [];
    for (var i = 0; i < cfg.steps; i++) by.push([]);
    for (var j = 0; j < notes.length; j++) {
      var n = notes[j];
      if (n.step >= 0 && n.step < cfg.steps && VOICES[n.inst]) by[n.step].push(n);
    }
    return by;
  }

  function playNote(n, t, mul) {
    var v = VOICES[n.inst];
    if (!v) return;
    var note = (mul === undefined || mul === 1) ? n
      : { inst: n.inst, pitch: n.pitch, vel: n.vel * mul, decay: n.decay };
    try { v(t, note); } catch (e) {}
  }

  function scheduleStep(i, t) {
    var list = pattern[i];
    var previewing = overlay && overlay.step === i;
    var duck = previewing ? DUCK : 1;
    if (list) for (var k = 0; k < list.length; k++) playNote(list[k], t, duck);
    if (previewing) playNote(overlay, t, 1);
  }

  function applyPending() {
    for (var i = 0; i < barHandlers.length; i++) barHandlers[i]();
    if (!pendingPattern) return;
    pattern = pendingPattern;
    pendingPattern = null;
    appliedVersion = pendingVersion;
    applyAutoGain();
    if (UB.audio.onApplied) UB.audio.onApplied(appliedVersion);
  }

  function scheduler() {
    if (!running) return;
    var ahead = document.hidden ? AHEAD_HIDDEN : AHEAD_VISIBLE;
    var guard = 0;
    while (nextNoteTime < ctx.currentTime + ahead && guard++ < 256) {
      scheduleStep(schedStep, nextNoteTime);
      uiQueue.push({ step: schedStep, time: nextNoteTime });
      nextNoteTime += stepDur(schedStep);
      schedStep += 1;
      if (schedStep >= cfg.steps) { schedStep = 0; applyPending(); }
    }
  }

  function raf() {
    var now = ctx ? ctx.currentTime : 0;
    while (uiQueue.length && uiQueue[0].time <= now) {
      var e = uiQueue.shift();
      if (uiQueue.length > cfg.steps * 2) continue;
      if (e.step !== visibleStep) {
        visibleStep = e.step;
        for (var i = 0; i < stepHandlers.length; i++) stepHandlers[i](e.step);
      }
    }
    rafId = requestAnimationFrame(raf);
  }

  function startTimer() {
    var src = 'let id;onmessage=e=>{clearInterval(id);if(e.data)id=setInterval(()=>postMessage(0),e.data)}';
    try {
      var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      var w = new Worker(url);
      w.onmessage = scheduler;
      w.postMessage(LOOKAHEAD_MS);
      timer = { stop: function () { w.postMessage(0); w.terminate(); URL.revokeObjectURL(url); } };
    } catch (e) {
      var id = setInterval(scheduler, LOOKAHEAD_MS);
      timer = { stop: function () { clearInterval(id); } };
    }
  }

  UB.audio = {
    isRunning: function () { return running; },
    version: function () { return appliedVersion; },
    step: function () { return visibleStep; },
    barSeconds: barSeconds,
    instruments: function () { return Object.keys(VOICES); },

    start: function () {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return Promise.reject(new Error('no-webaudio'));
        ctx = new AC({ latencyHint: 'interactive' });
        buildGraph();
        ctx.onstatechange = function () {
          if (ctx.state === 'suspended' && running) ctx.resume().catch(function () {});
        };
      }
      return (ctx.state === 'suspended' ? ctx.resume() : Promise.resolve()).then(function () {
        if (running) return;
        running = true;
        nextNoteTime = ctx.currentTime + 0.08;
        schedStep = 0;
        uiQueue.length = 0;
        applyAutoGain();
        startTimer();
        rafId = requestAnimationFrame(raf);
      });
    },

    stop: function () {
      running = false;
      if (timer) { timer.stop(); timer = null; }
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      uiQueue.length = 0;
      visibleStep = -1;
    },

    setConfig: function (next) {
      if (next.bpm) cfg.bpm = next.bpm;
      if (typeof next.swing === 'number') cfg.swing = next.swing;
      if (next.steps) cfg.steps = next.steps;
      if (next.scale && next.scale.length) cfg.scale = next.scale;
      if (delaySend && delaySend._delay && ctx) {
        delaySend._delay.delayTime.setTargetAtTime(60 / cfg.bpm / 2, ctx.currentTime, 0.05);
      }
    },

    setPattern: function (notes, version, immediate) {
      noteCount = notes.length;
      var indexed = indexNotes(notes);
      if (immediate || !running) {
        pattern = indexed;
        appliedVersion = version;
        pendingPattern = null;
        applyAutoGain();
        if (UB.audio.onApplied) UB.audio.onApplied(appliedVersion);
      } else {
        pendingPattern = indexed;
        pendingVersion = version;
      }
    },

    pendingVersion: function () { return pendingPattern ? pendingVersion : 0; },

    setOverlay: function (note) { overlay = note; },

    audition: function (inst, pitch, vel, decay) {
      if (!ctx || !VOICES[inst]) return;
      var now = Date.now();
      if (now - lastAudition < AUDITION_GAP_MS) return;
      lastAudition = now;
      if (ctx.state === 'suspended') { ctx.resume().catch(function () {}); return; }
      var at = ctx.currentTime + 0.01;
      var note = { inst: inst, pitch: pitch || 0, vel: vel == null ? 0.8 : vel, decay: decay == null ? 0.3 : decay };
      if (running) {
        var bg = bus.gain;
        bg.cancelScheduledValues(at);
        bg.setValueAtTime(bg.value, at);
        bg.linearRampToValueAtTime(autoGain * SOLO_DUCK, at + 0.02);
        bg.linearRampToValueAtTime(autoGain, at + 0.42);
      }
      var prev = voiceOut;
      voiceOut = soloBus;
      try { playNote(note, at, 1); } finally { voiceOut = prev; }
    },

    onStep: function (fn) { stepHandlers.push(fn); },
    onBar: function (fn) { barHandlers.push(fn); },
  };

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && ctx && running && ctx.state === 'suspended') ctx.resume().catch(function () {});
  });
})();
