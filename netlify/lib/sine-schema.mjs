export const BPM = 112;
export const RENDER_SR = 44100;
export const BEATS_ALLOWED = [1, 2, 4, 8, 16, 32, 64, 128];
export const DEFAULT_BEATS = 16;

export const COLORS = ['orange', 'red', 'gold', 'green', 'teal', 'sky', 'blue', 'violet', 'pink', 'sand'];
export const DEFAULT_COLOR = 'orange';
export const HEX_RE = /^#[0-9a-f]{6}$/;
// relative luminance of a #rrggbb colour, 0 (black) to 1 (white)
export function luminance(hex) {
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
export const MIN_LUMINANCE = 0.06;
export const isColor = (c) => typeof c === 'string' && (COLORS.includes(c) || (HEX_RE.test(c) && luminance(c) >= MIN_LUMINANCE));

export const MAX_BLOCKS = 2000;
export const MAX_PER_DEVICE = 48;
export const CODE_MAX = 5000;
export const NAME_MAX = 40;
export const AUTHOR_MAX = 24;
export const GROUP_MAX = 24;
export const COORD_MAX = 200;
export const ABOUT_MAX = 240;

export const RL_MS = 2500;
export const LEDGER_MAX = 200;
export const LEDGER_SHOWN = 12;

export const BLOCK_ID_RE = /^b_[0-9a-f]{8}$/;
export const ROOT_ID = 'b_00000000';

export const nonceKey = (tokenId) => `sine/nonce/${tokenId}`;
export const rateKey = (tokenId) => `sine/rl/${tokenId}`;

export function newBlockId() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return 'b_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export const FORK_TEMPLATE = 'out = inp\n';

const SEED_SINE = `# 110 Hz, nudged to a whole number of cycles per beat,
# so a loop of any length wraps round without a click
f = round(110 * 60 / bpm) * bpm / 60
out = np.sin(2 * np.pi * f * t)
`;

const SEED_RHODES = `# Coltrane changes: A, F and C# major, each reached through its own dominant
chords = [(0, 'M7'), (3, '7'), (8, 'M7'), (11, '7'), (4, 'M7'), (7, '7'), (0, 'M7'), (9, 'm7'),
          (2, 'm7'), (3, '7'), (8, 'M7'), (11, '7'), (4, 'M7'), (7, '7'), (2, 'm7'), (1, '7')]
# rootless voicings: 3, 5 (13 on dominants), 7, 9
shape = {'M7': (4, 7, 11, 14), 'm7': (3, 7, 10, 14), '7': (4, 9, 10, 14)}

# voice leading: the inversion that moves least from the last chord
def inversions(root, q):
    pcs = sorted((root + i) % 12 for i in shape[q])
    for k in range(4):
        for o in (0, 12, 24):
            yield [x + o for x in pcs[k:] + [p + 12 for p in pcs[:k]]]
prev, voiced = [16, 19, 23, 26], []
for root, q in chords:
    prev = min((v for v in inversions(root, q) if 13 <= v[0] <= 22),
               key=lambda v: sum(abs(a - b) for a, b in zip(v, prev)))
    voiced.append(prev)
voiced = np.array(voiced)

# Charleston comping, swung
hits = []
for bar in range(8):
    hits += [(4 * bar, 2 * bar, 1.2, 1.0), (4 * bar + 5 / 3, 2 * bar + 1, 2.0, 0.8)]
st, ch, ln, vel = (np.array(c) for c in zip(*hits))
h = np.searchsorted(st, beat % 32, 'right') - 1
sec = 60 / bpm
gate = np.clip((ln[h] - (beat % 32 - st[h])) * 8, 0, 1)

T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
def phase(r):  # position in the input, moving at speed r
    return np.cumsum(np.broadcast_to(r, (n,))) / sr
def wave(p):   # the input at that position: speed 2 is an octave up
    return np.interp(p % T, tt, ww)

# FM electric piano
out = np.zeros(n)
for v in range(4):
    tau = (beat % 32 - st[h]) * sec - 0.012 * v
    r = 2.0 ** (voiced[ch[h], v] / 12)
    p0 = phase(r)
    index = vel[h] * (2.4 * np.exp(-tau / 0.22) + 0.35)
    tone = wave(phase(r * (1 + index * wave(p0))))
    tine = wave(p0 * 14) * np.exp(-np.abs(tau) / 0.025) * 0.3
    env = np.where(tau > 0, np.minimum(tau / 0.003, 1) * np.exp(-tau / 1.6), 0)
    out += (tone + tine) * env * gate * vel[h]
trem = 1 + 0.12 * wave(phase(4.6 / 110))
out = np.tanh(out * trem * 0.32) * 0.5
`;

const SEED_BASS = `roots = [0, 3, 8, 11, 4, 7, 0, 9, 2, 3, 8, 11, 4, 7, 2, 1]   # two beats each

# root, then a half step into the next root (or the fifth if it's close)
def near(pc, x):
    return min((pc + 12 * k for k in (-3, -2, -1, 0)),
               key=lambda y: abs(y - x) + (0 if -17 <= y <= 2 else 30))
line, x = [], -12
for i, r in enumerate(roots * 2):     # second lap follows on from the first
    root = near(r, x)
    nxt = near(roots[(i + 1) % 16], root)
    if abs(nxt - root) <= 2:
        lean = root + 7 if root + 7 <= 2 else root - 5
    else:
        lean = nxt - 1 if nxt > root else nxt + 1
    line += [root, lean]
    x = lean
line = line[32:]

# quarters, with a ghost note every other bar
ev = []
for q in range(32):
    if q % 8 == 7:
        ev += [(q, line[q], 0.55, 0.9), (q + 2 / 3, line[q], 0.25, 0.45)]
    else:
        ev += [(q, line[q], 0.9, 0.82 + 0.18 * (q % 2))]
st, semi, ln, vel = (np.array(c, dtype=float) for c in zip(*ev))
e = np.searchsorted(st, beat % 32, 'right') - 1
sec = 60 / bpm
tau = (beat % 32 - st[e]) * sec

T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
def phase(r):  # position in the input, moving at speed r
    return np.cumsum(np.broadcast_to(r, (n,))) / sr
def wave(p):   # the input at that position: speed 2 is an octave up
    return np.interp(p % T, tt, ww)

# upright bass
p = phase(2.0 ** ((semi[e] + 0.3 * np.exp(-tau / 0.02)) / 12))
body = (wave(p) + 0.5 * wave(2 * p) * np.exp(-tau / 0.35)
        + 0.25 * wave(3 * p) * np.exp(-tau / 0.12) + 0.12 * wave(4 * p) * np.exp(-tau / 0.05))
env = np.minimum(tau / 0.004, 1) * (0.35 + 0.65 * np.exp(-tau / 0.2))
env *= np.clip((ln[e] * sec - tau) / 0.02, 0, 1) * vel[e]
out = np.tanh(body * env * 1.4) * 0.62
`;

const SEED_RIDE = `T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
def phase(r):  # position in the input, moving at speed r
    return np.cumsum(np.broadcast_to(r, (n,))) / sr
def wave(p):   # the input at that position: speed 2 is an octave up
    return np.interp(p % T, tt, ww)

hiss = np.random.default_rng(1).uniform(-1, 1, n)       # white noise
k = np.fft.rfftfreq(n, 1 / sr)
def band(x, lo, hi):
    return np.fft.irfft(np.fft.rfft(x) * (k > lo) * (k < hi), n)

sec = 60 / bpm
b = beat % 4
# swing ride
rides = np.array([0, 1, 5 / 3, 2, 3, 11 / 3])
loud = np.array([0.75, 1, 0.55, 0.75, 1, 0.55])
r = np.searchsorted(rides, b, 'right') - 1
tau = (b - rides[r]) * sec
bell = sum(wave(phase(ratio)) * a for ratio, a in ((27.2, 1), (38.9, 0.6), (51.7, 0.4)))
ride = (band(hiss, 5000, 15000) * (np.exp(-tau / 0.05) + 0.5 * np.exp(-tau / 0.5))
        + bell * 0.3 * np.exp(-tau / 0.3))
ride *= loud[r] * np.minimum(tau / 0.001, 1)

# hi-hat on 2 and 4, brush sweeps
fb = b % 2
chick = band(hiss, 7000, 14000) * np.exp(-np.abs(fb - 1) * sec / 0.025) * (fb >= 1)
sweep = band(hiss, 600, 5000) * (0.5 - 0.5 * np.cos(2 * np.pi * (beat % 1))) * 0.05

# brush taps on random triplets
rng = np.random.default_rng(3)
trip = np.floor(beat * 3).astype(int) % (beats * 3)
tap = rng.random(beats * 3) < 0.16
tb = (beat * 3 % 1) / 3 * sec
snare = (band(hiss, 900, 5000) * 1.2 + wave(phase(1.8)) * 0.4) * np.exp(-tb / 0.07)
snare *= np.take(tap, trip) * rng.uniform(0.35, 0.8, beats * 3)[trip]

out = (ride * 0.22 + chick * 0.25 + sweep + snare * 0.35) * 1.1
`;

const SEED_VIBES = `chords = [(0, 'M'), (3, '7'), (8, 'M'), (11, '7'), (4, 'M'), (7, '7'), (0, 'M'), (9, 'm'),
          (2, 'm'), (3, '7'), (8, 'M'), (11, '7'), (4, 'M'), (7, '7'), (2, 'm'), (1, '7')]
# 1-2-3-5 patterns on each chord, up then down
cell = {'M': [0, 2, 4, 7], '7': [0, 2, 4, 7], 'm': [0, 2, 3, 7]}
notes, last = [], 21
for i, (root, q) in enumerate(chords):
    up = i % 2 == 0
    shape = cell[q] if up else cell[q][::-1]
    first = min((root + shape[0] + 12 * o for o in range(5)),
                key=lambda x: abs(x - last) + (0 if 12 <= x <= 33 else 30))
    pat = [first - shape[0] + s for s in shape]
    if i in (6, 14):       # a long ninth on the turnarounds
        notes += [(2 * i, pat[0] + 2, 1.8)]
        last = pat[0] + 2
    else:
        notes += [(2 * i + o, x, 0.85) for o, x in zip((0, 2 / 3, 1, 5 / 3), pat)]
        last = pat[-1]
st, semi, ln = (np.array(c, dtype=float) for c in zip(*notes))

T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
def phase(r):  # position in the input, moving at speed r
    return np.cumsum(np.broadcast_to(r, (n,))) / sr
def wave(p):   # the input at that position: speed 2 is an octave up
    return np.interp(p % T, tt, ww)

# two mallets take turns, so each bar rings on under the next
sec = 60 / bpm
out = np.zeros(n)
for m in (0, 1):
    s, x = st[m::2], semi[m::2]
    j = np.searchsorted(s, beat % 32, 'right') - 1
    since = (beat % 32 - s[j]) % 32
    tau = since * sec
    gate = np.clip((ln[m::2][j] - since) * 8, 0, 1)   # lift the mallet before it strikes again
    p = tau * 2.0 ** (x[j] / 12)   # each note starts its own wave, so tails cross the loop cleanly
    # a vibraphone bar rings at 1, 4 and about 10 times its pitch
    bar = wave(p) + 0.35 * wave(4 * p) * np.exp(-tau / 0.25) + 0.1 * wave(10 * p) * np.exp(-tau / 0.05)
    out += bar * np.minimum(tau / 0.002, 1) * np.exp(-tau / 1.1) * gate
motor = 1 - 0.3 * (0.5 + 0.5 * wave(phase(5.5 / 110)))
out = np.tanh(out * motor * 0.6) * 0.42
`;

const SEED_KICK = `# a kick is a sine falling fast in pitch
sec = 60 / bpm
T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
tau = (beat % 1) * sec
hi, lo, fall = 3.0, 0.45, 0.035
pos = lo * tau + (hi - lo) * fall * (1 - np.exp(-tau / fall))
body = np.interp(pos % T, tt, ww) * np.exp(-tau / 0.3)
click = np.interp((tau * 30) % T, tt, ww) * np.exp(-tau / 0.004)
out = np.tanh((body * 1.6 + click * 0.4) * 1.5) * np.minimum((sec - tau) / 0.01, 1) * 0.62
`;

const SEED_ACID = `# a saw wave is harmonics at 1/h. here each harmonic gets the gain
# a resonant filter would give it, so there is no filter, just a sum
riff = [0, 0, 12, 0, 3, 0, 10, 12, 0, 7, 0, 1, 0, 3, 5, 12]   # 16ths, semitones above A1
acc = [1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]
glide = [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0]       # slides
rest = [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]
last = riff[:12] + [15, 12, 10, 7]
notes = np.array(riff * 3 + last) - 12.0
acc, glide, rest = (np.tile(a, 4) for a in (acc, glide, rest))

sec, sd = 60 / bpm, 15 / bpm
s = np.floor(beat * 4).astype(int) % 64
x = (beat * 4) % 1
slid = glide[s - 1] == 1                   # no new attack after a slide
semi = np.where(slid, notes[s] + (notes[s - 1] - notes[s]) * np.exp(-x * sd / 0.03), notes[s])
held = glide[s] == 1
amp = np.where(held, 1, np.clip((0.55 - x) * sd / 0.004, 0, 1))
amp *= np.where(slid, 1, np.clip(x * sd / 0.002, 0, 1)) * (1 - rest[s]) * (0.75 + 0.35 * acc[s])

# cutoff, in multiples of the input pitch: a slow sweep plus an envelope per note
since = (x + slid) * sd
snap = np.exp(-since / np.where(acc[s] == 1, 0.1, 0.22))
sweep = 1 - np.abs(2 * ((beat / 16) % 1) - 1)
cut = 2.5 * 7 ** sweep * (1 + (2 + 3 * acc[s]) * snap)
q = 2.4 + 1.6 * acc[s]

r = 2.0 ** (semi / 12)
p = np.cumsum(r) / sr
T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
saw = np.zeros(n)
for h in range(1, 49):
    y = h * r / cut
    gain = 1 / ((1 - y * y) ** 2 + (y / q) ** 2)   # 24 dB resonant low-pass
    saw += np.interp((p * h) % T, tt, ww) * gain / h
out = np.tanh(saw * amp * 0.5) * 0.5
`;

const SEED_STABS = `# offbeat stabs: Am9, Am9, Fmaj9, G6/9
bars = [(15, 19, 22, 26), (15, 19, 22, 26), (12, 15, 19, 22), (14, 17, 19, 24)]
hits = [(4 * b + o, b) for b in range(4) for o in (0.5, 2.5)] + [(7.75, 1), (15.75, 3)]
hits.sort()
st = np.array([h[0] for h in hits])
ch = np.array([h[1] for h in hits])
j = np.searchsorted(st, beat % 16, 'right') - 1
sec = 60 / bpm
tau = ((beat % 16 - st[j]) % 16) * sec

T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
def wave(p):   # the input at that position: speed 2 is an octave up
    return np.interp(p % T, tt, ww)
dry = np.zeros(n)
for v in range(4):
    p = tau * 2.0 ** (np.array(bars)[ch[j], v] / 12)
    dry += wave(p) + 0.5 * wave(2 * p) + 0.3 * wave(3 * p) + 0.15 * wave(5 * p)
dry *= np.minimum(tau / 0.003, 1) * np.exp(-tau / 0.13) * np.clip((0.4 - tau) / 0.02, 0, 1)

# feedback echo as a geometric series, summed in one go: X / (1 - g D)
k = np.fft.rfftfreq(n, 1 / sr)
D = np.exp(-2j * np.pi * k * 0.75 * sec) / (1 + (k / 1500) ** 2)
wet = np.fft.irfft(np.fft.rfft(dry) / (1 + (k / 2600) ** 2) / (1 - 0.6 * D), n)

# sidechain
kt = (beat % 1) * sec
duck = 1 - 0.8 * (1 - np.exp(-kt / 0.004)) * np.exp(-kt / 0.1)
out = np.tanh(wet * duck * 0.3) * 0.6
`;

const SEED_HATS = `T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
def wave(p):   # the input at that position: speed 2 is an octave up
    return np.interp(p % T, tt, ww)

hiss = np.random.default_rng(1).uniform(-1, 1, n)       # white noise
k = np.fft.rfftfreq(n, 1 / sr)
def band(x, lo, hi):
    return np.fft.irfft(np.fft.rfft(x) * (k > lo) * (k < hi), n)

sd = 15 / bpm
s = np.floor(beat * 4).astype(int) % 16
x = (beat * 4) % 1
since = x * sd
# 16th hats, accents spread E(5,16)
accent = (np.arange(16) * 5) % 16 < 5
openat = s % 4 == 2
hat = band(hiss, 7500, 16000) * np.exp(-since / 0.018) * (0.3 + 0.5 * accent[s]) * ~openat
ohat = band(hiss, 6000, 16000) * np.exp(-((beat % 1) - 0.5) * 4 * sd / 0.12) * ((beat % 1) >= 0.5)
ohat *= np.clip((1 - beat % 1) * 4 * sd / 0.01, 0, 1)

# clap
c = (beat % 2 - 1) * 4 * sd
burst = sum(np.exp(-np.abs(c - d) / 0.004) * (c >= d) for d in (0, 0.011, 0.021, 0.033))
clap = band(hiss, 900, 3200) * (burst + 0.3 * np.exp(-np.maximum(c - 0.033, 0) / 0.11) * (c > 0.033))
clap *= c >= 0

out = np.tanh((hat * 0.6 + ohat * 0.4 + clap * 0.7) * 1.5) * 0.7
`;





const SEED_FRACTAL = `# a tune made of its own shape: start with one note, then replace every note
# by the four-note motif starting on it, three times over. every 4th note is
# the level above, every 16th the level above that
motif = [0, 2, -1, 1]
tune = [0]
for level in range(3):
    tune = [x + m for x in tune for m in motif]
deg = np.array(tune)

# on the pentatonic A B D E G, so nothing clashes
scale = np.array([0, 2, 5, 7, 10])
semi = 24 + 12 * (deg // 5) + scale[deg % 5]

# a kalimba, eighth notes, two thumbs in turn, the start of each group a little louder
sec = 60 / bpm
T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
def wave(p):   # the input at that position: speed 2 is an octave up
    return np.interp(p % T, tt, ww)
out = np.zeros(n)
e = beat * 2
for m in (0, 1):
    k = (np.floor((e - m) / 2) * 2 + m).astype(int) % 64
    since = (e - m) % 2 / 2
    tau = since * sec
    p = tau * 2.0 ** (semi[k] / 12)
    tone = wave(p) + 0.1 * wave(5.4 * p) * np.exp(-tau / 0.03)
    loud = np.where(k % 4 == 0, 1, 0.7)
    env = np.minimum(tau / 0.004, 1) * np.exp(-tau / 0.5) * np.clip((0.95 - since) * 20, 0, 1)
    out += tone * env * loud
out = np.tanh(out * 0.8) * 0.4
`;

const SEED_SLOW = `# the tune again at half and quarter speed, one and two octaves down.
# it is built from its own shape, so the slow copies trace the same contour
T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
half = np.interp((t / 2) % T, tt, ww)
quarter = np.interp((t / 4) % T, tt, ww)
out = half * 0.35 + quarter * 0.55
`;

const SEED_RULER = `# the ruler sequence: each 16th is as loud as the number of times its position
# halves. a bar is self-similar: halves, quarters, eighths, each split in two
sd = 15 / bpm
s = np.floor(beat * 4).astype(int) % 16
raw = beat * 4 % 1
swing = np.where(s % 2 == 1, 0.12, 0)          # the off 16ths come a little late
on = raw >= swing
x = np.clip((raw - swing) / (1 - swing), 0, 1)
tau = x * sd * (1 - swing)
fold = np.array([4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0])[s]

T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
def wave(p):   # the input at that position: speed 2 is an octave up
    return np.interp(p % T, tt, ww)
hiss = np.random.default_rng(1).uniform(-1, 1, n)       # white noise
k = np.fft.rfftfreq(n, 1 / sr)
shaker = np.fft.irfft(np.fft.rfft(hiss) * np.exp(-((k - 7000) / 2500) ** 2), n)
shaker = shaker / np.abs(shaker).max() * np.exp(-tau / 0.03) * (0.15 + 0.2 * fold)
fade = np.minimum((1 - x) * sd * (1 - swing) / 0.008, 1) * np.minimum(tau / 0.001, 1) * on
sec = 60 / bpm
kt = beat % 2 * sec                                   # the two loudest steps: a soft kick
kick = wave(0.5 * kt + 0.03 * (1 - np.exp(-kt / 0.03))) * np.exp(-kt / 0.25) * np.minimum((2 * sec - kt) / 0.01, 1)
tt2 = (beat + 1) % 2 * sec                            # the next ones down: a wooden tap
tap = wave(tt2 * 3.1) * np.exp(-tt2 / 0.05) * np.minimum((2 * sec - tt2) / 0.01, 1)
out = np.tanh(shaker * 0.7 * fade + kick * 0.8 + tap * 0.25) * 0.45
`;

const SEED_FIBONACCI = `# a bass line on the Fibonacci word (a becomes ab, b becomes a): long and short
# notes in a pattern that never quite repeats. a is three eighths on A, b two on E
w = 'a'
while len(w) < 40:
    w = ''.join('ab' if c == 'a' else 'a' for c in w)
starts, notes, at = [], [], 0
for c in w:
    if at >= beats * 2:
        break
    starts.append(at)
    notes.append(-12 if c == 'a' else -5)
    at += 3 if c == 'a' else 2
starts = np.array(starts, dtype=float) / 2      # in beats
notes = np.array(notes, dtype=float)
ends = np.append(starts[1:], beats)

sec = 60 / bpm
T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
def wave(p):   # the input at that position: speed 2 is an octave up
    return np.interp(p % T, tt, ww)
i = np.searchsorted(starts, beat, 'right') - 1
tau = (beat - starts[i]) * sec
left = (ends[i] - beat) * sec
p = tau * 2.0 ** (notes[i] / 12)
body = wave(p) + 0.35 * wave(2 * p) * np.exp(-tau / 0.25) + 0.1 * wave(3 * p) * np.exp(-tau / 0.1)
env = np.minimum(tau / 0.006, 1) * (0.5 + 0.5 * np.exp(-tau / 0.4)) * np.minimum(left / 0.03, 1)
out = np.tanh(body * env * 1.2) * 0.5
`;

const SEED_OVERTONES = `# harmonics of A1 in just intonation, a formant picking out a tune like overtone singing
partials = np.array([1, 2, 3, 4, 6, 8, 9, 12, 16, 18])
tune = np.array([8, 9, 12, 9, 8, 6, 8, 12])          # a harmonic every 4 beats

T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
step = beat / 4
a = np.floor(step).astype(int) % 8
glide = np.clip((step % 1 - 0.8) / 0.2, 0, 1)
glide = glide * glide * (3 - 2 * glide)
focus = tune[a] + (tune[(a + 1) % 8] - tune[a]) * glide

out = np.zeros(n)
for h in partials:
    sing = np.exp(-((h - focus) / 0.7) ** 2)
    out += np.interp((t * h / 2) % T, tt, ww) * (0.6 / h ** 0.7 + 1.0 * sing)
breath = 0.8 + 0.2 * (1 - np.abs(2 * ((beat / 8) % 1) - 1))
out = out * breath * 0.06
`;

const SEED_RISE = `# Shepard-Risset glissando: octaves gliding up, faded in at the bottom and out at the top
T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
f0 = np.sum((inp < 0) & (np.roll(inp, -1) >= 0)) / T      # input pitch
N = round(27.5 * T / np.log(2))       # whole cycles, so it loops
low = N * np.log(2) / T               # about 27.5 Hz
x = t / T
out = np.zeros(n)
for k in range(9):
    pos = low * 2 ** k * T / np.log(2) * (2 ** x - 1) / f0
    out += np.interp(pos % T, tt, ww) * np.exp(-((k + x - 4.6) / 1.6) ** 2)
out *= 0.24
`;

const SEED_CATHEDRAL = `# reverb only. FFT convolution is circular, so the tail wraps round the loop
rng = np.random.default_rng(7)
k = np.fft.rfftfreq(n, 1 / sr)
room = rng.normal(0, 1, n) * np.exp(-t / 1.3)
room = np.roll(room, int(0.04 * sr))
wet = np.fft.irfft(np.fft.rfft(inp) * np.fft.rfft(room) / (1 + (k / 2500) ** 2), n)
out = wet / (np.abs(wet).max() + 1e-9) * 0.55
`;

const SEED_ENDLESS = `# Risset rhythm: five tempo octaves of one beat, all speeding up, faded like the Shepard tone
T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
x = t / T
M = 12
B = M * np.log(2) / T
since_lo, fall = 0.42, 0.03

def wave(p):   # the input at that position: speed 2 is an octave up
    return np.interp(p % T, tt, ww)
k_ = np.fft.rfftfreq(n, 1 / sr)
hiss = np.random.default_rng(1).uniform(-1, 1, n)       # white noise
snap = np.fft.irfft(np.fft.rfft(hiss) * (k_ > 1200) * (k_ < 7000), n)

out = np.zeros(n)
for c in range(5):
    hits = B * 2 ** c * T / np.log(2) * (2 ** x - 1)
    rate = B * 2 ** (c + x)
    tau = (hits % 1) / rate
    left = (1 - hits % 1) / rate
    pos = since_lo * tau + (2.6 - since_lo) * fall * (1 - np.exp(-tau / fall))
    kick = wave(pos) * np.exp(-tau / 0.18)
    snare = (snap * 1.4 + wave(tau * 1.7) * 0.5) * np.exp(-tau / np.minimum(0.09, 0.25 / rate))
    odd = np.floor(hits) % 2 == 1
    drum = np.where(odd, snare, kick) * np.minimum(left / 0.004, 1)
    out += drum * np.exp(-((c + x - 2.2) / 1.0) ** 2)
out = np.tanh(out * 1.4) * 0.6
`;

const SEED_WARM = `# the rhodes from giant thirds, warmer: a slow tape wobble and a softer top
T = n / sr
tt, ww = np.append(t, T), np.append(inp, inp[0])
wobble = 0.0007 * np.sin(2 * np.pi * 6 * t / T)    # whole cycles per loop, so it still loops
x = np.interp((t + wobble) % T, tt, ww)
k = np.fft.rfftfreq(n, 1 / sr)
x = np.fft.irfft(np.fft.rfft(x) / (1 + (k / 2800) ** 2), n)
out = np.tanh(x * 1.6) * 0.6
`;

const SEED_ROUND = `# the walking bass from giant thirds, rounder
k = np.fft.rfftfreq(n, 1 / sr)
x = np.fft.irfft(np.fft.rfft(inp) / (1 + (k / 600) ** 4), n)
out = np.tanh(x * 1.5) * 0.6
`;

const SEED_ECHO = `# the vibes from giant thirds, with a dotted-eighth echo that darkens each time
k = np.fft.rfftfreq(n, 1 / sr)
D = np.exp(-2j * np.pi * k * 0.75 * 60 / bpm) / (1 + (k / 2500) ** 2)
X = np.fft.rfft(inp)
wet = np.fft.irfft(X * 0.45 * D / (1 - 0.45 * D), n)
out = np.fft.irfft(X / (1 + (k / 6000) ** 2), n) * 0.85 + wet * 0.5
`;

export function seedState() {
  const at = Date.now();
  let i = 0;
  const mk = (id, parent, name, beats, code, col, row, color, group) => ({
    id, parent, name, author: 'ethan', code, beats, col, row,
    color, group, owner: 'seed', country: '--', at: at + i++, updatedAt: at,
  });
  const G = 'giant thirds', A = 'fourier acid', S = 'self-similar', I = 'illusions', L = 'giant thirds, softly';
  return {
    version: 1,
    bpm: BPM,
    blocks: [
      mk(ROOT_ID, null, 'sine', 8, SEED_SINE, 4, 0, 'orange', 'sine'),

      mk('b_00000001', ROOT_ID, 'rhodes', 32, SEED_RHODES, 0, -2, 'gold', G),
      mk('b_00000002', ROOT_ID, 'walking bass', 32, SEED_BASS, 1, -2, 'sand', G),
      mk('b_00000003', ROOT_ID, 'ride and brushes', 4, SEED_RIDE, 2, -2, 'sand', G),
      mk('b_00000004', ROOT_ID, 'vibes', 32, SEED_VIBES, 3, -2, 'orange', G),

      mk('b_00000005', ROOT_ID, 'kick', 1, SEED_KICK, 5, -2, 'pink', A),
      mk('b_00000006', ROOT_ID, 'acid line', 16, SEED_ACID, 6, -2, 'red', A),
      mk('b_00000007', ROOT_ID, 'dub stabs', 16, SEED_STABS, 7, -2, 'violet', A),
      mk('b_00000008', ROOT_ID, 'hats and clap', 4, SEED_HATS, 8, -2, 'pink', A),

      mk('b_00000009', ROOT_ID, 'fractal tune', 32, SEED_FRACTAL, 0, 2, 'teal', S),
      mk('b_0000000a', 'b_00000009', 'slow copies', 128, SEED_SLOW, 1, 2, 'green', S),
      mk('b_0000000b', ROOT_ID, 'ruler beat', 4, SEED_RULER, 2, 2, 'sky', S),
      mk('b_0000000c', ROOT_ID, 'fibonacci bass', 32, SEED_FIBONACCI, 3, 2, 'teal', S),
      mk('b_0000000d', ROOT_ID, 'overtones', 32, SEED_OVERTONES, 4, 2, 'green', S),

      mk('b_0000000e', ROOT_ID, 'endless rise', 32, SEED_RISE, 6, 2, 'blue', I),
      mk('b_0000000f', 'b_0000000e', 'cathedral', 32, SEED_CATHEDRAL, 7, 2, 'violet', I),
      mk('b_00000010', ROOT_ID, 'endless beat', 32, SEED_ENDLESS, 8, 2, 'sky', I),

      mk('b_00000011', 'b_00000001', 'rhodes, warm', 32, SEED_WARM, 0, -4, 'gold', L),
      mk('b_00000012', 'b_00000002', 'bass, round', 32, SEED_ROUND, 1, -4, 'sand', L),
      mk('b_00000013', 'b_00000004', 'vibes, echo', 32, SEED_ECHO, 2, -4, 'orange', L),
    ],
    boxes: {
      sine: { about: 'The single wave everything else here is built from.' },
      [G]: { about: 'A small jazz band late at night: electric piano, upright bass, brushes and vibraphone, with chords that keep sliding into new keys.' },
      [L]: { about: 'The same jazz tune, quieter and warmer, with the drums taken out.' },
      [A]: { about: 'Acid house. A steady kick, a squelchy bassline that opens and closes, and chords that echo off into the distance.' },
      [S]: { about: 'Something gentle to leave on. A kalimba melody, slower copies of it underneath, a soft shuffle and a low drone.' },
      [I]: { about: 'A tone that seems to climb forever and a beat that seems to speed up forever. Neither actually does.' },
    },
    ledger: [],
  };
}

export function publicBlock(b) {
  return {
    id: b.id, parent: b.parent, name: b.name, author: b.author,
    code: b.code, beats: b.beats, col: b.col, row: b.row,
    color: isColor(b.color) ? b.color : DEFAULT_COLOR,
    group: typeof b.group === 'string' ? b.group : '',
    seed: b.owner === 'seed',
    agent: b.via === 'agent',
    country: b.country, at: b.at, updatedAt: b.updatedAt,
  };
}

export function publicState(state) {
  return {
    version: state.version,
    bpm: state.bpm,
    sr: RENDER_SR,
    beatsAllowed: BEATS_ALLOWED,
    colors: COLORS,
    maxBlocks: MAX_BLOCKS,
    count: state.blocks.length,
    blocks: state.blocks.map(publicBlock),
    boxes: Object.fromEntries(Object.entries(state.boxes || {}).map(([k, v]) => [k, { about: String(v.about || '') }])),
    ledger: (state.ledger || []).slice(0, LEDGER_SHOWN),
  };
}

// ---- names ----
export const nameKey = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
export function nameTaken(blocks, name, selfId = null) {
  const k = nameKey(name);
  return blocks.some((b) => b.id !== selfId && nameKey(b.name) === k);
}
export function freeName(blocks, base) {
  if (!nameTaken(blocks, base)) return base;
  for (let i = 2; ; i++) if (!nameTaken(blocks, `${base} ${i}`)) return `${base} ${i}`;
}

// ---- boxes and placement ----
// a group (box) belongs to whoever made its first block. nobody else can put
// blocks in it, and boxes keep at least one empty cell between each other.

export function groupOwner(blocks, name) {
  if (!name) return null;
  let first = null;
  for (const b of blocks) {
    if (b.group !== name) continue;
    if (!first || b.at < first.at || (b.at === first.at && b.id < first.id)) first = b;
  }
  return first ? first.owner : null;
}

function boxesOf(blocks) {
  const m = new Map();
  for (const b of blocks) {
    if (!b.group) continue;
    const g = m.get(b.group);
    if (!g) m.set(b.group, { c0: b.col, c1: b.col, r0: b.row, r1: b.row });
    else {
      g.c0 = Math.min(g.c0, b.col); g.c1 = Math.max(g.c1, b.col);
      g.r0 = Math.min(g.r0, b.row); g.r1 = Math.max(g.r1, b.row);
    }
  }
  return m;
}

// where a block of `group` may sit, given everyone else's blocks
export function placeBlock(blocks, { group = '', col, row, selfId = null }) {
  const others = blocks.filter((b) => b.id !== selfId);
  const taken = new Set(others.map((b) => `${b.col}:${b.row}`));
  const boxes = boxesOf(others);
  const mine = boxes.get(group) || null;
  const fences = [];
  for (const [name, g] of boxes) {
    if (name !== group) fences.push({ c0: g.c0 - 1, c1: g.c1 + 1, r0: g.r0 - 1, r1: g.r1 + 1 });
  }
  const loose = others.filter((b) => !b.group);
  const members = group ? others.filter((b) => b.group === group).map((b) => [b.col, b.row]) : [];
  const hits = (f, c0, c1, r0, r1) => c0 <= f.c1 && c1 >= f.c0 && r0 <= f.r1 && r1 >= f.r0;
  const ok = (c, r) => {
    if (Math.abs(c) > COORD_MAX || Math.abs(r) > COORD_MAX || taken.has(`${c}:${r}`)) return false;
    if (!group) return !fences.some((f) => hits(f, c, c, r, r));
    // the whole box, with this cell in it, has to stay clear of other boxes and loose blocks
    const c0 = mine ? Math.min(mine.c0, c) : c, c1 = mine ? Math.max(mine.c1, c) : c;
    const r0 = mine ? Math.min(mine.r0, r) : r, r1 = mine ? Math.max(mine.r1, r) : r;
    if (fences.some((f) => hits(f, c0, c1, r0, r1))) return false;
    if (loose.some((b) => b.col >= c0 - 1 && b.col <= c1 + 1 && b.row >= r0 - 1 && b.row <= r1 + 1)) return false;
    return !members.length || connected([...members, [c, r]]);
  };
  for (let rad = 0; rad <= 40; rad++) {
    const ring = [];
    for (let dc = -rad; dc <= rad; dc++) {
      for (let dr = -rad; dr <= rad; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) === rad) ring.push([dc, dr]);
      }
    }
    ring.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
    for (const [dc, dr] of ring) if (ok(col + dc, row + dr)) return { col: col + dc, row: row + dr };
  }
  return null;
}

