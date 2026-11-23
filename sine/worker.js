/* sine · pyodide render worker
   Receives {type:'render', seq, code, n, sr, bpm, beats, input} and answers
   {type:'result', seq, out|error, stdout}. Python runs sandboxed in this
   worker; network primitives are removed once numpy is loaded. */
'use strict';

var PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
importScripts(PYODIDE_BASE + 'pyodide.js');

var py = null;
var pending = [];

var PRELUDE = [
  'import numpy as np',
  'import io, sys, traceback',
  '',
  'def __sine_render(code, n, sr, bpm, beats, inp_js):',
  '    n = int(n)',
  '    t = np.arange(n, dtype=np.float64) / sr',
  '    beat = t * (bpm / 60.0)',
  '    if inp_js is None:',
  '        inp = np.zeros(n)',
  '    else:',
  '        inp = np.resize(np.asarray(inp_js.to_py(), dtype=np.float64), n)',
  '    g = {"np": np, "sr": sr, "bpm": bpm, "beats": beats, "n": n,',
  '         "t": t, "beat": beat, "inp": inp}',
  '    buf = io.StringIO()',
  '    old = sys.stdout',
  '    sys.stdout = buf',
  '    try:',
  '        exec(compile(code, "<your code>", "exec"), g)',
  '    except BaseException as e:',
  '        line = getattr(e, "lineno", None) if isinstance(e, SyntaxError) else None',
  '        for fr in traceback.extract_tb(sys.exc_info()[2]):',
  '            if fr.filename == "<your code>":',
  '                line = fr.lineno',
  '        where = ("line %d: " % line) if line else ""',
  '        return {"error": where + type(e).__name__ + ": " + str(e),',
  '                "stdout": buf.getvalue()}',
  '    finally:',
  '        sys.stdout = old',
  '    if "out" not in g:',
  '        return {"error": "your code must define a variable called `out`",',
  '                "stdout": buf.getvalue()}',
  '    try:',
  '        out = np.asarray(g["out"], dtype=np.float64).ravel()',
  '    except BaseException as e:',
  '        return {"error": "`out` is not a wave: " + str(e), "stdout": buf.getvalue()}',
  '    if out.size < 2:',
  '        return {"error": "`out` must be an array of samples, not a scalar",',
  '                "stdout": buf.getvalue()}',
  '    if out.size != n:',
  '        out = np.resize(out, n)',
  '    out = np.nan_to_num(out, nan=0.0, posinf=0.0, neginf=0.0)',
  '    np.clip(out, -1.0, 1.0, out)',
  '    return {"out": out.astype(np.float32).tobytes(), "stdout": buf.getvalue()}',
].join('\n');

function neuterNetwork() {
  var kill = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts'];
  for (var i = 0; i < kill.length; i++) {
    try { self[kill[i]] = undefined; } catch (e) {}
  }
  try { if (self.navigator) self.navigator.sendBeacon = undefined; } catch (e) {}
}

function render(msg) {
  var fn = null, res = null, bytes = null;
  try {
    fn = py.globals.get('__sine_render');
    res = fn(msg.code, msg.n, msg.sr, msg.bpm, msg.beats, msg.input || null);
    var error = res.get('error');
    var stdout = res.get('stdout') || '';
    if (stdout.length > 4000) stdout = stdout.slice(0, 4000) + '\n…';
    if (error) {
      postMessage({ type: 'result', seq: msg.seq, error: String(error), stdout: stdout });
      return;
    }
    bytes = res.get('out');
    var u8 = bytes.toJs();
    var f32 = new Float32Array(u8.length >> 2);
    new Uint8Array(f32.buffer).set(u8.subarray(0, f32.length << 2));
    postMessage({ type: 'result', seq: msg.seq, out: f32, stdout: stdout }, [f32.buffer]);
  } catch (e) {
    postMessage({ type: 'result', seq: msg.seq, error: 'python failed: ' + (e && e.message || e) });
  } finally {
    try { if (bytes && bytes.destroy) bytes.destroy(); } catch (e) {}
    try { if (res && res.destroy) res.destroy(); } catch (e) {}
    try { if (fn && fn.destroy) fn.destroy(); } catch (e) {}
  }
}

onmessage = function (ev) {
  var msg = ev.data;
  if (!msg || msg.type !== 'render') return;
  if (!py) { pending.push(msg); return; }
  render(msg);
};

loadPyodide({ indexURL: PYODIDE_BASE })
  .then(function (p) {
    return p.loadPackage('numpy').then(function () { return p; });
  })
  .then(function (p) {
    p.runPython(PRELUDE);
    neuterNetwork();
    py = p;
    postMessage({ type: 'ready' });
    var q = pending; pending = [];
    for (var i = 0; i < q.length; i++) render(q[i]);
  })
  .catch(function (e) {
    postMessage({ type: 'boot-error', error: String(e && e.message || e) });
  });
