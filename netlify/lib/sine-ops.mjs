// One path for every change to the workspace, from the page or from an agent,
// so both obey exactly the same rules.
import { purgeCache } from '@netlify/functions';
import {
  readState, casState, readNonce, writeNonce, readRate, writeRate,
} from './sine-store.mjs';
import {
  publicState, newBlockId, placeBlock, startCell, defaultGroup, groupOwner, nameTaken, freeName,
  FORK_TEMPLATE, DEFAULT_COLOR, MAX_BLOCKS, MAX_PER_DEVICE, RL_MS, LEDGER_MAX, isColor,
} from './sine-schema.mjs';
import { hmacHex } from './identity.mjs';

const IP_WINDOW_MS = 60 * 60 * 1000;
const IP_FORKS = 40;          // new blocks per address per hour: plenty by hand, a wall for scripts

const pushLedger = (state, entry) => {
  state.ledger = [entry, ...(state.ledger || [])].slice(0, LEDGER_MAX);
};

const isLoopback = (ip) => !ip || ip === '::1' || ip.startsWith('127.') || ip === '::ffff:127.0.0.1';

async function ipAllows(store, env, ip) {
  if (isLoopback(ip)) return { ok: true };
  const key = `sine/ipf/${(await hmacHex(env.HMAC_SECRET, `ip:${ip}`)).slice(0, 24)}`;
  const now = Date.now();
  const rec = (await store.get(key, { type: 'json', consistency: 'strong' })) || { at: [] };
  const recent = (rec.at || []).filter((t) => now - t < IP_WINDOW_MS);
  if (recent.length >= IP_FORKS) return { ok: false, retryMs: IP_WINDOW_MS - (now - recent[0]) };
  return { ok: true, key, recent };
}

/**
 * edit: a validated edit (see sine-validate.mjs). claimId: the maker's id.
 * Returns { status, body } ready to send.
 */