// are these cells one piece, joined edge to edge?
export function connected(cells) {
  const key = (c) => c[0] + ':' + c[1];
  const all = new Set(cells.map(key));
  const seen = new Set([key(cells[0])]);
  const stack = [cells[0]];
  while (stack.length) {
    const [c, r] = stack.pop();
    for (const n of [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]) {
      const k = key(n);
      if (all.has(k) && !seen.has(k)) { seen.add(k); stack.push(n); }
    }
  }
  return seen.size === all.size;
}

// where a new block starts looking for a cell
export function startCell(blocks, { group, parent }) {
  const members = group ? blocks.filter((b) => b.group === group) : [];
  if (members.length) {
    const r0 = Math.min(...members.map((b) => b.row));
    const c1 = Math.max(...members.filter((b) => b.row === r0).map((b) => b.col));
    return { col: c1 + 1, row: r0 };
  }
  if (group) return { col: parent.col, row: parent.row - 2 };
  return { col: parent.col + 1, row: parent.row };
}

// a fork goes in its maker's own box: the parent's, if that box is theirs,
// else the box they used last, else a new one named after them
export function defaultGroup(blocks, ownerId, parent, author) {
  if (parent.group && groupOwner(blocks, parent.group) === ownerId) return parent.group;
  let last = null;
  for (const b of blocks) {
    if (b.owner !== ownerId || !b.group || groupOwner(blocks, b.group) !== ownerId) continue;
    if (!last || b.updatedAt > last.updatedAt) last = b;
  }
  if (last) return last.group;
  const base = (author || 'anonymous').slice(0, GROUP_MAX - 3).trim() || 'anonymous';
  let name = base;
  for (let i = 2; groupOwner(blocks, name) && groupOwner(blocks, name) !== ownerId; i++) name = `${base} ${i}`;
  return name;
}
