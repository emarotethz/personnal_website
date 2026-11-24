(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var POLL_MIN = 6000, POLL_MAX = 60000;
  var CACHE_KEY = 'sine.state.v2';
  var TOKEN_KEY = 'sine.token.v1';
  var UNMUTED_KEY = 'sine.unmuted.v2';
  var AUTHOR_KEY = 'sine.author.v1';
  var VIEW_KEY = 'sine.view.v2';
  var TOUR_KEY = 'sine.tour.v1';

  // the grid: cards are 240 x 160, with 60 px of street between them
  var CW = 300, CH = 220, CARD_W = 240, CARD_H = 160;
  var PAD = 18;                    // a box's margin round its cards
  var Z_MIN = 0.12, Z_MAX = 2;
  var SCOPE_MS = 46;

  var S = {
    st: null, byId: {}, mine: {}, unmuted: {},
    view: { x: 60, y: 60, z: 1 }, viewInited: false,
    ed: null, offline: false, serverVersion: 0,
    pos: {},           // id -> {x, y}: where each card is drawn right now
    dragging: null,
    hash: null,
  };

  var blockEls = {}, boxEls = {};
  var pollTimer = 0, pollMs = POLL_MIN, rafId = 0;

  /* ---------- small utils ---------- */

  function ago(ts) {
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsJson(k) { try { return JSON.parse(lsGet(k)); } catch (e) { return null; } }
  function newNonce() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function ease(x) { return 1 - Math.pow(1 - x, 3); }
  function easeInOut(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }

  var PALETTE = {
    orange: '#E85A1A', red: '#E5484D', gold: '#E2A33C', green: '#7FB069', teal: '#35B8A4',
    sky: '#58A6D6', blue: '#5B7CFA', violet: '#9B6DF0', pink: '#D2609A', sand: '#C9B58B',
  };
  function hexOf(c) { return /^#[0-9a-f]{6}$/i.test(c || '') ? c : PALETTE[c] || PALETTE.orange; }
  function luminance(hex) {
    var n = parseInt(hex.slice(1), 16);
    var lin = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  }
  // black or white text, whichever reads on this colour
  function textOn(hex) { return luminance(hex) > 0.3 ? '#000' : '#fff'; }
  // a picked colour too dark for a black page gets lifted until it shows
  function lift(hex) {
    var n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    for (var i = 0; i < 40 && luminance(hex) < 0.1; i++) {
      r = Math.min(255, Math.round(r + (255 - r) * 0.08 + 4));
      g = Math.min(255, Math.round(g + (255 - g) * 0.08 + 4));
      b = Math.min(255, Math.round(b + (255 - b) * 0.08 + 4));
      hex = '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
    }
    return hex;
  }
  function rgba(hex, a) {
    return 'rgba(' + parseInt(hex.slice(1, 3), 16) + ',' + parseInt(hex.slice(3, 5), 16) + ',' +
      parseInt(hex.slice(5, 7), 16) + ',' + a + ')';
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    var t = lsGet(TOKEN_KEY);
    if (t) opts.headers['X-Beat-Token'] = t;
    opts.cache = 'no-store';
    return fetch(path, opts);
  }

  var bannerTimer = 0;
  function banner(kind, text, quiet) {
    var el = $('banner');
    clearTimeout(bannerTimer);
    if (!kind) { el.classList.remove('on'); return; }
    $('bannerK').textContent = kind;
    $('bannerT').textContent = text || '';
    el.className = quiet ? 'banner quiet on' : 'banner on';
    if (quiet) bannerTimer = setTimeout(function () { el.classList.remove('on'); }, 5000);
  }
  function bannerShown() { return $('banner').classList.contains('on'); }

  /* ---------- muting (local only) ---------- */

  function loadUnmuted() {
    S.firstVisit = lsGet(UNMUTED_KEY) == null;
    var arr = lsJson(UNMUTED_KEY);
    S.unmuted = {};
    if (Array.isArray(arr)) arr.forEach(function (id) { S.unmuted[id] = true; });
  }
  function saveUnmuted() { lsSet(UNMUTED_KEY, JSON.stringify(Object.keys(S.unmuted))); }

  function setMuted(id, muted, quiet) {
    if (!S.byId[id]) return;
    if (muted) delete S.unmuted[id];
    else S.unmuted[id] = true;
    saveUnmuted();
    SN.audio.setUnmuted(id, !muted);
    if (!muted) SN.engine.request(id);
    SN.engine.setNeeded(Object.keys(S.unmuted));
    paintCard(id);
    if (muted) drawThumb(id);
    if (!quiet) { paintWires(); renderGroupBoxes(); renderBoxPanel(); }
  }

  /* ---------- boxes: who owns what ---------- */

  function groupFirst(blocks, name) {
    var first = null;
    blocks.forEach(function (b) {
      if (b.group !== name) return;
      if (!first || b.at < first.at || (b.at === first.at && b.id < first.id)) first = b;
    });
    return first;
  }
  function groupIsMine(name) {
    var f = S.st && groupFirst(S.st.blocks, name);
    return !!f && !!S.mine[f.id];
  }
  function groupExists(name) { return !!(S.st && S.st.blocks.some(function (b) { return b.group === name; })); }

  // a fork goes in its maker's own box (same rule as the server)
  function defaultGroup(parent, author) {
    if (parent.group && groupIsMine(parent.group)) return parent.group;
    var last = null;
    S.st.blocks.forEach(function (b) {
      if (!S.mine[b.id] || !b.group || !groupIsMine(b.group)) return;
      if (!last || b.updatedAt > last.updatedAt) last = b;
    });
    if (last) return last.group;
    var base = (author || 'anonymous').slice(0, 21).trim() || 'anonymous';
    var name = base;
    for (var i = 2; groupExists(name) && !groupIsMine(name); i++) name = base + ' ' + i;
    return name;
  }

  // where a block of `group` may sit (mirrors placeBlock on the server)
  function placeBlock(blocks, group, col, row, selfId) {
    var others = blocks.filter(function (b) { return b.id !== selfId; });
    var taken = {};
    others.forEach(function (b) { taken[b.col + ':' + b.row] = true; });
    var boxes = {};
    others.forEach(function (b) {
      if (!b.group) return;
      var g = boxes[b.group];
      if (!g) boxes[b.group] = { c0: b.col, c1: b.col, r0: b.row, r1: b.row };
      else { g.c0 = Math.min(g.c0, b.col); g.c1 = Math.max(g.c1, b.col); g.r0 = Math.min(g.r0, b.row); g.r1 = Math.max(g.r1, b.row); }
    });
    var mine = group ? boxes[group] : null;
    var fences = Object.keys(boxes).filter(function (k) { return k !== group; }).map(function (k) {
      var g = boxes[k]; return { c0: g.c0 - 1, c1: g.c1 + 1, r0: g.r0 - 1, r1: g.r1 + 1 };
    });
    var loose = others.filter(function (b) { return !b.group; });
    var members = group ? others.filter(function (b) { return b.group === group; }).map(function (b) { return [b.col, b.row]; }) : [];
    function hits(f, c0, c1, r0, r1) { return c0 <= f.c1 && c1 >= f.c0 && r0 <= f.r1 && r1 >= f.r0; }
    function connected(cells) {
      var all = {}, seen = {}, stack = [cells[0]], count = 1;
      cells.forEach(function (c) { all[c[0] + ':' + c[1]] = true; });
      seen[cells[0][0] + ':' + cells[0][1]] = true;
      while (stack.length) {
        var c = stack.pop();
        [[c[0] + 1, c[1]], [c[0] - 1, c[1]], [c[0], c[1] + 1], [c[0], c[1] - 1]].forEach(function (nb) {
          var k = nb[0] + ':' + nb[1];
          if (all[k] && !seen[k]) { seen[k] = true; count++; stack.push(nb); }
        });
      }
      return count === Object.keys(all).length;
    }
    function ok(c, r) {
      if (Math.abs(c) > 200 || Math.abs(r) > 200 || taken[c + ':' + r]) return false;
      if (!group) return !fences.some(function (f) { return hits(f, c, c, r, r); });
      var c0 = mine ? Math.min(mine.c0, c) : c, c1 = mine ? Math.max(mine.c1, c) : c;
      var r0 = mine ? Math.min(mine.r0, r) : r, r1 = mine ? Math.max(mine.r1, r) : r;
      if (fences.some(function (f) { return hits(f, c0, c1, r0, r1); })) return false;
      if (loose.some(function (b) { return b.col >= c0 - 1 && b.col <= c1 + 1 && b.row >= r0 - 1 && b.row <= r1 + 1; })) return false;
      return !members.length || connected(members.concat([[c, r]]));
    }
    var at = nearest(col, row, ok);
    return at && { col: at[0], row: at[1] };
  }

  // how far a whole box may shift (mirrors placeBox in sine-schema.mjs)
  function boxShift(blocks, group, dc, dr) {
    var c0 = 1e9, c1 = -1e9, r0 = 1e9, r1 = -1e9, boxes = {}, loose = [];
    blocks.forEach(function (b) {
      if (b.group === group) {
        c0 = Math.min(c0, b.col); c1 = Math.max(c1, b.col); r0 = Math.min(r0, b.row); r1 = Math.max(r1, b.row);
      } else if (!b.group) loose.push(b);
      else {
        var g = boxes[b.group];
        if (!g) boxes[b.group] = { c0: b.col, c1: b.col, r0: b.row, r1: b.row };
        else { g.c0 = Math.min(g.c0, b.col); g.c1 = Math.max(g.c1, b.col); g.r0 = Math.min(g.r0, b.row); g.r1 = Math.max(g.r1, b.row); }
      }
    });
    if (!group || c0 > c1) return null;
    var fences = Object.keys(boxes).map(function (k) {
      var g = boxes[k]; return { c0: g.c0 - 1, c1: g.c1 + 1, r0: g.r0 - 1, r1: g.r1 + 1 };
    });
    var at = nearest(dc, dr, function (sc, sr) {
      var a0 = c0 + sc, a1 = c1 + sc, b0 = r0 + sr, b1 = r1 + sr;
      if (Math.max(-a0, a1, -b0, b1) > 200) return false;
      if (fences.some(function (f) { return a0 <= f.c1 && a1 >= f.c0 && b0 <= f.r1 && b1 >= f.r0; })) return false;
      return !loose.some(function (b) { return b.col >= a0 - 1 && b.col <= a1 + 1 && b.row >= b0 - 1 && b.row <= b1 + 1; });
    });
    return at && { dc: at[0], dr: at[1] };
  }

  // the cell nearest (c, r) that ok() takes, looking out ring by ring
  function nearest(c, r, ok) {
    for (var rad = 0; rad <= 40; rad++) {
      var ring = [];
      for (var dc = -rad; dc <= rad; dc++) for (var dr = -rad; dr <= rad; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) === rad) ring.push([dc, dr]);
      }
      ring.sort(function (a, b) { return (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]; });
      for (var i = 0; i < ring.length; i++) if (ok(c + ring[i][0], r + ring[i][1])) return [c + ring[i][0], r + ring[i][1]];
    }
    return null;
  }

  /* ---------- workspace state ---------- */

  function applyState(st) {
    lsSet(CACHE_KEY, JSON.stringify(st));
    S.st = st;
    S.serverVersion = st.version;
    S.byId = {};
    st.blocks.forEach(function (b) { S.byId[b.id] = b; });

    if (S.firstVisit) {
      S.firstVisit = false;
      st.blocks.forEach(function (b) { if (!b.parent) S.unmuted[b.id] = true; });
    }
    Object.keys(S.unmuted).forEach(function (id) {
      if (!S.byId[id]) { delete S.unmuted[id]; SN.audio.remove(id); }
    });
    saveUnmuted();

    SN.engine.setState(st.blocks, { bpm: st.bpm, sr: st.sr });
    SN.engine.setNeeded(Object.keys(S.unmuted));
    $('statBpm').textContent = st.bpm;

    reconcile();
    renderGroupBoxes();
    updateGroupDatalist();
    renderLedger(st.ledger);
    routeAll();

    Object.keys(S.unmuted).forEach(function (id) {
      SN.audio.setUnmuted(id, true);
      SN.engine.request(id);
    });

    if (!S.viewInited) {
      S.viewInited = true;
      var saved = lsJson(VIEW_KEY);
      if (S.hash && S.byId[S.hash]) focusBlock(S.hash, false);
      else if (saved && typeof saved.x === 'number' && typeof saved.z === 'number') { S.view = saved; applyView(); }
      else fitView(false);
    }
    if (S.ed && S.ed.id && !S.byId[S.ed.id]) closeEditor();
    renderBoxPanel();
  }

  /* ---------- cards ---------- */

  function cellXY(col, row) { return { x: col * CW, y: row * CH }; }

  function buildCard(b) {
    var el = document.createElement('div');
    el.className = 'block pending';
    el.dataset.id = b.id;
    el.innerHTML = '<canvas class="wave" width="480" height="112"></canvas><div class="bprog"></div>' +
      '<div class="bname"></div><div class="bby"></div><div class="bbtns">' +
      '<button type="button" class="bbtn mute"></button><button type="button" class="bbtn fork">fork</button>' +
      '<button type="button" class="bbtn edit"></button></div><span class="berr" hidden>error</span>';
    el.querySelector('.mute').addEventListener('click', function (e) {
      e.stopPropagation();
      setMuted(b.id, !!S.unmuted[b.id]);
    });
    el.querySelector('.fork').addEventListener('click', function (e) { e.stopPropagation(); openFork(b.id); });
    el.querySelector('.edit').addEventListener('click', function (e) { e.stopPropagation(); openBlock(b.id); });
    el.addEventListener('pointerdown', onCardPointerDown);
    $('cards').appendChild(el);
    blockEls[b.id] = el;
    var p = cellXY(b.col, b.row);
    S.pos[b.id] = { x: p.x, y: p.y };
    placeEl(b.id);
    if (el.animate) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
    drawThumb(b.id);
    return el;
  }

  function placeEl(id) {
    var el = blockEls[id], p = S.pos[id];
    // the translate property, not transform, so the lift scale of a dragged card stays round its centre
    if (el && p) el.style.translate = p.x + 'px ' + p.y + 'px';
  }

  function paintCard(id) {
    var b = S.byId[id], el = blockEls[id];
    if (!b || !el) return;
    el.classList.toggle('live', !!S.unmuted[id]);
    el.classList.toggle('mine', !!S.mine[id]);
    el.classList.toggle('root', !b.parent);
    if (el.dataset.color !== b.color) {
      el.dataset.color = b.color;
      el.style.setProperty('--bc', hexOf(b.color));
      el.style.setProperty('--bt', textOn(hexOf(b.color)));
      drawThumb(id);
    }
    el.querySelector('.bname').textContent = b.name;
    var who = 'by <b>' + esc(b.author) + '</b> &middot; ' + b.beats + (b.beats === 1 ? ' beat' : ' beats');
    if (b.agent) who += ' &middot; agent';
    if (S.mine[id]) who += ' &middot; <span class="yours">yours</span>';
    el.querySelector('.bby').innerHTML = who;
    el.querySelector('.mute').textContent = S.unmuted[id] ? (SN.audio.isRunning() ? 'playing' : 'on') : 'muted';
    el.querySelector('.edit').textContent = S.mine[id] ? 'edit' : 'code';
    var msg = SN.engine.error(id);
    var err = el.querySelector('.berr');
    err.hidden = !msg;
    if (msg) err.title = msg;
  }

  function reconcile() {
    Object.keys(blockEls).forEach(function (id) {
      if (S.byId[id]) return;
      var el = blockEls[id];
      delete blockEls[id];
      delete S.pos[id];
      if (el.animate) el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200 }).onfinish = function () { el.remove(); };
      else el.remove();
    });
    S.st.blocks.forEach(function (b) {
      if (!blockEls[b.id]) buildCard(b);
      else if (S.dragging !== b.id && !(S.dragBox && S.dragBox === b.group)) {
        var to = cellXY(b.col, b.row), p = S.pos[b.id], tw = tweens[b.id];
        var dest = tw ? { x: tw.tx, y: tw.ty } : p;
        if (dest.x !== to.x || dest.y !== to.y) tweenTo(b.id, to);
      }
      paintCard(b.id);
    });
  }

  /* ---------- waves ---------- */

  function paintWave(canvas, buf, hex, from, span) {
    var g = canvas.getContext('2d');
    var w = canvas.width, hh = canvas.height;
    g.clearRect(0, 0, w, hh);
    g.fillStyle = 'rgba(243,241,236,0.14)';
    g.fillRect(0, hh / 2, w, 1);
    if (!buf || !buf.length || span < 1) return;
    var len = buf.length, mid = hh / 2, amp = hh / 2 - 3;
    g.fillStyle = hex || PALETTE.orange;
    var per = span / w;
    for (var x = 0; x < w; x++) {
      var lo = 1, hi = -1;
      var a = Math.floor(x * per), z = Math.max(a + 1, Math.ceil((x + 1) * per));
      var step = Math.max(1, Math.floor((z - a) / 40));
      for (var i = a; i < z; i += step) {
        var v = buf[(from + i) % len];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi < lo) continue;
      g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    }
  }
  function drawWave(canvas, buf, hex) { paintWave(canvas, buf, hex, 0, buf ? buf.length : 0); }
  function drawScope(canvas, buf, hex, dur, pos) {
    if (!buf || !buf.length || !dur) { paintWave(canvas, buf, hex, 0, 0); return; }
    var span = Math.max(2, Math.min(buf.length, Math.round(buf.length * (SCOPE_MS / 1000) / dur)));
    paintWave(canvas, buf, hex, Math.floor(pos * buf.length), span);
  }
  function drawThumb(id) {
    var el = blockEls[id], b = S.byId[id];
    if (!el || !b) return;
    var got = SN.engine.get(id);
    el.classList.toggle('pending', !got && !SN.engine.error(id) && !!b.parent);
    if (!b.parent) { drawSineIcon(el.querySelector('.wave'), hexOf(b.color)); return; }
    drawWave(el.querySelector('.wave'), got ? got.buf : null, hexOf(b.color));
  }
  // the root shows what it is: one clean sine
  function drawSineIcon(canvas, hex) {
    var g = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = hex;
    g.lineWidth = 4;
    g.beginPath();
    for (var x = 0; x <= w; x += 2) {
      var y = h / 2 - Math.sin(x / w * Math.PI * 6) * (h / 2 - 12);
      if (x) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
  }

  /* ---------- boxes ---------- */

  function groupsOf() {
    var m = {};
    S.st.blocks.forEach(function (b) {
      var name = b.group || '';
      if (!m[name]) m[name] = { name: name, blocks: [], at: b.at };
      m[name].blocks.push(b);
      if (b.at < m[name].at) m[name].at = b.at;
    });
    return Object.keys(m).map(function (k) { return m[k]; })
      .sort(function (a, z) { return (a.name === '') - (z.name === '') || a.at - z.at; });
  }

  // a box's rectangle, from where its cards are drawn right now
  function boxRect(g) {
    var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    g.blocks.forEach(function (b) {
      var p = S.pos[b.id] || cellXY(b.col, b.row);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x + CARD_W);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y + CARD_H);
    });
    return { x: x0 - PAD, y: y0 - PAD, w: x1 - x0 + PAD * 2, h: y1 - y0 + PAD * 2 };
  }

  function findGroup(name) {
    var gs = groupsOf();
    for (var i = 0; i < gs.length; i++) if (gs[i].name === name) return gs[i];
    return null;
  }

  function placeBox(box, g) {
    var r = boxRect(g);
    box.style.transform = 'translate(' + r.x + 'px,' + r.y + 'px)';
    box.style.width = r.w + 'px';
    box.style.height = r.h + 'px';
  }
  // during drags and glides: move the boxes, touch nothing else
  function positionBoxes() {
    groupsOf().forEach(function (g) { if (g.name && boxEls[g.name]) placeBox(boxEls[g.name], g); });
  }

  function renderGroupBoxes() {
    if (!S.st) return;
    var wrap = $('gboxes'), seen = {};
    groupsOf().forEach(function (g) {
      if (!g.name) return;
      seen[g.name] = true;
      var box = boxEls[g.name];
      if (!box) {
        box = document.createElement('div');
        box.className = 'gbox';
        box.innerHTML = '<div class="ghead"><button type="button" class="gname"></button>' +
          '<button type="button" class="gplay"></button></div>';
        box.querySelector('.gname').addEventListener('click', function () {
          var gg = findGroup(box.dataset.name);
          if (!gg) return;
          var opening = wide() && !$('work').classList.contains('editing');
          openBox(gg.name);
          var r = $('canvas').getBoundingClientRect();
          animateView(viewFor(gg.blocks, 1, opening ? r.width - sideWidth() : r.width), 520);
        });
        box.querySelector('.gplay').addEventListener('click', function () {
          var gg = findGroup(box.dataset.name);
          if (!gg) return;
          var turnOn = !gg.blocks.some(function (b) { return S.unmuted[b.id]; });
          gg.blocks.forEach(function (b) { setMuted(b.id, !turnOn, true); });
          refreshWires(); renderGroupBoxes(); renderBoxPanel();
          if (turnOn && !SN.audio.isRunning()) setListening(true);
          if (turnOn) tourEvent(isSineBox(gg) ? 'sine' : 'play');
        });
        box.addEventListener('pointerdown', onBoxPointerDown);
        wrap.appendChild(box);
        boxEls[g.name] = box;
      }
      box.dataset.name = g.name;
      var on = g.blocks.filter(function (b) { return S.unmuted[b.id]; }).length;
      box.dataset.on = on === 0 ? 'none' : on === g.blocks.length ? 'all' : 'some';
      box.classList.toggle('mine', groupIsMine(g.name));
      var gcol = hexOf(groupFirst(g.blocks, g.name).color);
      box.style.setProperty('--gc', gcol);
      box.style.setProperty('--gt', textOn(gcol));
      placeBox(box, g);
      var label = on === 0 ? '▶ play' : on === g.blocks.length ? '❚❚ on' : on + ' of ' + g.blocks.length;
      var gp = box.querySelector('.gplay'), gn = box.querySelector('.gname');
      if (gn.textContent !== g.name || gp.textContent !== label || !headSize[g.name]) {
        gn.textContent = g.name;
        gp.textContent = label;
        var head = box.querySelector('.ghead');
        headSize[g.name] = [head.offsetWidth, head.offsetHeight];
      }
    });
    Object.keys(boxEls).forEach(function (name) {
      if (seen[name]) return;
      boxEls[name].remove();
      delete boxEls[name];
    });
  }

  /* ---------- wires: one lane each, along the streets between cards ---------- */

  var GS = 10;                      // routing grid step, in world px
  var MARGIN = 6;                   // clearance round a card
  var TURN = 3, USE = 7, CROSS = 1.5, BOX_COST = 0.3;
  var wires = {};                   // block id -> the wire into it: {pts, d, color, exit, entry}
  var headSize = {};                // box name -> [w, h], measured when its text changes

  // a box's label, scaled by k (up close it grows to 0.55 / 0.45, zoomed out up to 2)
  function headRect(name, r, k) {
    var hs = headSize[name];
    if (!hs) return null;
    return { x: r.x, y: r.y - 26 - hs[1] * k, w: hs[0] * k, h: hs[1] * k };
  }

  function buildGrid() {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    Object.keys(S.pos).forEach(function (id) {
      var p = S.pos[id];
      x0 = Math.min(x0, p.x - PAD); y0 = Math.min(y0, p.y - PAD - 120);
      x1 = Math.max(x1, p.x + CARD_W + PAD); y1 = Math.max(y1, p.y + CARD_H + PAD);
    });
    if (x0 > x1) return null;
    x0 = Math.floor((x0 - 120) / GS) * GS; y0 = Math.floor((y0 - 120) / GS) * GS;
    x1 = Math.ceil((x1 + 120) / GS) * GS; y1 = Math.ceil((y1 + 120) / GS) * GS;
    var W = (x1 - x0) / GS + 1, H = (y1 - y0) / GS + 1, N = W * H;
    var g = {
      x0: x0, y0: y0, W: W, H: H, idx: {},
      hard: new Uint8Array(N), cost: new Float32Array(N), box: new Int16Array(N),
      useH: new Uint8Array(N), useV: new Uint8Array(N),
    };
    function mark(rx, ry, rw, rh, m, fn) {
      var i0 = Math.max(0, Math.floor((rx - m - x0) / GS) + 1), i1 = Math.min(W - 1, Math.ceil((rx + rw + m - x0) / GS) - 1);
      var j0 = Math.max(0, Math.floor((ry - m - y0) / GS) + 1), j1 = Math.min(H - 1, Math.ceil((ry + rh + m - y0) / GS) - 1);
      for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) fn(j * W + i);
    }
    var gi = 0;
    groupsOf().forEach(function (gr) {
      if (!gr.name) return;
      var k = ++gi;
      g.idx[gr.name] = k;
      var r = boxRect(gr), hr = headRect(gr.name, r, 0.55 / 0.45);
      if (hr) mark(hr.x, hr.y, hr.w, hr.h, 6, function (n) { g.hard[n] = 1; });
      mark(r.x, r.y, r.w, r.h, 0, function (n) { if (!g.box[n]) g.box[n] = k; });
    });
    Object.keys(S.pos).forEach(function (id) {
      var p = S.pos[id];
      mark(p.x, p.y, CARD_W, CARD_H, MARGIN, function (n) { g.hard[n] = 1; });
    });
    return g;
  }

  // every grid point just clear of a rectangle's sides: [node x, node y, dir, edge x, edge y, cost]
  // dir 0 right, 1 down, 2 left, 3 up; for exits it points away, for entries into the card
  function sidePorts(r, out) {
    var L = [];
    var xr = Math.floor((r.x + r.w + MARGIN) / GS) * GS + GS, xl = Math.ceil((r.x - MARGIN) / GS) * GS - GS;
    var yt = Math.ceil((r.y - MARGIN) / GS) * GS - GS, yb = Math.floor((r.y + r.h + MARGIN) / GS) * GS + GS;
    var cx = r.x + r.w / 2, cy = r.y + r.h / 2, y, x;
    for (y = Math.ceil((r.y + 20) / GS) * GS; y <= r.y + r.h - 20; y += GS) {
      var c = Math.abs(y - cy) / GS * 0.12;
      L.push(out ? [xr, y, 0, r.x + r.w, y, c, 'r'] : [xl, y, 0, r.x, y, c, 'l']);
    }
    for (x = Math.ceil((r.x + 20) / GS) * GS; x <= r.x + r.w - 20; x += GS) {
      var c2 = 1 + Math.abs(x - cx) / GS * 0.08;
      L.push([x, yt, out ? 3 : 1, x, r.y, c2, 't']);
      L.push([x, yb, out ? 1 : 3, x, r.y + r.h, c2, 'b']);
    }
    return L;
  }

  var DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  var heapC = [], heapS = [];
  function hpush(c, s) {
    var i = heapC.length;
    heapC.push(c); heapS.push(s);
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (heapC[p] <= c) break;
      heapC[i] = heapC[p]; heapS[i] = heapS[p]; i = p;
    }
    heapC[i] = c; heapS[i] = s;
  }
  function hpop() {
    var top = heapS[0], lc = heapC.pop(), ls = heapS.pop(), n = heapC.length;
    if (n) {
      var i = 0;
      while (true) {
        var l = 2 * i + 1, r = l + 1, m = i, mc = lc;
        if (l < n && heapC[l] < mc) { m = l; mc = heapC[l]; }
        if (r < n && heapC[r] < mc) m = r;
        if (m === i) break;
        heapC[i] = heapC[m]; heapS[i] = heapS[m]; i = m;
      }
      heapC[i] = lc; heapS[i] = ls;
    }
    return top;
  }

  function useCost(g, n, dir) {
    return dir & 1 ? USE * g.useV[n] + (g.useH[n] ? CROSS : 0) : USE * g.useH[n] + (g.useV[n] ? CROSS : 0);
  }

  // A* over the street grid: turns cost, and so does running in a lane another wire already uses
  function sideBias(side, dx, dy, out) {
    var horiz = Math.abs(dx) >= Math.abs(dy);
    var good = out
      ? (side === 'r' ? dx > 0 && horiz : side === 't' ? dy < 0 && !horiz : dy > 0 && !horiz)
      : (side === 'l' ? dx > 0 && horiz : side === 't' ? dy > 0 && !horiz : dy < 0 && !horiz);
    return good ? 0 : 1.2;
  }

  var prevMask = null;
  function route(g, from, to, okBoxes, last) {
    var W = g.W, H = g.H, N = W * H;
    var dx = (to.x + to.w / 2) - (from.x + from.w / 2), dy = (to.y + to.h / 2) - (from.y + from.h / 2);
    var keepExit = last && last.exit, keepEntry = last && last.entry;
    if (!prevMask || prevMask.length !== N) prevMask = new Uint8Array(N);
    var marked = last && last.pts ? stamp(g, last.pts, 1) : null;
    if (!g.best) { g.best = new Float32Array(N * 4); g.prev = new Int32Array(N * 4); }
    var best = g.best, prev = g.prev;
    best.fill(Infinity);
    heapC.length = 0; heapS.length = 0;
    var node = function (x, y) {
      var i = Math.round((x - g.x0) / GS), j = Math.round((y - g.y0) / GS);
      return i >= 0 && j >= 0 && i < W && j < H ? j * W + i : -1;
    };
    var targets = {}, tx0 = 1e9, tx1 = -1e9, ty0 = 1e9, ty1 = -1e9, any = false;
    sidePorts(to, false).forEach(function (e) {
      var n = node(e[0], e[1]);
      if (n < 0 || g.hard[n]) return;
      var cost = e[5] + sideBias(e[6], dx, dy, false) + (keepEntry && e[6] !== keepEntry ? 2.5 : 0);
      if (targets[n] && targets[n].cost <= cost) return;
      targets[n] = { dir: e[2], cost: cost, e: e };
      var i = n % W, j = (n - i) / W;
      tx0 = Math.min(tx0, i); tx1 = Math.max(tx1, i); ty0 = Math.min(ty0, j); ty1 = Math.max(ty1, j);
      any = true;
    });
    if (!any) return null;
    var h = function (n) {
      var i = n % W, j = (n - i) / W;
      return Math.max(0, tx0 - i, i - tx1) + Math.max(0, ty0 - j, j - ty1);
    };
    var starts = sidePorts(from, true);
    starts.forEach(function (e, k) {
      var n = node(e[0], e[1]);
      if (n < 0 || g.hard[n]) return;
      var s = n * 4 + e[2], c = e[5] + useCost(g, n, e[2]) + sideBias(e[6], dx, dy, true) + (keepExit && e[6] !== keepExit ? 2.5 : 0);
      if (c >= best[s]) return;
      best[s] = c;
      prev[s] = -1 - k;
      hpush(c + h(n), s);
    });
    var found = -1, fin = Infinity, ft = null, budget = 160000;
    while (heapC.length && budget-- > 0) {
      var s = hpop(), n = s >> 2, d = s & 3, c = best[s];
      if (c + h(n) >= fin) break;
      var t = targets[n];
      if (t) {
        var f = c + t.cost + (d === t.dir ? 0 : TURN);
        if (f < fin) { fin = f; found = s; ft = t; }
      }
      var i = n % W, j = (n - i) / W;
      for (var nd = 0; nd < 4; nd++) {
        if (nd === ((d + 2) & 3)) continue;
        var ni = i + DX[nd], nj = j + DY[nd];
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        var nn = nj * W + ni;
        if (g.hard[nn]) continue;
        var step = 1 + g.cost[nn] + (g.box[nn] && !okBoxes[g.box[nn]] ? BOX_COST : 0) + (nd === d ? 0 : TURN) + useCost(g, nn, nd)
          + (marked && !prevMask[nn] ? 0.25 : 0);
        var ns = nn * 4 + nd, nc = c + step;
        if (nc < best[ns]) { best[ns] = nc; prev[ns] = s; hpush(nc + h(nn), ns); }
      }
    }
    if (marked) stamp(g, last.pts, 0);
    if (found < 0) return null;
    var pts = [[ft.e[3], ft.e[4]]];
    var cur = found, k = -1;
    while (cur >= 0) {
      var cn = cur >> 2, ci = cn % W, cj = (cn - ci) / W;
      pts.push([g.x0 + ci * GS, g.y0 + cj * GS]);
      var pv = prev[cur];
      if (pv < 0) { k = -1 - pv; break; }
      cur = pv;
    }
    pts.push([starts[k][3], starts[k][4]]);
    pts.reverse();
    return { pts: simplify(pts), exit: starts[k][6], entry: ft.e[6] };
  }

  // mark (or clear) the grid points along a path in prevMask
  function stamp(g, pts, v) {
    for (var i = 1; i < pts.length - 2; i++) {
      var a = pts[i], b = pts[i + 1];
      var len = Math.round((Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])) / GS);
      var sx = Math.sign(b[0] - a[0]) * GS, sy = Math.sign(b[1] - a[1]) * GS;
      for (var k = 0; k <= len; k++) {
        var ii = Math.round((a[0] + sx * k - g.x0) / GS), jj = Math.round((a[1] + sy * k - g.y0) / GS);
        if (ii >= 0 && jj >= 0 && ii < g.W && jj < g.H) prevMask[jj * g.W + ii] = v;
      }
    }
    return true;
  }

  // claim the lanes a wire runs in, so the next wire picks its own
  function markUse(g, pts) {
    for (var i = 1; i < pts.length - 2; i++) {
      var a = pts[i], b = pts[i + 1];
      var horiz = a[1] === b[1];
      var len = Math.round((Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])) / GS);
      var sx = Math.sign(b[0] - a[0]) * GS, sy = Math.sign(b[1] - a[1]) * GS;
      for (var k = 0; k <= len; k++) {
        var ii = Math.round((a[0] + sx * k - g.x0) / GS), jj = Math.round((a[1] + sy * k - g.y0) / GS);
        if (ii < 0 || jj < 0 || ii >= g.W || jj >= g.H) continue;
        var n = jj * g.W + ii;
        if (horiz) g.useH[n] = Math.min(255, g.useH[n] + 1);
        else g.useV[n] = Math.min(255, g.useV[n] + 1);
      }
    }
  }

  function simplify(pts) {
    var out = [pts[0]];
    for (var i = 1; i < pts.length - 1; i++) {
      var a = out[out.length - 1], b = pts[i], c = pts[i + 1];
      if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) continue;
      out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  function rounded(pts) {
    var d = 'M' + pts[0][0] + ' ' + pts[0][1];
    for (var i = 1; i < pts.length - 1; i++) {
      var a = pts[i - 1], b = pts[i], c = pts[i + 1];
      var l1 = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]), l2 = Math.abs(c[0] - b[0]) + Math.abs(c[1] - b[1]);
      var r = Math.min(8, l1 / 2, l2 / 2);
      var ux = Math.sign(b[0] - a[0]), uy = Math.sign(b[1] - a[1]), vx = Math.sign(c[0] - b[0]), vy = Math.sign(c[1] - b[1]);
      d += ' L' + (b[0] - ux * r) + ' ' + (b[1] - uy * r) + ' Q' + b[0] + ' ' + b[1] + ' ' + (b[0] + vx * r) + ' ' + (b[1] + vy * r);
    }
    var z = pts[pts.length - 1];
    return d + ' L' + z[0] + ' ' + z[1];
  }

  function curve(a, b) {
    var x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return 'M' + x1 + ' ' + y1 + ' C' + (x1 + dx) + ' ' + y1 + ' ' + (x2 - dx) + ' ' + y2 + ' ' + x2 + ' ' + y2;
  }

  function cardRect(id) {
    var p = S.pos[id];
    return p ? { x: p.x, y: p.y, w: CARD_W, h: CARD_H } : null;
  }

  // a wire from every block to the block it forked; zoomed out shows some of these same wires
  function wireJobs() {
    var jobs = [];
    S.st.blocks.forEach(function (b) {
      var pb = b.parent && S.byId[b.parent];
      if (!pb) return;
      jobs.push({ key: b.id, from: b.parent, to: b.id, color: b.color, groups: [pb.group, b.group] });
    });
    return jobs;
  }

  function jobRects(job) { return [cardRect(job.from), cardRect(job.to)]; }

  function runJob(g, job, before) {
    var rs = jobRects(job);
    if (!rs[0] || !rs[1]) return;
    var ok = {};
    job.groups.forEach(function (name) { if (name && g && g.idx[name]) ok[g.idx[name]] = true; });
    var res = g ? route(g, rs[0], rs[1], ok, before) : null;
    var pts = res ? res.pts : null;
    if (pts) markUse(g, pts);
    wires[job.key] = {
      pts: pts, d: pts ? rounded(pts) : curve(rs[0], rs[1]), color: job.color,
      exit: res ? res.exit : null, entry: res ? res.entry : null,
    };
  }

  function jobLength(job) {
    var rs = jobRects(job);
    if (!rs[0] || !rs[1]) return 0;
    return Math.abs(rs[0].x - rs[1].x) + Math.abs(rs[0].y - rs[1].y);
  }

  var routeQueued = false;
  function routeAll() {
    if (!S.st) return;
    var g = buildGrid();
    var before = wires;
    wires = {};
    var jobs = wireJobs();
    jobs.sort(function (a, b) { return jobLength(a) - jobLength(b); });
    jobs.forEach(function (job) { runJob(g, job, before[job.key]); });
    paintWires();
  }
  function routeSoon() {
    if (routeQueued) return;
    routeQueued = true;
    requestAnimationFrame(function () { routeQueued = false; routeAll(); });
  }
  // only the wires touching these cards, for while things move; the rest keep their lanes
  function routeAround(ids) {
    var g = buildGrid();
    var jobs = wireJobs(), redo = [];
    jobs.forEach(function (job) {
      if (ids[job.from] || ids[job.to]) redo.push(job);
      else if (wires[job.key] && wires[job.key].pts) markUse(g, wires[job.key].pts);
    });
    redo.forEach(function (job) { runJob(g, job, wires[job.key]); });
    paintWires();
  }

  function refreshWires() { paintWires(); }

  // Zoomed out, each pair of boxes keeps one link: the shortest of the wires between them,
  // cut where it leaves one box and enters the other, so it lies exactly on that wire.
  // Wires to a sounding block win, so a lit link is a lit wire up close too, and so do
  // wires clear of the labels, which grow when zoomed out.
  function farLinks() {
    var gs = {}, labels = [], links = {};
    groupsOf().forEach(function (gr) {
      if (!gr.name) return;
      gs[gr.name] = boxRect(gr);
      var hr = headRect(gr.name, gs[gr.name], 2);
      if (hr) labels.push(hr);
    });
    var keyOf = function (b) { return b.group ? 'g:' + b.group : 'b:' + b.id; };
    var rectOf = function (b) { return b.group ? gs[b.group] : cardRect(b.id); };
    S.st.blocks.forEach(function (b) {
      var pb = b.parent && S.byId[b.parent];
      if (!pb || !wires[b.id]) return;
      var kp = keyOf(pb), kc = keyOf(b);
      if (kp === kc) return;
      var e = links[kp + '>' + kc] || (links[kp + '>' + kc] = { ra: rectOf(pb), rb: rectOf(b), kids: [] });
      e.kids.push(b.id);
    });
    return Object.keys(links).map(function (k) {
      var e = links[k], on = e.kids.filter(function (id) { return S.unmuted[id]; }), best = null;
      (on.length ? on : e.kids).forEach(function (id) {
        var w = wires[id], pts = w.pts && e.ra && e.rb ? trunk(w.pts, e.ra, e.rb) : null;
        var len = pts ? pathLen(pts) + (crosses(pts, labels) ? 1e6 : 0) : Infinity;
        if (!best || len < best.len) best = { d: pts ? rounded(pts) : w.d, color: w.color, len: len };
      });
      return { d: best.d, color: best.color, on: on.length > 0 };
    });
  }

  function inside(p, r) { return p[0] > r.x && p[0] < r.x + r.w && p[1] > r.y && p[1] < r.y + r.h; }
  // where the straight step a -> b crosses r's border, with one end inside r
  function crossing(a, b, r) {
    var out = inside(a, r);
    if (a[1] === b[1]) return [(b[0] > a[0]) === out ? r.x + r.w : r.x, a[1]];
    return [a[0], (b[1] > a[1]) === out ? r.y + r.h : r.y];
  }
  // the part of a wire between leaving rect ra for the last time and first entering rb
  function trunk(pts, ra, rb) {
    var n = pts.length, lastA = -1, firstB = n, i;
    for (i = 0; i < n; i++) if (inside(pts[i], ra)) lastA = i;
    if (lastA >= n - 1) return null;
    for (i = lastA + 1; i < n; i++) if (inside(pts[i], rb)) { firstB = i; break; }
    var out = [lastA >= 0 ? crossing(pts[lastA], pts[lastA + 1], ra) : pts[0]];
    for (i = lastA + 1; i < firstB; i++) out.push(pts[i]);
    if (firstB < n) out.push(crossing(pts[firstB - 1], pts[firstB], rb));
    var clean = [out[0]];
    for (i = 1; i < out.length; i++) {
      var q = clean[clean.length - 1];
      if (out[i][0] !== q[0] || out[i][1] !== q[1]) clean.push(out[i]);
    }
    return clean.length > 1 ? simplify(clean) : null;
  }
  function crosses(pts, rects) {
    for (var i = 1; i < pts.length; i++) {
      var x0 = Math.min(pts[i - 1][0], pts[i][0]), x1 = Math.max(pts[i - 1][0], pts[i][0]);
      var y0 = Math.min(pts[i - 1][1], pts[i][1]), y1 = Math.max(pts[i - 1][1], pts[i][1]);
      for (var j = 0; j < rects.length; j++) {
        var r = rects[j];
        if (x1 > r.x && x0 < r.x + r.w && y1 > r.y && y0 < r.y + r.h) return true;
      }
    }
    return false;
  }
  function pathLen(pts) {
    var len = 0;
    for (var i = 1; i < pts.length; i++) len += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
    return len;
  }

  function paintWires() {
    if (!S.st) return;
    var base = '', live = '';
    var list = S.far ? farLinks() : Object.keys(wires).map(function (k) {
      return { d: wires[k].d, color: wires[k].color, on: !!S.unmuted[k] };
    });
    list.forEach(function (w) {
      if (!w.d) return;
      var hex = hexOf(w.color), on = w.on;
      if (on) live += '<path class="wl" stroke="' + hex + '" d="' + w.d + '"/><path class="flow" d="' + w.d + '"/>';
      else base += '<path stroke="' + rgba(hex, 0.5) + '" d="' + w.d + '"/>';
    });
    // size the layer to the world, so nothing relies on painting outside it
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    Object.keys(S.pos).forEach(function (id) {
      var q = S.pos[id];
      x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x + CARD_W); y1 = Math.max(y1, q.y + CARD_H);
    });
    var svg = $('wires');
    if (x0 <= x1) {
      x0 -= 400; y0 -= 400; x1 += 400; y1 += 400;
      svg.setAttribute('viewBox', x0 + ' ' + y0 + ' ' + (x1 - x0) + ' ' + (y1 - y0));
      svg.style.left = x0 + 'px'; svg.style.top = y0 + 'px';
      svg.style.width = (x1 - x0) + 'px'; svg.style.height = (y1 - y0) + 'px';
    }
    svg.innerHTML = base + live;
  }

  /* ---------- moving cards smoothly ---------- */

  var tweens = {}, tweenRaf = 0;
  function tweenTo(id, to, dur) {
    var p = S.pos[id];
    if (!p) return;
    tweens[id] = { fx: p.x, fy: p.y, tx: to.x, ty: to.y, t0: performance.now(), dur: dur || 340 };
    if (!tweenRaf) tweenRaf = requestAnimationFrame(stepTweens);
  }
  function stepTweens(now) {
    tweenRaf = 0;
    var moving = {}, count = 0, any = false;
    Object.keys(tweens).forEach(function (id) {
      var tw = tweens[id], p = S.pos[id];
      if (!p) { delete tweens[id]; return; }
      var k = Math.min(1, (now - tw.t0) / tw.dur), e = ease(k);
      p.x = tw.fx + (tw.tx - tw.fx) * e;
      p.y = tw.fy + (tw.ty - tw.fy) * e;
      placeEl(id);
      moving[id] = true; count++;
      if (k >= 1) delete tweens[id];
      else any = true;
    });
    if (count) { positionBoxes(); routeAround(moving); }
    if (any) tweenRaf = requestAnimationFrame(stepTweens);
    else routeSoon();
  }

  /* ---------- the view ---------- */

  var viewRaf = 0;
  function applyView() {
    if (viewRaf) return;
    viewRaf = requestAnimationFrame(function () {
      viewRaf = 0;
      var z = S.view.z;
      $('world').style.transform = 'translate(' + S.view.x + 'px,' + S.view.y + 'px) scale(' + z + ')';
      var cv = $('canvas'), gs = 40 * z;
      cv.style.backgroundSize = gs + 'px ' + gs + 'px';
      cv.style.backgroundPosition = S.view.x + 'px ' + S.view.y + 'px';
      $('world').style.setProperty('--hs', Math.min(2, Math.max(1, 0.55 / z)).toFixed(3));
      $('world').style.setProperty('--iz', (1 / z).toFixed(4));
      var far = z < (S.far ? 0.5 : 0.45);
      if (far !== S.far) {
        S.far = far;
        cv.classList.toggle('far', far);
        paintWires();
        if (far) Object.keys(S.unmuted).forEach(drawThumb);   // tiles show still waves
      }
    });
  }
  var saveTimer = 0;
  function saveView() { clearTimeout(saveTimer); saveTimer = setTimeout(function () { lsSet(VIEW_KEY, JSON.stringify(S.view)); }, 300); }

  var anim = null;
  function stopAnim() { if (anim) { cancelAnimationFrame(anim.raf); anim = null; } }
  function animateView(to, dur) {
    stopAnim();
    var from = { x: S.view.x, y: S.view.y, z: S.view.z }, t0 = performance.now();
    anim = { raf: 0 };
    var step = function (now) {
      var k = Math.min(1, (now - t0) / dur), e = easeInOut(k);
      S.view.z = Math.exp(Math.log(from.z) + (Math.log(to.z) - Math.log(from.z)) * e);
      S.view.x = from.x + (to.x - from.x) * e;
      S.view.y = from.y + (to.y - from.y) * e;
      applyView();
      if (k < 1) anim.raf = requestAnimationFrame(step);
      else { anim = null; saveView(); }
    };
    anim.raf = requestAnimationFrame(step);
  }

  function zoomAt(cx, cy, f) {
    stopAnim();
    var r = $('canvas').getBoundingClientRect();
    var mx = cx - r.left, my = cy - r.top;
    var z2 = Math.min(Z_MAX, Math.max(Z_MIN, S.view.z * f));
    S.view.x = mx - (mx - S.view.x) * (z2 / S.view.z);
    S.view.y = my - (my - S.view.y) * (z2 / S.view.z);
    S.view.z = z2;
    applyView();
    saveView();
  }

  function wide() { return window.matchMedia('(min-width: 1000px)').matches; }
  function sideWidth() { return Math.min(560, window.innerWidth * 0.46); }

  function viewFor(list, maxZ, width) {
    var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    list.forEach(function (b) {
      var p = cellXY(b.col, b.row);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x + CARD_W);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y + CARD_H);
    });
    x0 -= 50; x1 += 50; y0 -= 120; y1 += 80;
    var r = $('canvas').getBoundingClientRect(), w = width || r.width;
    var z = Math.min(maxZ || 1, Math.max(Z_MIN, Math.min(w / (x1 - x0), r.height / (y1 - y0))));
    return { z: z, x: (w - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z };
  }
  function fitViewTo(list, animate) {
    if (!list || !list.length) return;
    var v = viewFor(list);
    if (animate) animateView(v, 520);
    else { S.view = v; applyView(); saveView(); }
  }
  function fitView(animate) { if (S.st) fitViewTo(S.st.blocks, animate); }

  function focusBlock(id, animate) {
    var b = S.byId[id];
    if (!b) return;
    var v = viewFor([b], 1);
    if (animate) animateView(v, 520);
    else { S.view = v; applyView(); }
  }

  // keep a card in sight, e.g. when the editor opens beside it
  function revealBlock(id) {
    var p = S.pos[id];
    if (!p) return;
    var r = $('canvas').getBoundingClientRect();
    var z = S.view.z;
    var sx = S.view.x + p.x * z, sy = S.view.y + p.y * z, sw = CARD_W * z, sh = CARD_H * z;
    var m = 40, dx = 0, dy = 0;
    if (sx < m) dx = m - sx; else if (sx + sw > r.width - m) dx = r.width - m - sx - sw;
    if (sy < m) dy = m - sy; else if (sy + sh > r.height - m) dy = r.height - m - sy - sh;
    if (dx || dy) animateView({ x: S.view.x + dx, y: S.view.y + dy, z: z }, 380);
  }

  /* ---------- pointer: pan, pinch, drag ---------- */

  var pointers = new Map();
  var gesture = null;
  var glide = null;

  function pinchInit() {
    if (gesture && gesture.moved) settleDrag(gesture, false);
    var pts = Array.from(pointers.values());
    gesture = {
      type: 'pinch',
      d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
      cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2,
      view0: { x: S.view.x, y: S.view.y, z: S.view.z },
    };
  }

  function onCardPointerDown(e) {
    if (e.button > 0 || e.target.closest('button')) return;
    var id = e.currentTarget.dataset.id;
    e.stopPropagation();
    stopAnim(); stopGlide();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    $('canvas').setPointerCapture(e.pointerId);
    if (pointers.size === 2) { pinchInit(); return; }
    var p = S.pos[id] || { x: 0, y: 0 }, b = S.byId[id];
    // a card of your own box carries the whole box; a loose card of yours moves alone
    var mine = S.mine[id], boxed = mine && b && b.group && groupIsMine(b.group);
    gesture = {
      type: boxed ? 'box' : mine ? 'card' : 'pan', id: id, name: boxed ? b.group : null, pid: e.pointerId,
      x0: e.clientX, y0: e.clientY, view0: { x: S.view.x, y: S.view.y },
      px: p.x, py: p.y, moved: false, clickId: id, track: [],
    };
  }

  // your own box moves as one: grab one of its cards, its name, or the space round its cards
  function onBoxPointerDown(e) {
    var name = e.currentTarget.dataset.name;
    if (e.button > 0 || e.target.closest('.gplay') || !groupIsMine(name)) return;
    e.stopPropagation();
    stopAnim(); stopGlide();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // the name stays a plain button (a tap opens the box) until the pointer moves
    if (!e.target.closest('.gname')) $('canvas').setPointerCapture(e.pointerId);
    if (pointers.size === 2) { pinchInit(); return; }
    gesture = { type: 'box', name: name, pid: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, track: [] };
  }

  function onCanvasPointerDown(e) {
    if (e.button > 0 || e.target.closest('button') || e.target.closest('.banner')) return;
    stopAnim(); stopGlide();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    $('canvas').setPointerCapture(e.pointerId);
    if (pointers.size === 2) { pinchInit(); return; }
    gesture = { type: 'pan', x0: e.clientX, y0: e.clientY, view0: { x: S.view.x, y: S.view.y }, moved: false, clickId: null, track: [] };
    $('canvas').classList.add('panning');
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;

    if (gesture.type === 'pinch') {
      if (pointers.size < 2) return;
      var pts = Array.from(pointers.values());
      var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      var cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
      var z2 = Math.min(Z_MAX, Math.max(Z_MIN, gesture.view0.z * d / gesture.d0));
      var r = $('canvas').getBoundingClientRect();
      var mx = gesture.cx - r.left, my = gesture.cy - r.top;
      S.view.x = mx - (mx - gesture.view0.x) * (z2 / gesture.view0.z) + (cx - gesture.cx);
      S.view.y = my - (my - gesture.view0.y) * (z2 / gesture.view0.z) + (cy - gesture.cy);
      S.view.z = z2;
      applyView();
      return;
    }

    var dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0;
    if (!gesture.moved && Math.hypot(dx, dy) > 5) {
      gesture.moved = true;
      if (gesture.type === 'card') startDrag(gesture.id);
      if (gesture.type === 'box' && !startBoxDrag(gesture)) { gesture = null; return; }
    }
    gesture.track.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (gesture.track.length > 6) gesture.track.shift();

    if (gesture.type === 'pan') {
      S.view.x = gesture.view0.x + dx;
      S.view.y = gesture.view0.y + dy;
      applyView();
      return;
    }
    if (gesture.type === 'card' && gesture.moved) {
      gesture.dx = dx; gesture.dy = dy;
      if (!gesture.raf) {
        var gg = gesture;
        gg.raf = requestAnimationFrame(function () {
          gg.raf = 0;
          if (gesture !== gg) return;
          var p = S.pos[gg.id];
          p.x = gg.px + gg.dx / S.view.z;
          p.y = gg.py + gg.dy / S.view.z;
          placeEl(gg.id);
          moveGhost(gg.id);
          positionBoxes();
          var ids = {}; ids[gg.id] = true;
          routeAround(ids);
        });
      }
    }
    if (gesture.type === 'box' && gesture.moved) {
      gesture.dx = dx; gesture.dy = dy;
      if (!gesture.raf) {
        var gb = gesture;
        gb.raf = requestAnimationFrame(function () {
          gb.raf = 0;
          if (gesture !== gb) return;
          Object.keys(gb.start).forEach(function (id) {
            var p = S.pos[id];
            if (!p) return;
            p.x = gb.start[id].x + gb.dx / S.view.z;
            p.y = gb.start[id].y + gb.dy / S.view.z;
            placeEl(id);
          });
          moveBoxGhost(gb);
          positionBoxes();
          routeAround(gb.start);
        });
      }
    }
  }

  function startBoxDrag(g) {
    var gr = findGroup(g.name);
    if (!gr) return false;
    try { $('canvas').setPointerCapture(g.pid); } catch (err) {}
    $('canvas').classList.add('panning');
    S.dragBox = g.name;
    g.start = {};
    var c0 = 1e9, c1 = -1e9, r0 = 1e9, r1 = -1e9;
    gr.blocks.forEach(function (b) {
      delete tweens[b.id];
      var p = S.pos[b.id];
      if (p) g.start[b.id] = { x: p.x, y: p.y };
      if (blockEls[b.id]) blockEls[b.id].classList.add('dragging');
      c0 = Math.min(c0, b.col); c1 = Math.max(c1, b.col); r0 = Math.min(r0, b.row); r1 = Math.max(r1, b.row);
    });
    g.c0 = c0; g.r0 = r0;
    var gh = $('ghost');
    gh.dataset.cell = '';
    gh.style.width = (c1 - c0) * CW + CARD_W + 'px';
    gh.style.height = (r1 - r0) * CH + CARD_H + 'px';
    moveBoxGhost(g);
    gh.classList.add('on');
    return true;
  }

  function boxLanding(g) {
    return boxShift(S.st.blocks, g.name, Math.round((g.dx || 0) / S.view.z / CW), Math.round((g.dy || 0) / S.view.z / CH));
  }

  function moveBoxGhost(g) {
    var s = boxLanding(g), gh = $('ghost');
    if (!s) return;
    var key = s.dc + ':' + s.dr;
    if (gh.dataset.cell === key) return;
    gh.dataset.cell = key;
    gh.style.transform = 'translate(' + (g.c0 + s.dc) * CW + 'px,' + (g.r0 + s.dr) * CH + 'px)';
  }

  // put a dragged card or box down: where it was dropped (keep), or back where it was
  function settleDrag(g, keep) {
    if (g.raf) cancelAnimationFrame(g.raf);
    $('ghost').classList.remove('on');
    if (g.type === 'card') {
      var b = S.byId[g.id], p = S.pos[g.id];
      if (keep && p && g.dx !== undefined) { p.x = g.px + g.dx / S.view.z; p.y = g.py + g.dy / S.view.z; }
      var c = (keep && landingCell(g.id)) || (b ? { col: b.col, row: b.row } : null);
      S.dragging = null;
      if (blockEls[g.id]) blockEls[g.id].classList.remove('dragging');
      if (!b || !c) return;
      tweenTo(g.id, cellXY(c.col, c.row), 260);
      if (c.col === b.col && c.row === b.row) return;
      b.col = c.col; b.row = c.row;
      commit({ op: 'update', id: g.id, col: c.col, row: c.row }, { quiet: true });
      return;
    }
    if (g.type !== 'box') return;
    var shift = keep ? boxLanding(g) : null;
    var moved = !!shift && (shift.dc !== 0 || shift.dr !== 0);
    S.dragBox = null;
    S.st.blocks.forEach(function (b) {
      if (b.group !== g.name) return;
      if (blockEls[b.id]) blockEls[b.id].classList.remove('dragging');
      if (moved) { b.col += shift.dc; b.row += shift.dr; }
      tweenTo(b.id, cellXY(b.col, b.row), 260);
    });
    if (moved) commit({ op: 'move', group: g.name, dc: shift.dc, dr: shift.dr }, { quiet: true });
  }

  function startDrag(id) {
    S.dragging = id;
    var el = blockEls[id];
    if (el) el.classList.add('dragging');
    delete tweens[id];
    var gh = $('ghost');
    gh.dataset.cell = '';
    gh.style.width = gh.style.height = '';
    moveGhost(id);
    gh.classList.add('on');
  }

  function landingCell(id) {
    var b = S.byId[id], p = S.pos[id];
    if (!b || !p) return null;
    return placeBlock(S.st.blocks, b.group, Math.round(p.x / CW), Math.round(p.y / CH), id);
  }

  function moveGhost(id) {
    var c = landingCell(id), gh = $('ghost');
    if (!c) return;
    var key = c.col + ':' + c.row;
    if (gh.dataset.cell === key) return;
    gh.dataset.cell = key;
    gh.style.transform = 'translate(' + c.col * CW + 'px,' + c.row * CH + 'px)';
  }

  function stopGlide() { if (glide) { cancelAnimationFrame(glide); glide = null; } }
  function startGlide(track) {
    if (track.length < 2) return;
    var a = track[0], z = track[track.length - 1], dt = z.t - a.t;
    if (dt <= 0 || performance.now() - z.t > 60) return;
    var vx = (z.x - a.x) / dt * 16, vy = (z.y - a.y) / dt * 16;
    if (Math.hypot(vx, vy) < 2) return;
    var step = function () {
      vx *= 0.92; vy *= 0.92;
      S.view.x += vx; S.view.y += vy;
      applyView();
      if (Math.hypot(vx, vy) > 0.3) glide = requestAnimationFrame(step);
      else { glide = null; saveView(); }
    };
    glide = requestAnimationFrame(step);
  }

  function onPointerUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    $('canvas').classList.remove('panning');
    var g = gesture;
    gesture = null;
    if (pointers.size === 1) {
      var rest = Array.from(pointers.values())[0];
      gesture = { type: 'pan', x0: rest.x, y0: rest.y, view0: { x: S.view.x, y: S.view.y }, moved: true, clickId: null, track: [] };
      return;
    }
    if (!g || g.type === 'pinch') { if (g) tourEvent('zoom'); saveView(); return; }

    if (g.type === 'pan') {
      saveView();
      if (!g.moved && g.clickId) openBlock(g.clickId);
      else if (g.moved && e.type === 'pointerup') startGlide(g.track);
      if (g.moved) tourEvent('pan');
      return;
    }

    if (g.moved) settleDrag(g, true);
    else if (g.clickId) openBlock(g.clickId);
  }

  /* ---------- editor ---------- */

  function forkTemplate(parentName) {
    return '# inp is the wave of "' + parentName + '"\nout = inp\n';
  }

  function edEls() {
    return {
      title: $('edTitle'), sub: $('edSub'), name: $('edName'), author: $('edAuthor'), group: $('edGroup'),
      beats: $('edBeats'), code: $('edCode'), colors: $('edColors'), out: $('edOut'), wave: $('edWave'),
      run: $('edRun'), save: $('edSave'), fork: $('edFork'), del: $('edDelete'), stat: $('edStat'),
    };
  }

  function updateGroupDatalist() {
    var dl = $('groupList');
    dl.innerHTML = '';
    groupsOf().forEach(function (g) {
      if (!g.name || !groupIsMine(g.name)) return;
      var o = document.createElement('option');
      o.value = g.name;
      dl.appendChild(o);
    });
  }

  function fillColors(selected) {
    var wrap = $('edColors');
    wrap.innerHTML = '';
    var pick = function (c) {
      S.ed.color = c;
      wrap.querySelectorAll('.sw').forEach(function (x) { x.classList.toggle('on', x.dataset.c === c || (x.classList.contains('custom') && c[0] === '#')); });
    };
    (S.st.colors || Object.keys(PALETTE)).forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sw' + (c === selected ? ' on' : '');
      b.style.background = hexOf(c);
      b.title = c;
      b.dataset.c = c;
      b.addEventListener('click', function () { if (S.ed && S.ed.mode !== 'view') pick(c); });
      wrap.appendChild(b);
    });
    // any colour: the last swatch opens a picker
    var custom = document.createElement('label');
    var isHex = /^#[0-9a-f]{6}$/i.test(selected || '');
    custom.className = 'sw custom' + (isHex ? ' on' : '');
    custom.title = 'any colour';
    custom.style.background = isHex ? selected : '';
    custom.innerHTML = '<input type="color" aria-label="any colour">';
    var input = custom.querySelector('input');
    input.value = isHex ? selected : '#5b7cfa';
    input.addEventListener('input', function () {
      if (!S.ed || S.ed.mode === 'view') return;
      var c = lift(input.value.toLowerCase());
      custom.style.background = c;
      pick(c);
    });
    wrap.appendChild(custom);
  }

  function fillBeats(sel, value) {
    sel.innerHTML = '';
    (S.st.beatsAllowed || [1, 2, 4, 8, 16, 32, 64, 128]).forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v + (v === 1 ? ' beat' : ' beats');
      if (v === value) o.selected = true;
      sel.appendChild(o);
    });
  }

  function openFork(parentId) {
    var p = S.byId[parentId];
    if (!p) return;
    stopEditorPreview();
    S.ed = { mode: 'new', id: null, parentId: parentId, color: p.color, busy: false, confirmDelete: false };
    var E = edEls();
    var author = lsGet(AUTHOR_KEY) || '';
    E.title.textContent = 'new fork of “' + p.name + '”';
    E.sub.textContent = 'it goes in your own box';
    E.name.value = '';
    E.name.placeholder = 'untitled';
    E.author.value = author;
    E.group.value = defaultGroup(p, author || 'anonymous');
    fillBeats(E.beats, p.beats);
    fillColors(p.color);
    E.code.value = forkTemplate(p.name);
    renderEditorChrome();
    resetEditorOutput();
    showEditor(parentId);
    tourEvent('fork');
  }

  function openBlock(id) {
    var b = S.byId[id];
    if (!b) return;
    stopEditorPreview();
    var mode = S.mine[id] ? 'edit' : 'view';
    S.ed = { mode: mode, id: id, parentId: b.parent, color: b.color, busy: false, confirmDelete: false };
    var E = edEls();
    var p = b.parent ? S.byId[b.parent] : null;
    E.title.textContent = b.name;
    E.sub.textContent = (p ? 'from ' + p.name + ' · ' : '') + 'by ' + b.author + ' · ' + ago(b.updatedAt);
    E.name.value = b.name;
    E.author.value = b.author;
    E.group.value = b.group || '';
    fillBeats(E.beats, b.beats);
    fillColors(b.color);
    E.code.value = b.code;
    renderEditorChrome();
    resetEditorOutput();
    showEditor(id);
    tourEvent('block');
  }

  function renderEditorChrome() {
    var E = edEls(), ed = S.ed;
    var editable = ed.mode !== 'view';
    E.name.disabled = !editable;
    E.author.disabled = !editable;
    E.group.disabled = !editable;
    E.beats.disabled = !editable;
    E.colors.querySelectorAll('.sw').forEach(function (x) { x.disabled = !editable; });
    E.colors.querySelectorAll('input').forEach(function (x) { x.disabled = !editable; });
    E.code.readOnly = !editable;
    E.save.hidden = !editable;
    E.save.disabled = ed.busy;
    E.save.textContent = ed.busy ? 'saving…' : (ed.mode === 'new' ? 'add it' : 'save');
    E.del.hidden = ed.mode !== 'edit';
    E.del.textContent = ed.confirmDelete ? 'sure?' : 'delete';
    E.fork.hidden = ed.mode === 'new';
    E.run.textContent = ed.previewing ? '■ stop' : '▶ try';
    E.run.classList.toggle('on', !!ed.previewing);
    E.stat.textContent = ed.mode === 'view' ? 'not yours: fork it to change it' : '';
  }

  function resetEditorOutput() {
    var E = edEls();
    E.out.hidden = true;
    E.wave.hidden = true;
  }

  function updateGutter() {
    var lines = $('edCode').value.split('\n').length, h = '';
    for (var i = 1; i <= lines; i++) h += i + '\n';
    $('edGutter').textContent = h;
    $('edGutter').scrollTop = $('edCode').scrollTop;
  }

  function showEditor(focusId) {
    var isBox = S.ed && S.ed.mode === 'box';
    $('editor').hidden = isBox;
    $('boxPanel').hidden = !isBox;
    var wasOpen = $('work').classList.contains('editing');
    $('work').classList.add('editing');
    updateGutter();
    $('edCode').scrollTop = 0;
    $('editor').scrollTop = 0;
    document.querySelectorAll('.block.sel').forEach(function (x) { x.classList.remove('sel'); });
    if (focusId && blockEls[focusId]) blockEls[focusId].classList.add('sel');
    if (window.matchMedia('(max-width: 999px)').matches) {
      $('side').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (focusId) {
      setTimeout(function () { revealBlock(focusId); }, wasOpen ? 0 : 360);
    }
  }

  function closeEditor() {
    stopEditorPreview();
    S.ed = null;
    $('work').classList.remove('editing');
    document.querySelectorAll('.block.sel').forEach(function (x) { x.classList.remove('sel'); });
  }

  function stopEditorPreview() {
    SN.audio.stopPreview();
    if (S.ed) S.ed.previewing = false;
  }

  function runEditor() {
    var ed = S.ed;
    if (!ed || ed.mode === 'box') return;
    var E = edEls();
    if (ed.previewing) { stopEditorPreview(); renderEditorChrome(); return; }
    var draft = {
      parentId: ed.mode === 'new' ? ed.parentId : (S.byId[ed.id] ? S.byId[ed.id].parent : null),
      beats: parseInt(E.beats.value, 10) || 16,
      code: E.code.value,
    };
    E.stat.textContent = SN.engine.status() === 'ready' ? 'rendering…' : 'starting Python…';
    E.out.hidden = true;
    SN.engine.requestDraft(draft, function (res) {
      if (!S.ed) return;
      var E2 = edEls();
      if (res.error) {
        E2.stat.textContent = '';
        E2.out.textContent = (res.stdout ? res.stdout + '\n' : '') + res.error;
        E2.out.className = 'edout err';
        E2.out.hidden = false;
        return;
      }
      S.ed.previewing = true;
      renderEditorChrome();
      if (res.stdout) {
        E2.out.textContent = res.stdout;
        E2.out.className = 'edout';
        E2.out.hidden = false;
      }
      var wv = E2.wave;
      wv.hidden = false;
      wv.width = wv.clientWidth * 2;
      drawWave(wv, res.buf, hexOf(S.ed.color));
      E2.stat.textContent = res.dur.toFixed(1) + ' s loop';
      SN.audio.preview(res.buf, S.st.sr);
    });
  }

  function saveEditor() {
    var ed = S.ed;
    if (ed && ed.mode === 'box') { saveBox(); return; }
    if (!ed || ed.busy || ed.mode === 'view') return;
    var E = edEls();
    var body = {
      name: E.name.value.trim() || 'untitled',
      author: E.author.value.trim() || 'anonymous',
      group: E.group.value.replace(/\s+/g, ' ').trim(),
      color: ed.color || 'orange',
      beats: parseInt(E.beats.value, 10) || 16,
      code: E.code.value,
    };
    if (ed.mode === 'new') { body.op = 'fork'; body.parent = ed.parentId; }
    else { body.op = 'update'; body.id = ed.id; }
    if (E.author.value.trim()) lsSet(AUTHOR_KEY, E.author.value.trim());
    ed.busy = true;
    renderEditorChrome();
    commit(body, {
      done: function (res) {
        if (!S.ed) return;
        S.ed.busy = false;
        if (!res) { renderEditorChrome(); return; }
        stopEditorPreview();
        if (body.op === 'fork' && res.blockId) {
          S.mine[res.blockId] = true;
          paintCard(res.blockId);
          setMuted(res.blockId, false);
          updateGroupDatalist();
          banner('Added', 'It’s in your box.', true);
          openBlock(res.blockId);
        } else {
          banner('Saved', '', true);
          if (S.byId[ed.id]) openBlock(ed.id);
        }
      },
    });
  }

  function deleteEditor() {
    var ed = S.ed;
    if (!ed || ed.mode !== 'edit' || ed.busy) return;
    if (!ed.confirmDelete) { ed.confirmDelete = true; renderEditorChrome(); return; }
    ed.busy = true;
    renderEditorChrome();
    commit({ op: 'delete', id: ed.id }, {
      done: function (res) {
        if (!S.ed) return;
        S.ed.busy = false;
        S.ed.confirmDelete = false;
        if (res) { delete S.mine[ed.id]; closeEditor(); banner('Deleted', '', true); }
        else renderEditorChrome();
      },
    });
  }

  /* ---------- a box: its note and its blocks ---------- */

  function boxAbout(name) { return (S.st.boxes && S.st.boxes[name] && S.st.boxes[name].about) || ''; }

  function openBox(name) {
    var g = findGroup(name);
    if (!g) return;
    stopEditorPreview();
    S.ed = { mode: 'box', group: name, busy: false };
    var mine = groupIsMine(name), about = boxAbout(name);
    $('bxTitle').textContent = name;
    $('bxAbout').textContent = about || 'No note yet.';
    $('bxAbout').classList.toggle('none', !about);
    $('bxAbout').hidden = mine;
    $('bxEdit').hidden = !mine;
    $('bxSave').hidden = !mine;
    $('bxEdit').value = about;
    renderBoxPanel();
    showEditor(null);
    tourEvent('box');
  }

  function renderBoxPanel() {
    if (!S.ed || S.ed.mode !== 'box') return;
    var g = findGroup(S.ed.group);
    if (!g) { closeEditor(); return; }
    var first = groupFirst(g.blocks, g.name);
    $('bxSub').textContent = 'by ' + first.author + ' \u00b7 ' + g.blocks.length + (g.blocks.length === 1 ? ' block' : ' blocks');
    if ($('bxEdit').hidden) {
      var about = boxAbout(g.name);
      $('bxAbout').textContent = about || 'No note yet.';
      $('bxAbout').classList.toggle('none', !about);
    }
    var on = g.blocks.filter(function (b) { return S.unmuted[b.id]; }).length;
    $('bxPlay').textContent = on ? '\u275a\u275a stop' : '\u25b6 play';
    $('bxSave').disabled = S.ed.busy;
    var ol = $('bxList');
    ol.innerHTML = '';
    g.blocks.slice().sort(function (a, b) { return a.row - b.row || a.col - b.col; }).forEach(function (b) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="dot" style="background:' + hexOf(b.color) + '"></span><button type="button"></button><span class="st"></span>';
      li.querySelector('button').textContent = b.name;
      li.querySelector('.st').textContent = S.unmuted[b.id] ? 'playing' : b.beats + (b.beats === 1 ? ' beat' : ' beats');
      li.querySelector('button').addEventListener('click', function () { openBlock(b.id); });
      ol.appendChild(li);
    });
  }

  function saveBox() {
    var ed = S.ed;
    if (!ed || ed.mode !== 'box' || ed.busy || !groupIsMine(ed.group)) return;
    ed.busy = true;
    renderBoxPanel();
    commit({ op: 'describe', group: ed.group, about: $('bxEdit').value }, {
      done: function (res) {
        if (!S.ed || S.ed.mode !== 'box') return;
        S.ed.busy = false;
        renderBoxPanel();
        if (res) banner('Saved', '', true);
      },
    });
  }

  /* ---------- commits ---------- */

  var WHY = {
    full: ['The page is full', ''],
    'device-full': ['Too many blocks', 'Delete one of yours first.'],
    'has-forks': ['Someone forked it', 'So it stays. You can still change it.'],
    'not-yours': ['Not yours', 'Fork it instead.'],
    'no-such-block': ['It’s gone', 'Someone deleted it.'],
    'group-taken': ['That box is someone else’s', 'Pick another name, or use your own.'],
    'ip-rate': ['Too many new blocks from here', 'Try again later.'],
    crowded: ['No room there', ''],
    'name-taken': ['That name is taken', 'Pick another.'],
    'no-such-box': ['That box is gone', ''],
  };

  function commit(body, opts) {
    opts = opts || {};
    body.nonce = newNonce();
    pollMs = POLL_MIN;
    api('/api/sine-edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) {
        if (res.status === 200) {
          applyState(res.j.state);
          if (opts.done) opts.done(res.j);
          return;
        }
        var e = res.j.error;
        if (e === 'rate') banner('Too fast', 'Wait a few seconds.', true);
        else if (WHY[e]) banner(WHY[e][0], WHY[e][1], true);
        else banner('That didn’t go through', 'Try again.');
        refresh(true).catch(function () {});
        if (opts.done) opts.done(null);
      })
      .catch(function () {
        banner('Connection lost', 'Try again in a moment.');
        refresh(true).catch(function () {});
        if (opts.done) opts.done(null);
      });
  }

  /* ---------- ledger ---------- */

  function renderLedger(entries) {
    var ol = $('ledger');
    if (!entries || !entries.length) { ol.innerHTML = '<li class="empty">Nothing yet. Fork the sine.</li>'; return; }
    ol.innerHTML = '';
    entries.forEach(function (e) {
      var li = document.createElement('li');
      var who = '<b>' + esc(e.author) + '</b>' + (e.via === 'agent' ? ' (agent)' : '');
      var s;
      if (e.kind === 'fork') s = who + ' forked <b>' + esc(e.from) + '</b> into <b>' + esc(e.name) + '</b>';
      else if (e.kind === 'delete') s = who + ' deleted <b>' + esc(e.name) + '</b>';
      else s = who + ' changed <b>' + esc(e.name) + '</b>';
      li.innerHTML = '<span class="dot" style="background:' + hexOf(e.color) + '"></span><span>' + s + '</span><span class="ago">' + ago(e.at) + '</span>';
      ol.appendChild(li);
    });
  }

  /* ---------- polling ---------- */

  function refresh(force) {
    return api('/api/sine').then(function (r) { return r.json(); }).then(function (st) {
      if (S.offline) { S.offline = false; banner(null); }
      if (!S.st || force === true || st.version !== S.serverVersion) applyState(st);
      return st;
    });
  }

  function refreshMe() {
    return api('/api/sine-me').then(function (r) { return r.json(); }).then(function (m) {
      if (m.token) lsSet(TOKEN_KEY, m.token);
      (m.blocks || []).forEach(function (id) { S.mine[id] = true; });
      if (S.st) { S.st.blocks.forEach(function (b) { paintCard(b.id); }); renderGroupBoxes(); updateGroupDatalist(); }
      return m;
    }).catch(function () {});
  }

  function poll() {
    if (document.hidden) return;
    var before = S.serverVersion;
    refresh().then(function (st) {
      pollMs = st.version === before ? Math.min(POLL_MAX, Math.round(pollMs * 1.5)) : POLL_MIN;
      schedulePoll(pollMs);
    }).catch(function () {
      if (!S.st) offlineFallback();
      pollMs = Math.min(POLL_MAX, Math.round(pollMs * 1.5));
      schedulePoll(pollMs);
    });
  }
  function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }

  function offlineFallback() {
    var st = lsJson(CACHE_KEY);
    if (!st) { banner('Offline', 'The page could not be reached.'); return; }
    S.offline = true;
    applyState(st);
    banner('Offline', 'Showing the last version this browser saw.', true);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { pollMs = POLL_MIN; schedulePoll(0); }
    else clearTimeout(pollTimer);
  });

  /* ---------- engine wiring ---------- */

  var bootBanner = false;
  SN.engine.onStatus = function (s) {
    if (s === 'loading') {
      if (!bannerShown()) { banner('Loading Python', 'About 12 MB, once.', false); bootBanner = true; }
      return;
    }
    if (bootBanner) { banner(null); bootBanner = false; }
    if (s === 'ready' && S.st && S.st.blocks.length <= 40) {
      S.st.blocks.forEach(function (b) { SN.engine.request(b.id); });
    }
    if (s === 'failed') banner('Python didn’t load', 'Reload to try again.');
  };
  SN.engine.onRendered = function (id, buf) {
    if (!S.st) return;
    SN.audio.setBuffer(id, buf, S.st.sr);
    drawThumb(id);
    paintCard(id);
  };
  SN.engine.onError = function (id) { paintCard(id); drawThumb(id); };

  /* ---------- transport ---------- */

  function onScreen(id, r) {
    var p = S.pos[id];
    if (!p) return false;
    var z = S.view.z;
    var x = S.view.x + p.x * z, y = S.view.y + p.y * z;
    return x < r.width && y < r.height && x + CARD_W * z > 0 && y + CARD_H * z > 0;
  }

  function tick() {
    var r = $('canvas').getBoundingClientRect();
    var visible = r.bottom > 0 && r.top < window.innerHeight;
    Object.keys(S.unmuted).forEach(function (id) {
      var el = blockEls[id], b = S.byId[id];
      if (!el || !b) return;
      var p = SN.audio.progress(id);
      el.querySelector('.bprog').style.transform = 'scaleX(' + (p >= 0 ? p : 0) + ')';
      if (p < 0 || !visible || S.far || !onScreen(id, r)) return;
      var got = SN.engine.get(id);
      if (got) drawScope(el.querySelector('.wave'), got.buf, hexOf(b.color), got.dur, p);
    });
    if (SN.audio.isRunning()) rafId = requestAnimationFrame(tick);
  }

  function setListening(on) {
    var btn = $('listen');
    if (on) {
      SN.audio.start().then(function () {
        btn.textContent = '❚❚ Playing';
        btn.classList.add('playing');
        Object.keys(S.unmuted).forEach(paintCard);
        $('canvas').classList.add('flowing');
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(tick);
        if (!Object.keys(S.unmuted).length) banner('Everything is muted', 'Press play on a box.', true);
        else Object.keys(S.unmuted).forEach(function (id) { SN.engine.request(id); });
      }).catch(function () { banner('No audio', 'This browser would not play sound.'); });
    } else {
      SN.audio.stop();
      btn.textContent = '▶ Listen';
      btn.classList.remove('playing');
      Object.keys(S.unmuted).forEach(paintCard);
      $('canvas').classList.remove('flowing');
      cancelAnimationFrame(rafId);
      Object.keys(S.unmuted).forEach(function (id) {
        var el = blockEls[id];
        if (el) el.querySelector('.bprog').style.transform = 'scaleX(0)';
        drawThumb(id);
      });
    }
  }

  /* ---------- agents ---------- */

  var agentUrl = '';
  function loadAgentKey(rotate) {
    return api('/api/sine-key', { method: rotate ? 'POST' : 'GET' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (j) {
        agentUrl = j.url;
        $('mcpUrl').textContent = j.url;
        $('mcpCopy').disabled = false;
        renderSetup();
      })
      .catch(function () { $('mcpUrl').textContent = 'not available right now'; });
  }

  var setupOs = /Win/i.test(navigator.platform || '') ? 'win' : /Mac|iPhone|iPad/i.test(navigator.platform || '') ? 'mac' : 'linux';

  // the exact lines for each agent; the OS only matters where quoting or paths differ
  function setupSteps(agent, os, url) {
    var json = '{\n  "mcpServers": {\n    "sine": { "url": "' + url + '" }\n  }\n}';
    switch (agent) {
      case 'claude': return [['In a terminal:', 'claude mcp add --transport http sine ' + url]];
      case 'codex': return [['In a terminal:', 'codex mcp add sine --url ' + url]];
      case 'gemini': return [['In a terminal:', 'gemini mcp add -s user --transport http sine ' + url]];
      case 'cursor': return [
        ['Put this in ' + (os === 'win' ? '%USERPROFILE%\\.cursor\\mcp.json' : '~/.cursor/mcp.json') + ' (next to any servers already there), then restart Cursor:', json]];
      case 'vscode': return [[os === 'win' ? 'In Command Prompt:' : 'In a terminal:', os === 'win'
        ? 'code --add-mcp "{\\"name\\":\\"sine\\",\\"type\\":\\"http\\",\\"url\\":\\"' + url + '\\"}"'
        : "code --add-mcp '{\"name\":\"sine\",\"type\":\"http\",\"url\":\"" + url + "\"}'"]];
      default: return [['In Claude (desktop or web): Settings, Connectors, Add custom connector, and paste the address.', null]];
    }
  }

  function renderSetup() {
    var agent = $('setAgent').value;
    var osMatters = agent === 'cursor' || agent === 'vscode';
    $('setOs').hidden = !osMatters;
    $('setOs').querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.os === setupOs); });
    var url = agentUrl || 'YOUR_ADDRESS';
    var html = '';
    setupSteps(agent, setupOs, url).forEach(function (st, i) {
      html += '<div class="step">' + esc(st[0]) + '</div>';
      if (st[1]) html += '<div class="line"><pre>' + esc(st[1]) + '</pre><button class="btn soft" type="button" data-copy="' + i + '">copy</button></div>';
    });
    html += '<div class="step">Then ask your agent to make something for sine.</div>';
    var box = $('setSteps');
    box.innerHTML = html;
    box.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () { copyText(b.previousSibling.textContent, b); });
    });
  }

  function copyText(text, btn) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(text).then(function () {
      btn.textContent = 'copied';
      setTimeout(function () { btn.textContent = 'copy'; }, 1400);
    }, function () {});
  }

  /* ---------- the tour: once on a first visit, and again from "how it works" ---------- */
  // each step waits for you to do the thing, then moves on by itself

  var tour = { on: false, i: 0, raf: 0, target: null, done: false, must: false };
  var STEPS = [
    {
      text: 'This is the sine: one wave, at 110 Hz. Everything on this page is made from it.',
      wait: ['sine'],
      act: ['\u25b6 play it', playSine],
      at: function () {
        var r = rootId();
        if (!r) return null;
        focusBlock(r, true);
        return blockEls[r];
      },
    },
    {
      text: 'Fork it until it\u2019s a song: the boxes around it are songs made that way. Drag to move around, scroll or pinch to zoom.',
      wait: ['pan', 'zoom'],
      at: function () { return $('canvas'); },
    },
    {
      text: 'Lost? This button brings everything back into view.',
      wait: ['fit'],
      at: function () { return $('zoomFit'); },
    },
    {
      text: 'Press play on a box to hear its song.',
      wait: ['play'],
      at: function () {
        var g = tourGroup();
        if (!g) return null;
        fitViewTo(g.blocks, true);
        return boxEls[g.name] && boxEls[g.name].querySelector('.gplay');
      },
    },
    {
      text: 'Click a box’s name to read about it.',
      wait: ['box'],
      at: function () { var g = tourGroup(); return g && boxEls[g.name] && boxEls[g.name].querySelector('.gname'); },
    },
    {
      text: 'Every block is a few lines of Python that reshape the block it came from. Click one to read it.',
      wait: ['block'],
      at: function () { return tourCard(); },
    },
    {
      text: 'Fork it to make your own. It goes in your own box, and only you can change it.',
      wait: ['fork'],
      at: function () {
        var c = tourCard();          // the fork button on the block itself is always in sight
        return (c && c.querySelector('.fork')) || $('edFork');
      },
    },
    {
      text: 'Rather not code? Give this address to your coding agent.',
      wait: [],
      at: function () {
        $('agents').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return $('mcpUrl').parentNode;
      },
    },
  ];

  function isSineBox(g) { return !!g && g.blocks.some(function (b) { return !b.parent; }); }

  function rootId() {
    var r = S.st && S.st.blocks.filter(function (b) { return !b.parent; })[0];
    return r ? r.id : null;
  }

  // the first step's button: unmute the sine and start the transport (the click is the gesture audio needs)
  function playSine() {
    var r = rootId();
    if (!r) return;
    if (!S.unmuted[r]) setMuted(r, false);
    if (SN.audio.isRunning()) tourEvent('sine');
    else SN.audio.start().then(function () { setListening(true); tourEvent('sine'); });
  }

  function tourGroup() {
    return findGroup('fourier acid') || groupsOf().filter(function (x) { return x.name && !isSineBox(x); })[0] || null;
  }
  function tourCard() {
    var id = S.byId.b_00000006 ? 'b_00000006' : (S.st && S.st.blocks[1] && S.st.blocks[1].id);   // the acid line
    return id ? blockEls[id] : null;
  }

  // the rest of the page calls this when something happens
  function tourEvent(kind) {
    if (!tour.on || tour.done) return;
    var step = STEPS[tour.i];
    if (!step || step.wait.indexOf(kind) < 0) return;
    tour.done = true;
    // a song should be heard on its own, not over the bare sine
    if (kind === 'play') { var r = rootId(); if (r && S.unmuted[r]) setMuted(r, true); }
    $('tour').classList.add('ok');
    $('tourN').textContent = (tour.i + 1) + ' of ' + STEPS.length + ' ✓';
    var at = tour.i;
    setTimeout(function () { if (tour.on && tour.i === at) tourGo(at + 1); }, 700);
  }

  // the first time, the tour has to be finished (it comes back after a reload until it is)
  function startTour(firstTime) {
    if (!S.st) return;
    closeEditor();
    tour.on = true;
    tour.must = !!firstTime;
    $('tourSkip').hidden = tour.must;
    $('canvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(function () { tourGo(0); }, 300);
  }

  function endTour(finished) {
    if (tour.must && !finished) return;
    tour.on = false;
    tour.must = false;
    cancelAnimationFrame(tour.raf);
    $('ring').classList.remove('on');
    $('tour').classList.remove('on', 'ok', 'docked');
    lsSet(TOUR_KEY, String(Date.now()));
  }

  function tourGo(i) {
    if (i >= STEPS.length) { endTour(true); return; }
    tour.i = i;
    tour.done = false;
    var step = STEPS[i];
    $('tour').classList.remove('ok');
    $('tourN').textContent = (i + 1) + ' of ' + STEPS.length;
    $('tourText').textContent = step.text;
    $('tourNext').textContent = i === STEPS.length - 1 ? 'done' : step.wait.length ? 'skip this' : 'next';
    $('tourAct').hidden = !step.act;
    if (step.act) $('tourAct').textContent = step.act[0];
    tour.target = step.at();
    $('tour').classList.add('on');
    cancelAnimationFrame(tour.raf);
    var follow = function () {
      if (!tour.on) return;
      placeTour();
      tour.raf = requestAnimationFrame(follow);
    };
    follow();
  }

  // bring the current step's target back into sight
  function tourShow() {
    var step = STEPS[tour.i];
    if (!step) return;
    var t = step.at();
    if (t) tour.target = t;
    t = tour.target;
    if (!t) return;
    var cv = $('canvas');
    if (cv.contains(t) && t !== cv) {
      cv.scrollIntoView({ behavior: 'smooth', block: 'center' });
      var card = t.closest('.block'), box = t.closest('.gbox');
      if (card) revealBlock(card.dataset.id);
      else if (box) { var g = findGroup(box.dataset.name); if (g) fitViewTo(g.blocks, true); }
    } else {
      t.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // follow the target through pans, zooms and scrolls; the panel always stays on screen
  function placeTour() {
    var t = tour.target, ring = $('ring'), box = $('tour');
    var vw = window.innerWidth, vh = window.innerHeight;
    var bw = box.offsetWidth, bh = box.offsetHeight;
    var r = t && t.isConnected && !t.hidden ? t.getBoundingClientRect() : null;
    // what of the target can actually be seen: inside the window, and inside the canvas if it lives there
    var vis = null;
    if (r && r.width && r.height) {
      var x0 = Math.max(r.left, 0), y0 = Math.max(r.top, 0), x1 = Math.min(r.right, vw), y1 = Math.min(r.bottom, vh);
      if ($('canvas').contains(t) && t !== $('canvas')) {
        var c = $('canvas').getBoundingClientRect();
        x0 = Math.max(x0, c.left); y0 = Math.max(y0, c.top); x1 = Math.min(x1, c.right); y1 = Math.min(y1, c.bottom);
      }
      if (x1 - x0 > 8 && y1 - y0 > 8) vis = { left: x0, top: y0, right: x1, bottom: y1 };
    }
    var docked = !vis;
    // mostly out of sight still offers "show me"
    var partial = !!vis && (vis.right - vis.left) * (vis.bottom - vis.top) < 0.6 * r.width * r.height;
    box.classList.toggle('docked', docked);
    box.classList.toggle('partial', partial);
    if (docked) {
      ring.classList.remove('on');
      box.style.left = Math.round((vw - bw) / 2) + 'px';
      box.style.top = Math.round(vh - bh - 16) + 'px';
      return;
    }
    var m = 6;
    ring.classList.add('on');
    ring.style.transform = 'translate(' + (vis.left - m) + 'px,' + (vis.top - m) + 'px)';
    ring.style.width = (vis.right - vis.left + m * 2) + 'px';
    ring.style.height = (vis.bottom - vis.top + m * 2) + 'px';
    var top = vis.bottom + 16;
    if (top + bh > vh - 12) top = vis.top - bh - 16;
    if (top < 12) top = Math.min(vh - bh - 12, Math.max(12, vis.top + 16));   // big targets: sit inside them
    var left = Math.min(Math.max(12, vis.left), vw - bw - 12);
    box.style.left = Math.round(left) + 'px';
    box.style.top = Math.round(top) + 'px';
  }

  /* ---------- init ---------- */

  function init() {
    loadUnmuted();
    var m = /^#(b_[0-9a-f]{8})$/.exec(location.hash);
    if (m) { S.hash = m[1]; S.unmuted[m[1]] = true; }

    $('listen').addEventListener('click', function () { setListening(!SN.audio.isRunning()); });
    $('muteAll').addEventListener('click', function () {
      Object.keys(S.unmuted).forEach(function (id) { setMuted(id, true, true); });
      refreshWires(); renderGroupBoxes();
    });

    var cv = $('canvas');
    var overCanvas = false;
    cv.addEventListener('pointerenter', function () { overCanvas = true; });
    cv.addEventListener('pointerleave', function () { overCanvas = false; });
    cv.addEventListener('pointerdown', onCanvasPointerDown);
    cv.addEventListener('pointermove', onPointerMove);
    cv.addEventListener('pointerup', onPointerUp);
    cv.addEventListener('pointercancel', onPointerUp);
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      stopGlide();
      var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016)));
      tourEvent('zoom');
    }, { passive: false });

    var zoomBy = function (f) {
      var r = cv.getBoundingClientRect();
      var z2 = Math.min(Z_MAX, Math.max(Z_MIN, S.view.z * f));
      var mx = r.width / 2, my = r.height / 2;
      animateView({ x: mx - (mx - S.view.x) * (z2 / S.view.z), y: my - (my - S.view.y) * (z2 / S.view.z), z: z2 }, 260);
    };
    $('zoomIn').addEventListener('click', function () { zoomBy(1.4); tourEvent('zoom'); });
    $('zoomOut').addEventListener('click', function () { zoomBy(1 / 1.4); tourEvent('zoom'); });
    $('zoomFit').addEventListener('click', function () { fitView(true); tourEvent('fit'); });

    $('edRun').addEventListener('click', runEditor);
    $('edSave').addEventListener('click', saveEditor);
    $('edDelete').addEventListener('click', deleteEditor);
    $('edX').addEventListener('click', closeEditor);
    $('bxX').addEventListener('click', closeEditor);
    $('bxSave').addEventListener('click', saveBox);
    $('bxPlay').addEventListener('click', function () {
      var gg = S.ed && findGroup(S.ed.group);
      if (!gg) return;
      var turnOn = !gg.blocks.some(function (b) { return S.unmuted[b.id]; });
      gg.blocks.forEach(function (b) { setMuted(b.id, !turnOn, true); });
      refreshWires(); renderGroupBoxes(); renderBoxPanel();
      if (turnOn && !SN.audio.isRunning()) setListening(true);
      if (turnOn) tourEvent(isSineBox(gg) ? 'sine' : 'play');
    });
    $('edFork').addEventListener('click', function () { if (S.ed && S.ed.id) openFork(S.ed.id); });
    $('bannerClose').addEventListener('click', function () { banner(null); });
    $('edCode').addEventListener('input', updateGutter);
    $('edCode').addEventListener('scroll', function () { $('edGutter').scrollTop = $('edCode').scrollTop; });
    $('edCode').addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && !e.shiftKey && !e.target.readOnly) {
        e.preventDefault();
        var ta = e.target, s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '    ' + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 4;
        updateGutter();
      }
    });
    document.addEventListener('keydown', function (e) {
      var tag = document.activeElement && document.activeElement.tagName;
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
      if (e.key === 'Escape' && tour.on) endTour(false);
      else if (e.key === 'Escape' && S.ed) closeEditor();
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && S.ed) { e.preventDefault(); runEditor(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 's' && S.ed && S.ed.mode !== 'view') { e.preventDefault(); saveEditor(); }
      // space only toggles Listen with the pointer on the canvas; elsewhere it scrolls the page as usual
      else if (e.key === ' ' && !typing && tag !== 'BUTTON' && overCanvas) { e.preventDefault(); setListening(!SN.audio.isRunning()); }
    });

    $('mcpCopy').addEventListener('click', function () { copyText($('mcpUrl').textContent, $('mcpCopy')); });
    $('setAgent').addEventListener('change', renderSetup);
    $('setOs').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { setupOs = b.dataset.os; renderSetup(); });
    });
    renderSetup();
    $('mcpNew').addEventListener('click', function () {
      var b = $('mcpNew');
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'sure? the old one stops working'; return; }
      b.dataset.sure = '';
      b.textContent = 'new address';
      loadAgentKey(true);
    });

    $('tourAgain').addEventListener('click', function () { startTour(false); });
    $('tourNext').addEventListener('click', function () { tourGo(tour.i + 1); });
    $('tourShow').addEventListener('click', tourShow);
    $('tourAct').addEventListener('click', function () { var st = STEPS[tour.i]; if (st && st.act) st.act[1](); });
    $('tourSkip').addEventListener('click', function () { endTour(false); });
    window.addEventListener('resize', function () { applyView(); });

    refresh().catch(offlineFallback).then(refreshMe).then(function () {
      schedulePoll(POLL_MIN);
      loadAgentKey(false);
      if (Object.keys(S.unmuted).length) SN.engine.boot();
      routeSoon();
      if (!lsGet(TOUR_KEY)) setTimeout(function () { startTour(true); }, 900);
      if (S.hash && blockEls[S.hash]) {
        var el = blockEls[S.hash];
        el.classList.add('sel');
        setTimeout(function () { el.classList.remove('sel'); }, 2400);
      }
    });
  }

  if (document.fonts && document.fonts.ready) document.fonts.ready.then(init);
  else window.addEventListener('load', init);
})();