export async function commitEdit(store, env, { claimId, edit, cc = '??', ip = '', via = 'page' }) {
  const seen = await readNonce(store, claimId);
  if (seen && seen.nonce === edit.nonce) {
    const { state } = await readState(store);
    return { status: 200, body: { ok: true, replay: true, state: publicState(state), blockId: seen.blockId ?? null } };
  }

  const rate = await readRate(store, claimId);
  if (rate && Date.now() - (rate.at || 0) < RL_MS) {
    return { status: 429, body: { error: 'rate', retryMs: RL_MS - (Date.now() - rate.at) } };
  }

  let ipGate = null;
  if (edit.op === 'fork') {
    ipGate = await ipAllows(store, env, ip);
    if (!ipGate.ok) return { status: 429, body: { error: 'ip-rate', retryMs: ipGate.retryMs } };
  }

  const now = Date.now();
  const outcome = await casState(store, (state) => {
    const out = mutate(state);
    if (out.ok) {
      // a box note goes when its box has no blocks left
      const live = new Set(state.blocks.map((b) => b.group).filter(Boolean));
      for (const k of Object.keys(state.boxes || {})) if (!live.has(k)) delete state.boxes[k];
    }
    return out;
  });

  function mutate(state) {
    if (edit.op === 'describe') {
      if (!state.blocks.some((b) => b.group === edit.group)) return { ok: false, status: 404, error: 'no-such-box' };
      if (groupOwner(state.blocks, edit.group) !== claimId) return { ok: false, status: 403, error: 'not-yours' };
      state.boxes = state.boxes || {};
      if (edit.about) state.boxes[edit.group] = { about: edit.about };
      else delete state.boxes[edit.group];
      return { ok: true, state, extra: { blockId: null } };
    }
    if (edit.op === 'fork') {
      const parent = state.blocks.find((b) => b.id === edit.parent);
      if (!parent) return { ok: false, status: 404, error: 'no-such-block' };
      if (state.blocks.length >= MAX_BLOCKS) return { ok: false, status: 409, error: 'full' };
      const owned = state.blocks.filter((b) => b.owner === claimId).length;
      if (owned >= MAX_PER_DEVICE) return { ok: false, status: 409, error: 'device-full' };

      const group = edit.group !== undefined ? edit.group : defaultGroup(state.blocks, claimId, parent, edit.author);
      const gOwner = groupOwner(state.blocks, group);
      if (group && gOwner && gOwner !== claimId) return { ok: false, status: 409, error: 'group-taken' };

      const named = edit.name.toLowerCase() === 'untitled' ? freeName(state.blocks, 'untitled') : edit.name;
      if (nameTaken(state.blocks, named)) return { ok: false, status: 409, error: 'name-taken' };

      const want = edit.col !== undefined ? { col: edit.col, row: edit.row } : startCell(state.blocks, { group, parent });
      const cell = placeBlock(state.blocks, { group, ...want });
      if (!cell) return { ok: false, status: 409, error: 'crowded' };

      const block = {
        id: newBlockId(),
        parent: parent.id,
        name: named,
        author: edit.author,
        code: edit.code !== undefined ? edit.code : FORK_TEMPLATE,
        beats: edit.beats !== undefined ? edit.beats : parent.beats,
        group,
        color: edit.color !== undefined ? edit.color
          : (isColor(parent.color) ? parent.color : DEFAULT_COLOR),
        col: cell.col,
        row: cell.row,
        owner: claimId,
        via,
        country: cc,
        at: now,
        updatedAt: now,
      };
      state.blocks.push(block);
      pushLedger(state, { kind: 'fork', name: block.name, from: parent.name, author: block.author, color: block.color, country: cc, via, at: now });
      return { ok: true, state, extra: { blockId: block.id } };
    }

    const idx = state.blocks.findIndex((b) => b.id === edit.id);
    if (idx === -1) return { ok: false, status: 404, error: 'no-such-block' };
    const block = state.blocks[idx];
    if (block.owner === 'seed' || block.owner !== claimId) return { ok: false, status: 403, error: 'not-yours' };

    if (edit.op === 'delete') {
      if (state.blocks.some((b) => b.parent === block.id)) {
        return { ok: false, status: 409, error: 'has-forks' };
      }
      state.blocks.splice(idx, 1);
      pushLedger(state, { kind: 'delete', name: block.name, author: block.author, color: block.color, country: cc, via, at: now });
      return { ok: true, state, extra: { blockId: null } };
    }

    const next = { ...block };
    if (edit.name !== undefined && edit.name !== block.name) {
      if (nameTaken(state.blocks, edit.name, block.id)) return { ok: false, status: 409, error: 'name-taken' };
      next.name = edit.name;
    }
    if (edit.author !== undefined) next.author = edit.author;
    if (edit.code !== undefined) next.code = edit.code;
    if (edit.beats !== undefined) next.beats = edit.beats;
    if (edit.color !== undefined) next.color = edit.color;
    if (edit.group !== undefined && edit.group !== block.group) {
      const others = state.blocks.filter((b) => b.id !== block.id);
      const gOwner = groupOwner(others, edit.group);
      if (edit.group && gOwner && gOwner !== claimId) return { ok: false, status: 409, error: 'group-taken' };
      next.group = edit.group;
    }
    if (edit.col !== undefined || next.group !== block.group) {
      const rest = state.blocks.filter((b) => b.id !== block.id);
      const joining = next.group && rest.some((b) => b.group === next.group);
      const want = edit.col !== undefined ? { col: edit.col, row: edit.row }
        : (joining ? startCell(rest, { group: next.group, parent: block }) : { col: block.col, row: block.row });
      const cell = placeBlock(state.blocks, { group: next.group, ...want, selfId: block.id });
      if (!cell) return { ok: false, status: 409, error: 'crowded' };
      next.col = cell.col;
      next.row = cell.row;
    }
    next.updatedAt = now;
    state.blocks[idx] = next;

    const moveOnly = edit.code === undefined && edit.name === undefined
      && edit.author === undefined && edit.beats === undefined
      && edit.group === undefined && edit.color === undefined;
    if (!moveOnly) {
      pushLedger(state, { kind: 'update', name: next.name, author: next.author, color: next.color, country: cc, via, at: now });
    }
    return { ok: true, state, extra: { blockId: block.id } };
  }

  if (!outcome.ok) {
    const { state } = await readState(store);
    return { status: outcome.status ?? 409, body: { error: outcome.error, version: state.version } };
  }

  const writes = [
    writeNonce(store, claimId, { nonce: edit.nonce, blockId: outcome.extra.blockId, at: now }),
    writeRate(store, claimId),
  ];
  if (ipGate && ipGate.key) writes.push(store.setJSON(ipGate.key, { at: [...ipGate.recent, now] }));
  await Promise.all(writes);

  try { await purgeCache({ tags: ['sine'] }); } catch {}

  return { status: 200, body: { ok: true, state: publicState(outcome.state), blockId: outcome.extra.blockId } };
}
