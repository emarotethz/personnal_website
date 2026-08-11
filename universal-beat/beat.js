
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var POLL_MIN = 6000, POLL_MAX = 60000;
  var CACHE_KEY = 'ub.state.v1';
  var TOKEN_KEY = 'ub.token.v1';

  var S = {
    beat: null,
    incoming: null,
    me: null,
    sel: null,
    intent: null,
    draft: null,
    preview: false,
    confirming: false,
    busy: false,
    nonce: null,
    offline: false,
    serverVersion: 0,
  };

  function readOnly() { return S.offline || !!(S.me && S.me.locked); }

  function autoAudition(inst, pitch, vel, decay) {
    if (UB.audio.isRunning()) return;
    UB.audio.audition(inst, pitch, vel, decay);
  }

  var cells = {};
  var pollTimer = 0, pollMs = POLL_MIN;

  var NAMES = { kick: 'Kick', snare: 'Snare', hat: 'Hat', openhat: 'Open hat', clap: 'Clap', rim: 'Rim', tom: 'Tom', bass: 'Bass', pluck: 'Pluck' };
  var PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function label(inst) { return NAMES[inst] || inst; }
  function noteName(midi) { return PITCH_NAMES[midi % 12] + (Math.floor(midi / 12) - 1); }
  function isPitched(inst) { return S.beat && S.beat.pitched.indexOf(inst) !== -1; }

  function ago(ts) {
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function readToken() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function saveToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {} }
  function cacheBeat(b) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(b)); } catch (e) {} }
  function cachedBeat() { try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (e) { return null; } }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    var t = readToken();
    if (t) opts.headers['X-Beat-Token'] = t;
    opts.cache = 'no-store';
    return fetch(path, opts);
  }

  function banner(kind, text, quiet) {
    var el = $('banner');
    if (!kind) { el.hidden = true; return; }
    $('bannerK').textContent = kind;
    $('bannerT').textContent = text;
    el.className = quiet ? 'banner quiet' : 'banner';
    el.hidden = false;
  }

  function buildGrid(beat) {
    var grid = $('grid');
    var head = $('playhead');
    grid.innerHTML = '';
    grid.appendChild(head);
    cells = {};

    beat.instruments.forEach(function (inst) {
      var lab = document.createElement('div');
      lab.className = 'rlabel';
      lab.textContent = label(inst);
      grid.appendChild(lab);

      cells[inst] = [];
      for (var s = 0; s < beat.steps; s++) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = s % 4 === 0 ? 'cell b4' : 'cell';
        b.setAttribute('aria-label', label(inst) + ', step ' + (s + 1));
        b.dataset.inst = inst;
        b.dataset.step = String(s);
        b.addEventListener('click', onCellClick);
        grid.appendChild(b);
        cells[inst].push(b);
      }
    });

    var sl = $('steplabels');
    sl.innerHTML = '<span></span>';
    for (var i = 0; i < beat.steps; i++) {
      var sp = document.createElement('span');
      sp.textContent = String(i + 1);
      if (i % 4 !== 0) sp.style.opacity = '.35';
      sl.appendChild(sp);
    }
  }

  function paint() {
    if (!S.beat) return;
    var byId = {};
    var occupied = {};
    S.beat.notes.forEach(function (n) { byId[n.id] = n; occupied[n.inst + ':' + n.step] = n; });

    var incomingSlots = {};
    if (S.incoming) {
      var future = {};
      S.incoming.notes.forEach(function (n) { future[n.inst + ':' + n.step] = n; });
      Object.keys(future).forEach(function (k) {
        var a = occupied[k], b = future[k];
        if (!a || a.id !== b.id || a.vel !== b.vel || a.pitch !== b.pitch || a.decay !== b.decay) incomingSlots[k] = true;
      });
      Object.keys(occupied).forEach(function (k) { if (!future[k]) incomingSlots[k] = true; });
    }

    var mineId = S.me && S.me.noteId;
    var locked = S.me && S.me.locked;

    Object.keys(cells).forEach(function (inst) {
      cells[inst].forEach(function (btn, step) {
        var key = inst + ':' + step;
        var n = occupied[key];
        var cls = step % 4 === 0 ? 'cell b4' : 'cell';
        btn.style.backgroundColor = '';
        btn.innerHTML = '';

        if (n) {
          cls += ' on';
          btn.style.backgroundColor = 'rgba(232,90,26,' + (0.25 + 0.55 * n.vel).toFixed(3) + ')';
          var d = document.createElement('span');
          d.className = 'decay';
          d.style.width = Math.round(Math.min(1, n.decay / 1.5) * 100) + '%';
          btn.appendChild(d);
          if (isPitched(inst)) {
            var g = document.createElement('span');
            g.className = 'deg';
            g.textContent = String(n.pitch + 1);
            btn.appendChild(g);
          }
          if (mineId && n.id === mineId) cls += ' mine';
        }

        if (S.sel && S.sel.inst === inst && S.sel.step === step) cls += ' sel';
        if (S.preview && S.sel && S.sel.inst === inst && S.sel.step === step) cls += ' ghost';
        if (incomingSlots[key]) cls += ' ghost';
        btn.className = cls;
        btn.disabled = false;
        btn.title = n
          ? label(inst) + ' · step ' + (step + 1) + ' · placed by a visitor from ' + n.country + ' ' + ago(n.at)
          : label(inst) + ' · step ' + (step + 1) + ' · empty';
      });
    });

    $('statVer').textContent = S.beat.version;
    $('statCount').textContent = S.beat.count;
    $('statMax').textContent = S.beat.maxNotes;
    $('statBpm').textContent = S.beat.bpm;
    if (locked) document.body.dataset.locked = '1';
  }

  function movePlayhead(step) {
    var head = $('playhead');
    var row = cells[Object.keys(cells)[0]];
    if (!row || !row[step]) return;
    var cell = row[step];
    head.style.transform = 'translateX(' + cell.offsetLeft + 'px)';
    head.style.width = cell.offsetWidth + 'px';
    head.classList.add('live');
    if (reduce) return;
    Object.keys(cells).forEach(function (inst) {
      var b = cells[inst][step];
      if (b && b.classList.contains('on')) {
        b.classList.add('hit');
        setTimeout(function () { b.classList.remove('hit'); }, 90);
      }
    });
  }

  function onCellClick(e) {
    var inst = e.currentTarget.dataset.inst;
    var step = +e.currentTarget.dataset.step;
    var note = S.beat.notes.filter(function (n) { return n.inst === inst && n.step === step; })[0] || null;

    pollMs = POLL_MIN;

    if (readOnly()) {
      autoAudition(inst, note ? note.pitch : 0, note ? note.vel : 0.8, note ? note.decay : 0.3);
      S.sel = { inst: inst, step: step, note: note };
      paint();
      renderInspector();
      return;
    }

    S.sel = { inst: inst, step: step, note: note };
    S.intent = note ? null : 'add';
    S.confirming = false;
    S.preview = false;
    UB.audio.setOverlay(null);
    S.draft = note
      ? { pitch: note.pitch, vel: note.vel, decay: note.decay }
      : { pitch: 0, vel: 0.8, decay: defaultDecay(inst) };
    if (!note) autoAudition(inst, S.draft.pitch, S.draft.vel, S.draft.decay);
    paint();
    renderInspector();
  }

  function defaultDecay(inst) {
    return ({ kick: 0.30, snare: 0.20, hat: 0.05, openhat: 0.35, clap: 0.25, rim: 0.04, tom: 0.35, bass: 0.40, pluck: 0.35 })[inst] || 0.3;
  }

  function sentence() {
    var s = S.sel, d = S.draft;
    var where = label(s.inst).toLowerCase() + ' on step ' + (s.step + 1);
    if (S.intent === 'add') return 'You will add a ' + where + '.';
    if (S.intent === 'remove') return 'You will delete the ' + where + ', placed by a visitor from ' + s.note.country + '.';
    return 'You will retune the ' + where + ', placed by a visitor from ' + s.note.country + '.';
  }

  function renderInspector() {
    var el = $('inspector');
    var s = S.sel;
    if (!s) { el.hidden = true; return; }
    el.hidden = false;

    var locked = readOnly();
    var n = s.note;
    var h = '';

    h += '<div class="insp-head"><div class="insp-title">' + label(s.inst) + ' · step ' + (s.step + 1) + '</div>';
    h += '<div class="insp-sub">' + (n
      ? 'Placed by a visitor from ' + n.country + ' · ' + ago(n.at)
      : 'Empty') + '</div></div>';

    if (locked) {
      var tapHint = UB.audio.isRunning() ? '' : ' Tap any cell to hear it on its own.';
      h += '<p style="color:var(--dim);margin-top:14px">' + (S.offline
        ? 'The loop cannot be reached right now, so nothing can be changed.'
        : 'You have already made your edit.') + tapHint + '</p>';
      el.innerHTML = h;
      return;
    }

    if (n && !S.intent) {
      h += '<p style="color:var(--dim);margin-top:14px">Someone else put this here. You can change how it sounds, or take it out.</p>';
      h += '<div class="insp-actions">';
      h += '<button class="btn" data-act="modify">Retune it</button>';
      h += '<button class="btn" data-act="remove">Delete it</button>';
      h += '<button class="btn" data-act="cancel">Close</button>';
      h += '</div>';
      el.innerHTML = h;
      wire(el);
      return;
    }

    if (S.intent === 'remove') {
      h += '<div class="confirm"><p>' + sentence() + ' <b>This is your only edit.</b></p>';
      h += '<div class="insp-actions" style="border:0;padding:0;margin:0">';
      h += '<button class="btn primary" data-act="commit"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Committing…' : 'Yes, delete it') + '</button>';
      h += '<button class="btn" data-act="back">Back</button></div></div>';
      el.innerHTML = h;
      wire(el);
      return;
    }

    var d = S.draft;
    h += '<div class="sliders">';
    if (isPitched(s.inst)) {
      var midi = S.beat.scale.midi[d.pitch];
      h += slider('pitch', 'Pitch', noteName(midi), 0, S.beat.scale.midi.length - 1, 1, d.pitch);
    }
    h += slider('vel', 'Velocity', Math.round(d.vel * 100) + '%', 0.15, 1, 0.01, d.vel);
    h += slider('decay', 'Decay', d.decay.toFixed(2) + 's', 0.02, 1.5, 0.01, d.decay);
    h += '</div>';

    h += '<div class="insp-actions">';
    h += '<button class="btn' + (S.preview ? ' on' : '') + '" data-act="preview">' + (S.preview ? 'Previewing in loop' : 'Preview in loop') + '</button>';
    h += '<button class="btn" data-act="hear">Hear it</button>';
    h += '<button class="btn primary" data-act="ask">Commit your one edit</button>';
    h += '<button class="btn" data-act="cancel">Cancel</button>';
    h += '</div>';

    if (S.confirming) {
      h += '<div class="confirm"><p>' + sentence() + ' <b>You cannot undo this and you cannot do it again.</b></p>';
      h += '<div class="insp-actions" style="border:0;padding:0;margin:0">';
      h += '<button class="btn primary" data-act="commit"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Committing…' : 'Yes, commit') + '</button>';
      h += '<button class="btn" data-act="back">Cancel</button></div></div>';
    }

    el.innerHTML = h;
    wire(el);
  }

  function slider(key, name, val, min, max, stepv, value) {
    return '<div class="sl"><label for="sl-' + key + '">' + name + '<b id="v-' + key + '">' + val + '</b></label>' +
      '<input type="range" id="sl-' + key + '" data-k="' + key + '" min="' + min + '" max="' + max + '" step="' + stepv + '" value="' + value + '"></div>';
  }

  function wire(el) {
    el.querySelectorAll('[data-act]').forEach(function (b) { b.addEventListener('click', onAction); });
    el.querySelectorAll('input[type=range]').forEach(function (r) { r.addEventListener('input', onSlide); });
  }

  function draftNote() {
    return { inst: S.sel.inst, step: S.sel.step, pitch: S.draft.pitch, vel: S.draft.vel, decay: S.draft.decay };
  }

  function onSlide(e) {
    var k = e.target.dataset.k;
    var v = parseFloat(e.target.value);
    S.draft[k] = k === 'pitch' ? Math.round(v) : v;
    var out = $('v-' + k);
    if (out) {
      out.textContent = k === 'pitch' ? noteName(S.beat.scale.midi[S.draft.pitch])
        : k === 'vel' ? Math.round(S.draft.vel * 100) + '%'
        : S.draft.decay.toFixed(2) + 's';
    }
    autoAudition(S.sel.inst, S.draft.pitch, S.draft.vel, S.draft.decay);
    if (S.preview) UB.audio.setOverlay(draftNote());
  }

  function onAction(e) {
    var act = e.currentTarget.dataset.act;

    if (act === 'cancel') {
      S.sel = null; S.intent = null; S.preview = false; S.confirming = false;
      UB.audio.setOverlay(null);
      paint(); renderInspector();
      return;
    }
    if (act === 'back') { S.confirming = false; if (S.intent === 'remove') S.intent = null; renderInspector(); return; }
    if (act === 'modify') { S.intent = 'modify'; renderInspector(); return; }
    if (act === 'remove') { S.intent = 'remove'; renderInspector(); return; }
    if (act === 'hear') { UB.audio.audition(S.sel.inst, S.draft.pitch, S.draft.vel, S.draft.decay); return; }
    if (act === 'preview') {
      S.preview = !S.preview;
      UB.audio.setOverlay(S.preview ? draftNote() : null);
      paint(); renderInspector();
      return;
    }
    if (act === 'ask') { S.confirming = true; renderInspector(); return; }
    if (act === 'commit') { commit(); return; }
  }

  function newNonce() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function commit() {
    if (S.busy) return;
    S.busy = true;
    renderInspector();

    if (!S.nonce) S.nonce = newNonce();
    var body = { op: S.intent, nonce: S.nonce };
    if (S.intent === 'add') {
      body.inst = S.sel.inst; body.step = S.sel.step;
      body.pitch = S.draft.pitch; body.vel = S.draft.vel; body.decay = S.draft.decay;
    } else {
      body.id = S.sel.note.id;
      if (S.intent === 'modify') { body.pitch = S.draft.pitch; body.vel = S.draft.vel; body.decay = S.draft.decay; }
    }

    api('/api/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) {
        S.busy = false;
        if (res.status === 200) return committed(res.j);

        if (res.status === 404 || res.status === 409) {
          S.nonce = null;
          S.sel = null; S.intent = null; S.preview = false; S.confirming = false;
          UB.audio.setOverlay(null);
          banner('Nothing was spent',
            res.j.error === 'full'
              ? 'The loop filled up while you were deciding. Your edit is still yours.'
              : 'Someone changed that note while you were deciding. Your edit is still yours, so pick another one.');
          return refresh().then(function () { paint(); renderInspector(); });
        }

        if (res.status === 403 && res.j.error === 'ip-cap') {
          banner('Already claimed here',
            'Ten people have already edited from this network. Offices, universities and mobile carriers all share one address, so this can happen even if you have never been here before.', true);
        } else if (res.status === 403) {
          banner('You have already played', 'This device has made its edit.', true);
        } else {
          banner('That did not go through', 'Nothing was committed and your edit is still yours. Try again.');
        }
        S.confirming = false;
        return refresh().then(function () { paint(); renderInspector(); });
      })
      .catch(function () {
        S.busy = false;
        banner('Connection lost', 'We could not tell whether that went through. Press commit again. It will not count twice.');
        renderInspector();
      });
  }

  function committed(j) {
    S.nonce = null;
    S.preview = false; S.confirming = false; S.intent = null; S.sel = null;
    UB.audio.setOverlay(null);
    applyBeat(j.state);
    banner('Your move is in the loop', 'It plays for everyone who opens this page, until someone takes it out.');
    return refreshMe().then(function () { paint(); renderInspector(); renderBudget(); });
  }

  function applyBeat(beat) {
    cacheBeat(beat);
    S.serverVersion = beat.version;
    if (!S.beat) {
      S.beat = beat;
      buildGrid(beat);
      UB.audio.setConfig({ bpm: beat.bpm, swing: beat.swing, steps: beat.steps, scale: beat.scale.midi });
      UB.audio.setPattern(beat.notes, beat.version, true);
      paint();
      return;
    }
    if (beat.version === S.beat.version) return;
    if (S.incoming && S.incoming.version === beat.version) return;

    UB.audio.setConfig({ bpm: beat.bpm, swing: beat.swing, steps: beat.steps, scale: beat.scale.midi });
    if (!UB.audio.isRunning()) {
      S.beat = beat; S.incoming = null;
      UB.audio.setPattern(beat.notes, beat.version, true);
      paint();
    } else {
      S.incoming = beat;
      UB.audio.setPattern(beat.notes, beat.version, false);
      paint();
    }
  }

  UB.audio.onApplied = function () {
    if (S.incoming) { S.beat = S.incoming; S.incoming = null; paint(); }
  };

  function renderBudget() {
    var el = $('budget');
    var me = S.me;
    if (!me) return;
    if (me.locked && me.reason === 'ip-cap') {
      el.hidden = false;
      el.dataset.state = 'capped';
      el.textContent = 'This network has used its edits';
      return;
    }
    if (me.locked) {
      el.hidden = false;
      el.dataset.state = 'spent';
      var p = me.placed;
      var txt = 'You have played your one edit';
      if (p) {
        var verb = p.kind === 'add' ? 'added a ' : p.kind === 'remove' ? 'deleted a ' : 'retuned the ';
        txt = 'You ' + verb + label(p.inst).toLowerCase() + ' on step ' + (p.step + 1) + ', ' + ago(p.at);
      }
      el.textContent = txt;

      if (me.fate) {
        banner(me.fate.kind === 'removed' ? 'Your note was deleted' : 'Your note was retuned',
          'A visitor from ' + me.fate.by + ' ' + (me.fate.kind === 'removed' ? 'removed' : 'reshaped') +
          ' your ' + label(me.fate.inst).toLowerCase() + ' on step ' + (me.fate.step + 1) + ', ' + ago(me.fate.at) + '.', true);
      }
      return;
    }

    el.hidden = true;
    el.textContent = '';
    el.dataset.state = 'open';
  }

  function renderLedger(edits) {
    var ol = $('ledger');
    if (!edits || !edits.length) { ol.innerHTML = '<li>Nothing yet. Be first.</li>'; return; }
    ol.innerHTML = '';
    edits.forEach(function (e) {
      var li = document.createElement('li');
      if (e.victim) li.className = 'v';
      var verb = e.kind === 'add' ? 'added a' : e.kind === 'remove' ? 'removed a' : 'retuned a';
      li.innerHTML = '<span>a visitor from <b>' + e.country + '</b> ' + verb + ' <b>' +
        label(e.inst).toLowerCase() + '</b> on step ' + (e.step + 1) + '</span><span class="ago">' + ago(e.at) + '</span>';
      ol.appendChild(li);
    });
  }

  function refresh() {
    return api('/api/beat').then(function (r) { return r.json(); }).then(function (b) {
      if (S.offline) {
        S.offline = false;
        banner(null);
        renderInspector();
      }
      applyBeat(b);
      return b;
    });
  }

  function refreshMe() {
    return api('/api/me').then(function (r) { return r.json(); }).then(function (m) {
      S.me = m;
      if (m.token) saveToken(m.token);
      renderBudget();
      return m;
    }).catch(function () {});
  }

  function refreshLedger() {
    return api('/api/ledger?limit=12').then(function (r) { return r.json(); })
      .then(function (j) { renderLedger(j.edits); }).catch(function () {});
  }

  function poll() {
    if (document.hidden) return;

    var before = S.serverVersion;
    refresh().then(function (b) {
      if (b.version === before) pollMs = Math.min(POLL_MAX, Math.round(pollMs * 1.5));
      else { pollMs = POLL_MIN; refreshLedger(); }
      schedulePoll(pollMs);
    }).catch(function () {
      if (!S.beat) offlineFallback();
      pollMs = Math.min(POLL_MAX, Math.round(pollMs * 1.5));
      schedulePoll(pollMs);
    });
  }

  function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }

  function offlineFallback() {
    var b = cachedBeat();
    if (!b) { banner('Offline', 'The loop could not be reached.'); return; }
    S.offline = true;
    applyBeat(b);
    banner('Offline', 'Showing the last loop this browser saw. Edits are disabled until the connection is back.', true);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { pollMs = POLL_MIN; schedulePoll(0); }
    else clearTimeout(pollTimer);
  });

  function init() {
    $('listen').addEventListener('pointerdown', function (e) {
      e.preventDefault();
      var btn = e.currentTarget;
      if (UB.audio.isRunning()) {
        UB.audio.stop();
        btn.textContent = '▶ Listen';
        btn.classList.remove('playing');
        $('playhead').classList.remove('live');
        return;
      }
      UB.audio.start().then(function () {
        btn.textContent = '❙❙ Playing';
        btn.classList.add('playing');
        if (S.beat) UB.audio.setPattern(S.beat.notes, S.beat.version, true);
      }).catch(function () {
        banner('No audio', 'This browser would not start an audio context.');
      });
    });

    UB.audio.onStep(movePlayhead);

    refresh().catch(offlineFallback).then(refreshMe).then(refreshLedger).then(function () {
      schedulePoll(POLL_MIN);
      requestAnimationFrame(function () {
        document.querySelectorAll('.reveal').forEach(function (n) { n.classList.add('in'); });
      });
    });
  }

  if (document.fonts && document.fonts.ready) document.fonts.ready.then(init);
  else window.addEventListener('load', init);
})();
