

export const STEPS = 16;

export const INSTRUMENTS = ['kick', 'snare', 'hat', 'openhat', 'clap', 'rim', 'tom', 'bass', 'pluck'];

export const PITCHED = new Set(['tom', 'bass', 'pluck']);

export const SCALE = {
  root: 'D',
  name: 'minor pentatonic',
  midi: [50, 53, 55, 57, 60, 62, 65, 67, 69, 72],
};

export const DEFAULT_BPM = 96;
export const DEFAULT_SWING = 0.12;

export const MAX_NOTES = 96;

export const VEL_MIN = 0.15;
export const VEL_MAX = 1.0;
export const DECAY_MIN = 0.02;
export const DECAY_MAX = 1.5;

export const LOCK_MS = 365 * 24 * 60 * 60 * 1000;
export const IP_EDIT_CAP = 10;
export const PENDING_TTL_MS = 60 * 1000;
export const LEDGER_MAX = 200;

export const lockKey = (tokenId) => `lock/${tokenId}`;
export const fateKey = (tokenId) => `fate/${tokenId}`;

export const NOTE_ID_RE = /^n_[0-9a-f]{8}$/;

export function newNoteId() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return 'n_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function slotOf(note) {
  return `${note.inst}:${note.step}`;
}

export function seedBeat() {
  const at = Date.now();
  const mk = (inst, step, pitch, vel, decay) => ({
    id: newNoteId(), inst, step, pitch, vel, decay,
    country: '--', at, owner: 'seed',
  });
  return {
    version: 1,
    bpm: DEFAULT_BPM,
    swing: DEFAULT_SWING,
    steps: STEPS,

    ledger: [],
    notes: [
      mk('kick', 0, 0, 0.95, 0.32),
      mk('kick', 10, 0, 0.80, 0.28),
      mk('snare', 4, 0, 0.85, 0.20),
      mk('snare', 12, 0, 0.85, 0.20),
      mk('hat', 2, 0, 0.45, 0.05),
      mk('hat', 6, 0, 0.38, 0.05),
      mk('hat', 14, 0, 0.45, 0.06),
      mk('bass', 0, 0, 0.75, 0.45),
      mk('bass', 8, 3, 0.70, 0.40),
      mk('pluck', 12, 4, 0.55, 0.35),
    ],
  };
}

export function publicNote(n) {
  return {
    id: n.id, inst: n.inst, step: n.step, pitch: n.pitch,
    vel: n.vel, decay: n.decay, country: n.country, at: n.at,
  };
}

export function publicBeat(beat) {
  return {
    version: beat.version,
    bpm: beat.bpm,
    swing: beat.swing,
    steps: beat.steps ?? STEPS,
    instruments: INSTRUMENTS,
    pitched: [...PITCHED],
    scale: SCALE,
    maxNotes: MAX_NOTES,
    count: beat.notes.length,
    notes: beat.notes.map(publicNote),
  };
}
