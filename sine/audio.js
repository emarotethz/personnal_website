/* sine · audio transport
   Every unmuted block loops its rendered buffer, all voices locked to one
   shared clock so different loop lengths stay phase-aligned (polymeter).
   Muting is local: it only changes what this browser plays. */
(function () {
  'use strict';

  var SN = (window.SN = window.SN || {});

  var LEVEL = 0.8;
  var PREVIEW_LEVEL = 0.9;
  var DUCK = 0.25;
  var FADE = 0.08;

  var ctx = null;
  var mainBus = null;
  var pvBus = null;
  var comp = null;

  var running = false;
  var epoch = 0;      // ctx time at transport position zero
  var pausedPos = 0;  // transport position while stopped, seconds
  var voices = {};    // id -> {data, sr, dur, src, gain}
  var unmuted = {};
  var preview = null;

  function ensureCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      // a bigger output buffer: nothing here needs low latency, and it rides out CPU spikes
      // (a starved low-latency buffer is what makes the short repeating screech)
      try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 20;
      comp.ratio.value = 6;
      comp.attack.value = 0.004;
      comp.release.value = 0.24;
      mainBus = ctx.createGain();
      mainBus.gain.value = 1;
      pvBus = ctx.createGain();
      pvBus.gain.value = PREVIEW_LEVEL;
      var out = ctx.createGain();
      out.gain.value = 0.85;
      // a soft ceiling after everything, so stacking many songs bends instead of clipping
      var soft = ctx.createWaveShaper();
      var curve = new Float32Array(2048);
      for (var i = 0; i < curve.length; i++) {
        var x = i / (curve.length - 1) * 2 - 1;
        curve[i] = Math.tanh(x * 1.2) / Math.tanh(1.2);
      }
      soft.curve = curve;
      soft.oversample = '2x';
      mainBus.connect(comp);
      pvBus.connect(comp);
      comp.connect(out);
      out.connect(soft);
      soft.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') return ctx.resume();
    return Promise.resolve();
  }

  function pos() {
    return running ? ctx.currentTime - epoch : pausedPos;
  }

  function voice(id) {
    if (!voices[id]) voices[id] = { data: null, sr: 44100, dur: 0, src: null, gain: null };
    return voices[id];
  }

  function stopVoice(v) {
    if (!v.src) return;
    var src = v.src, g = v.gain;
    v.src = null;
    v.gain = null;
    var now = ctx.currentTime;
    try {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + FADE);
      src.stop(now + FADE + 0.02);
    } catch (e) { try { src.stop(); } catch (e2) {} }
  }

  function startVoice(id) {
    var v = voices[id];
    if (!v || !v.data || !ctx) return;
    stopVoice(v);
    var buf = ctx.createBuffer(1, v.data.length, v.sr);
    buf.copyToChannel(v.data, 0);
    v.dur = buf.duration;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    var g = ctx.createGain();
    var now = ctx.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(LEVEL, now + FADE);
    src.connect(g);
    g.connect(mainBus);
    var offset = ((pos() % v.dur) + v.dur) % v.dur;
    src.start(now, offset);
    v.src = src;
    v.gain = g;
  }

  SN.audio = {
    isRunning: function () { return running; },

    start: function () {
      return ensureCtx().then(function () {
        if (running) return;
        epoch = ctx.currentTime - pausedPos;
        running = true;
        Object.keys(voices).forEach(function (id) {
          if (unmuted[id]) startVoice(id);
        });
      });
    },

    stop: function () {
      if (!running) return;
      pausedPos = ctx.currentTime - epoch;
      running = false;
      Object.keys(voices).forEach(function (id) { stopVoice(voices[id]); });
    },

    setBuffer: function (id, f32, sr) {
      var v = voice(id);
      if (v.data === f32 && v.src) return;   // same wave already playing: leave it alone
      v.data = f32;
      v.sr = sr;
      v.dur = f32.length / sr;
      if (running && unmuted[id]) startVoice(id);
    },

    hasBuffer: function (id) {
      return !!(voices[id] && voices[id].data);
    },

    setUnmuted: function (id, on) {
      unmuted[id] = !!on;
      if (!on) { if (voices[id]) stopVoice(voices[id]); return; }
      if (running) startVoice(id);
    },

    remove: function (id) {
      if (voices[id]) stopVoice(voices[id]);
      delete voices[id];
      delete unmuted[id];
    },

    progress: function (id) {
      var v = voices[id];
      if (!running || !v || !v.src || !v.dur) return -1;
      return (((pos() % v.dur) + v.dur) % v.dur) / v.dur;
    },

    preview: function (f32, sr) {
      return ensureCtx().then(function () {
        SN.audio.stopPreview();
        var buf = ctx.createBuffer(1, f32.length, sr);
        buf.copyToChannel(f32, 0);
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        var g = ctx.createGain();
        var now = ctx.currentTime;
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(1, now + FADE);
        src.connect(g);
        g.connect(pvBus);
        src.start(now);
        preview = { src: src, gain: g };
        mainBus.gain.setTargetAtTime(DUCK, now, 0.05);
      });
    },

    stopPreview: function () {
      if (!preview) return;
      var p = preview, now = ctx.currentTime;
      preview = null;
      try {
        p.gain.gain.cancelScheduledValues(now);
        p.gain.gain.setValueAtTime(p.gain.gain.value, now);
        p.gain.gain.linearRampToValueAtTime(0, now + FADE);
        p.src.stop(now + FADE + 0.02);
      } catch (e) { try { p.src.stop(); } catch (e2) {} }
      mainBus.gain.setTargetAtTime(1, now, 0.05);
    },

    isPreviewing: function () { return !!preview; },
  };
})();
