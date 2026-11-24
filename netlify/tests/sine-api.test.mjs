import { check, section, finish, nonce, BASE } from './helpers.mjs';

const J = { 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RL_WAIT = 2700;

async function getSine() {
  return (await fetch(`${BASE}/api/sine`)).json();
}

async function newDevice() {
  const r = await fetch(`${BASE}/api/sine-me`);
  const body = await r.json();
  return { token: body.token, me: body };
}

async function meSine(dev) {
  return (await fetch(`${BASE}/api/sine-me`, { headers: { 'X-Beat-Token': dev.token } })).json();
}

async function sedit(dev, body) {
  const r = await fetch(`${BASE}/api/sine-edit`, {
    method: 'POST',
    headers: { ...J, 'X-Beat-Token': dev.token },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

const ROOT = 'b_00000000';
const blockOf = (st, id) => st.blocks.find((b) => b.id === id);

section('[1] validation rejects rather than coerces');
const v = await newDevice();
const bad = [
  ['unknown op', { op: 'clone', parent: ROOT }, 'op'],
  ['malformed parent id', { op: 'fork', parent: 'bogus' }, 'parent'],
  ['name too long', { op: 'fork', parent: ROOT, name: 'x'.repeat(41) }, 'name'],
  ['author too long', { op: 'fork', parent: ROOT, author: 'x'.repeat(25) }, 'author'],
  ['beats not in the allowed set', { op: 'fork', parent: ROOT, beats: 5 }, 'beats'],
  ['beats as a string', { op: 'fork', parent: ROOT, beats: '16' }, 'beats'],
  ['code too long', { op: 'fork', parent: ROOT, code: '#'.repeat(5001) }, 'code'],
  ['color not in the palette', { op: 'fork', parent: ROOT, color: 'mauve' }, 'color'],
  ['group label too long', { op: 'fork', parent: ROOT, group: 'x'.repeat(25) }, 'group'],
  ['col without row', { op: 'fork', parent: ROOT, col: 3 }, 'cell'],
  ['fractional cell', { op: 'fork', parent: ROOT, col: 1.5, row: 0 }, 'cell'],
  ['update with nothing to change', { op: 'update', id: ROOT }, 'empty'],
  ['malformed block id', { op: 'delete', id: 'nope' }, 'id'],
  ['moving no box', { op: 'move', dc: 1, dr: 0 }, 'group'],
  ['moving by part of a cell', { op: 'move', group: 'x', dc: 0.5, dr: 0 }, 'shift'],
];
for (const [label, body, field] of bad) {
  const r = await sedit(v, { ...body, nonce: nonce('bad', field) });
  check(label, [r.status, r.body.field], [400, field]);
}
const noNonce = await sedit(v, { op: 'fork', parent: ROOT });
check('missing nonce', [noNonce.status, noNonce.body.field], [400, 'nonce']);
const forged = await sedit(
  { token: 'v1.11111111-2222-3333-4444-555555555555.20000.AAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  { op: 'fork', parent: ROOT, nonce: nonce('forge', 0) },
);
check('forged token is rejected', [forged.status, forged.body.error], [401, 'bad-token']);
const ghost = await sedit(v, { op: 'fork', parent: 'b_deadbeef', nonce: nonce('ghost', 0) });
check('fork of a block that does not exist', [ghost.status, ghost.body.error], [404, 'no-such-block']);

section('[2] forking the sine');
const a = await newDevice();
const st0 = await getSine();
const f1 = await sedit(a, {
  op: 'fork', parent: ROOT, nonce: nonce('fork', 1),
  name: 'test square', author: 'the test suite', beats: 8, code: 'out = np.sign(inp)\n',
  color: 'teal', group: 'test group',
});
check('the fork commits', f1.status, 200);
const id1 = f1.body.blockId;
check('a block id comes back', /^b_[0-9a-f]{8}$/.test(id1), true);
check('version advanced by 1', f1.body.state.version - st0.version, 1);
const b1 = blockOf(f1.body.state, id1);
check('the block carries its name, author, beats', [b1.name, b1.author, b1.beats], ['test square', 'the test suite', 8]);
check('and its color and group', [b1.color, b1.group], ['teal', 'test group']);
check('the ledger entry knows the color', f1.body.state.ledger[0].color, 'teal');
check('its input is the block it forked', b1.parent, ROOT);
check('it is not marked as seed', b1.seed, false);
check('it landed on a free cell', f1.body.state.blocks.filter((b) => b.col === b1.col && b.row === b1.row).length, 1);
check('the ledger records the fork', f1.body.state.ledger[0].kind, 'fork');
check('sine-me lists it as mine', (await meSine(a)).blocks.includes(id1), true);
check('sine-me does not list it for another device', (await meSine(v)).blocks.includes(id1), false);

section('[3] resending the same nonce replays, it does not fork twice');
const a2 = await newDevice();
const nn = nonce('idem', 3);
const body2 = { op: 'fork', parent: ROOT, nonce: nn, name: 'test echo', code: 'out = inp\n' };
const r1 = await sedit(a2, body2);
const r2 = await sedit(a2, body2);
check('first attempt commits', r1.status, 200);
check('identical resend replays', [r2.status, r2.body.replay], [200, true]);
check('both name the same block', r1.body.blockId, r2.body.blockId);
check('only one block was created', (await getSine()).blocks.filter((b) => b.name === 'test echo').length, 1);
const id2 = r1.body.blockId;

section('[4] blocks belong to whoever made them');
const stranger = await newDevice();
const up = await sedit(stranger, { op: 'update', id: id1, code: 'out = inp * 0\n', nonce: nonce('steal', 1) });
check('a stranger cannot rewrite it', [up.status, up.body.error], [403, 'not-yours']);
const del = await sedit(stranger, { op: 'delete', id: id1, nonce: nonce('steal', 2) });
check('a stranger cannot delete it', [del.status, del.body.error], [403, 'not-yours']);
const seedUp = await sedit(stranger, { op: 'update', id: ROOT, code: 'out = t\n', nonce: nonce('steal', 3) });
check('the seed generator cannot be rewritten', [seedUp.status, seedUp.body.error], [403, 'not-yours']);
const seedDel = await sedit(stranger, { op: 'delete', id: ROOT, nonce: nonce('steal', 4) });
check('the seed generator cannot be deleted', [seedDel.status, seedDel.body.error], [403, 'not-yours']);

section('[5] the maker can reshape and move it');
await sleep(RL_WAIT);
const up2 = await sedit(a, {
  op: 'update', id: id1, nonce: nonce('shape', 1),
  name: 'test square II', code: 'out = np.sign(inp) * 0.5\n', beats: 16,
  color: 'pink', group: '',
});
check('the update commits', up2.status, 200);
const b1b = blockOf(up2.body.state, id1);
check('name, code, beats all moved', [b1b.name, b1b.beats, b1b.code.includes('0.5')], ['test square II', 16, true]);
check('recolored, and the group cleared', [b1b.color, b1b.group], ['pink', '']);
check('the ledger calls it a reshape', up2.body.state.ledger[0].kind, 'update');
await sleep(RL_WAIT);
const mv = await sedit(a, { op: 'update', id: id1, nonce: nonce('move', 1), col: 7, row: 7 });
check('a move commits', mv.status, 200);
check('the block sits on the asked-for cell', [blockOf(mv.body.state, id1).col, blockOf(mv.body.state, id1).row], [7, 7]);
const mvLedger = mv.body.state.ledger[0];
check('a bare move stays out of the ledger', mvLedger.kind === 'update' && mvLedger.at === up2.body.state.ledger[0].at, true);

section('[6] two blocks cannot share a cell');
const dA = await newDevice();
const dB = await newDevice();
const c1 = await sedit(dA, { op: 'fork', parent: ROOT, nonce: nonce('cell', 1), col: 9, row: 9, name: 'test cell A' });
const c2 = await sedit(dB, { op: 'fork', parent: ROOT, nonce: nonce('cell', 2), col: 9, row: 9, name: 'test cell B' });
check('both forks commit', [c1.status, c2.status], [200, 200]);
const ca = blockOf(c2.body.state, c1.body.blockId);
const cb = blockOf(c2.body.state, c2.body.blockId);
check('the second was pushed to a neighbouring cell', ca.col === cb.col && ca.row === cb.row, false);
check('it stayed near where it asked to be', Math.max(Math.abs(cb.col - 9), Math.abs(cb.row - 9)) <= 2, true);

section('[6b] a fork keeps its parent’s color but goes in its maker’s own box');
const inh = await newDevice();
const fi = await sedit(inh, { op: 'fork', parent: 'b_00000001', nonce: nonce('inherit', 1), name: 'test heir', author: 'test heir maker' });
check('the fork commits', fi.status, 200);
const heir = blockOf(fi.body.state, fi.body.blockId);
check('it wears its parent’s color', heir.color, 'gold');
check('it is not in the example’s box', heir.group !== 'giant thirds' && heir.group !== '', true);
const seedBox = fi.body.state.blocks.filter((b) => b.group === 'giant thirds');
const clear = seedBox.every((b) => Math.max(Math.abs(b.col - heir.col), Math.abs(b.row - heir.row)) >= 2);
check('and its box keeps a clear cell from the example’s box', clear, true);

section('[6c] nobody can put blocks in someone else’s box');
const crash = await newDevice();
const intoSeed = await sedit(crash, { op: 'fork', parent: ROOT, nonce: nonce('crash', 1), name: 'test crasher', group: 'giant thirds' });
check('not into an example’s box', [intoSeed.status, intoSeed.body.error], [409, 'group-taken']);
const intoTheirs = await sedit(crash, { op: 'fork', parent: ROOT, nonce: nonce('crash', 2), name: 'test crasher', group: heir.group });
check('not into another visitor’s box', [intoTheirs.status, intoTheirs.body.error], [409, 'group-taken']);
await sleep(RL_WAIT);
const second = await sedit(inh, { op: 'fork', parent: ROOT, nonce: nonce('inherit', 2), name: 'test heir two' });
check('the box’s maker can add to it', second.status, 200);
check('and the new block joins that box by default', blockOf(second.body.state, second.body.blockId).group, heir.group);
const seedMove = await sedit(crash, { op: 'update', id: 'b_00000002', nonce: nonce('crash', 3), col: 30, row: 30 });
check('examples cannot be moved', [seedMove.status, seedMove.body.error], [403, 'not-yours']);

section('[7] a block with forks on it cannot be deleted');
const child = await sedit(stranger, { op: 'fork', parent: id1, nonce: nonce('child', 1), name: 'test leaf' });
check('a stranger can fork it', child.status, 200);
await sleep(RL_WAIT);
const delBlocked = await sedit(a, { op: 'delete', id: id1, nonce: nonce('blocked', 1) });
check('deleting the parent is refused', [delBlocked.status, delBlocked.body.error], [409, 'has-forks']);
await sleep(RL_WAIT);
const delLeaf = await sedit(stranger, { op: 'delete', id: child.body.blockId, nonce: nonce('leaf', 1) });
check('the leaf can go', delLeaf.status, 200);
await sleep(RL_WAIT);
const delNow = await sedit(a, { op: 'delete', id: id1, nonce: nonce('freed', 1) });
check('and then the parent can too', delNow.status, 200);
check('it is gone from the state', blockOf(delNow.body.state, id1), undefined);

section('[8] one save every few seconds per device');
const hasty = await newDevice();
const h1 = await sedit(hasty, { op: 'fork', parent: ROOT, nonce: nonce('rl', 1), name: 'test hasty' });
const h2 = await sedit(hasty, { op: 'update', id: h1.body.blockId, nonce: nonce('rl', 2), name: 'test hastier' });
check('the first save commits', h1.status, 200);
check('the immediate second one is told to slow down', [h2.status, h2.body.error], [429, 'rate']);

section('[10] agents over MCP');
const MCP = `${BASE}/api/sine-mcp`;
async function mcp(url, method, params, id = 1) {
  const r = await fetch(url, { method: 'POST', headers: J, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
}
const tool = async (url, name, args) => {
  const r = await mcp(url, 'tools/call', { name, arguments: args });
  return r.body.result ? { error: !!r.body.result.isError, text: r.body.result.content[0].text } : { rpc: r.body.error, status: r.status };
};
const init = await mcp(MCP, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
check('initialize answers', [init.status, init.body.result.serverInfo.name], [200, 'sine']);
const tl = await mcp(MCP, 'tools/list', {});
check('the tools are listed', tl.body.result.tools.map((t) => t.name).sort().join(','), 'add_block,delete_block,describe_box,edit_block,examples,list_blocks,move_box,read_block,test_script');
const ex = await tool(MCP, 'examples', {});
check('examples carry the guide and the code of every example song', [ex.error, ex.text.includes('# Writing a sine block'), ex.text.includes('### fractal tune'), ex.text.includes('def wave(p)')], [false, true, true, true]);
const exRes = await mcp(MCP, 'resources/read', { uri: 'sine://examples' });
check('and the same as a resource', exRes.body.result.contents[0].text === ex.text, true);
const note = await fetch(MCP, { method: 'POST', headers: J, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
check('a notification gets 202', note.status, 202);
const ro = await tool(MCP, 'add_block', { parent: ROOT, name: 'test ro', code: 'out = inp' });
check('without a key it is read only', ro.error, true);
const listed = JSON.parse((await tool(MCP, 'list_blocks', {})).text);
check('anyone can list', listed.blocks.some((b) => b.id === ROOT), true);
const agentDev = await newDevice();
const keyRes = await (await fetch(`${BASE}/api/sine-key`, { headers: { 'X-Beat-Token': agentDev.token } })).json();
check('a device gets an agent address', /\/api\/sine-mcp\/sk_/.test(keyRes.url), true);
const noTokKey = await fetch(`${BASE}/api/sine-key`);
check('no device, no address', noTokKey.status, 401);
const AURL = keyRes.url;
const added = await tool(AURL, 'add_block', { parent: ROOT, name: 'test agent block', code: 'out = inp * 0.5\n', author: 'test agent' });
check('with the key it can add', added.error, false);
const agentId = JSON.parse(added.text).id;
check('the block counts as the device’s own', (await meSine(agentDev)).blocks.includes(agentId), true);
const st10 = await getSine();
check('it is marked as made by an agent', blockOf(st10, agentId).agent, true);
const noOut = await tool(AURL, 'add_block', { parent: ROOT, name: 'test no out', code: 'x = inp' });
check('code that never sets out is refused', noOut.error, true);
await sleep(RL_WAIT);
const steal = await tool(AURL, 'edit_block', { id: 'b_00000001', code: 'out = inp * 0' });
check('it cannot change an example', [steal.error, /someone else/.test(steal.text)], [true, true]);
const stealDel = await tool(AURL, 'delete_block', { id: id2 });
check('it cannot delete another visitor’s block', stealDel.error, true);
const foreign = await tool(AURL, 'test_script', { parent: id2 });
check('no local script for a chain with strangers’ code in it', foreign.error, true);
const script = await tool(AURL, 'test_script', { parent: 'b_00000001', beats: 32 });
check('a script for a chain of examples', [script.error, script.text.includes('CHAIN = [')], [false, true]);
const read = JSON.parse((await tool(AURL, 'read_block', { id: id2 })).text);
check('strangers’ code comes with a warning', typeof read.note, 'string');
const forgedKey = await mcp(MCP + '/sk_' + agentDev.me.token.split('.')[1] + '_0_' + '0'.repeat(32), 'tools/call', { name: 'list_blocks', arguments: {} });
check('a forged key is refused', forgedKey.status, 401);
const rotated = await (await fetch(`${BASE}/api/sine-key`, { method: 'POST', headers: { 'X-Beat-Token': agentDev.token } })).json();
const oldKey = await mcp(AURL, 'tools/call', { name: 'list_blocks', arguments: {} });
check('a new address switches the old one off', [oldKey.status, rotated.url !== AURL], [401, true]);
await sleep(RL_WAIT);
const agentBox = blockOf(await getSine(), agentId);
const boxMove = await tool(rotated.url, 'move_box', { group: agentBox.group, dc: 0, dr: 30 });
const movedTo = boxMove.error ? null : JSON.parse(boxMove.text).blocks[0];
check('it can move its own box', [boxMove.error, movedTo && movedTo.row - agentBox.row, movedTo && movedTo.col - agentBox.col], [false, 30, 0]);
await sleep(RL_WAIT);
const seedMoveA = await tool(rotated.url, 'move_box', { group: 'giant thirds', dc: 1, dr: 0 });
check('but not an example', [seedMoveA.error, /someone else/.test(seedMoveA.text)], [true, true]);
await sleep(RL_WAIT);
const delA = await tool(rotated.url, 'delete_block', { id: agentId });
check('the new address can delete its own block', delA.error, false);

section('[12] any colour, as long as it shows on black');
const painter = await newDevice();
const hex = await sedit(painter, { op: 'fork', parent: ROOT, nonce: nonce('hex', 1), name: 'test custom colour', color: '#1FA2FF' });
check('a #rrggbb colour is kept', [hex.status, hex.status === 200 && blockOf(hex.body.state, hex.body.blockId).color], [200, '#1fa2ff']);
await sleep(RL_WAIT);
const dark = await sedit(painter, { op: 'update', id: hex.body.blockId, nonce: nonce('hex', 2), color: '#050505' });
check('one too dark to see is refused', [dark.status, dark.body.field], [400, 'color']);
const notHex = await sedit(painter, { op: 'update', id: hex.body.blockId, nonce: nonce('hex', 3), color: 'url(x)' });
check('and so is anything that is not a colour', [notHex.status, notHex.body.field], [400, 'color']);
await sleep(RL_WAIT);
const delHex = await sedit(painter, { op: 'delete', id: hex.body.blockId, nonce: nonce('hex', 4) });
check('cleaned up', delHex.status, 200);

section('[11] names, notes, and boxes in one piece');
const nm = await newDevice();
const dupe = await sedit(nm, { op: 'fork', parent: ROOT, nonce: nonce('dupe', 1), name: 'Rhodes ' });
check('a name already on the page is refused', [dupe.status, dupe.body.error], [409, 'name-taken']);
const u1 = await sedit(nm, { op: 'fork', parent: ROOT, nonce: nonce('dupe', 2), name: 'untitled', author: 'test namer' });
check('untitled is fine', u1.status, 200);
const nm2 = await newDevice();
const u2 = await sedit(nm2, { op: 'fork', parent: ROOT, nonce: nonce('dupe', 3), name: 'untitled', author: 'test namer two' });
const u1name = blockOf(u2.body.state, u1.body.blockId).name, u2name = blockOf(u2.body.state, u2.body.blockId).name;
check('a second untitled gets a number', u1name !== u2name && /^untitled/.test(u2name), true);
await sleep(RL_WAIT);
const myBox = blockOf(u2.body.state, u1.body.blockId).group;
const boxNote = await sedit(nm, { op: 'describe', group: myBox, about: '  a test note  ', nonce: nonce('note', 1) });
check('the box maker can write its note', [boxNote.status, boxNote.body.state.boxes[myBox] && boxNote.body.state.boxes[myBox].about], [200, 'a test note']);
const noteSteal = await sedit(nm2, { op: 'describe', group: myBox, about: 'mine now', nonce: nonce('note', 2) });
check('nobody else can', [noteSteal.status, noteSteal.body.error], [403, 'not-yours']);
await sleep(RL_WAIT);
const noteSeed = await sedit(nm2, { op: 'describe', group: 'giant thirds', about: 'x', nonce: nonce('note', 3) });
check('nor an example’s', [noteSeed.status, noteSeed.body.error], [403, 'not-yours']);
check('examples come with notes', typeof (await getSine()).boxes['self-similar'].about, 'string');
await sleep(RL_WAIT);
const u3 = await sedit(nm, { op: 'fork', parent: ROOT, nonce: nonce('dupe', 4), name: 'test second in box' });
const b3 = blockOf(u3.body.state, u3.body.blockId);
await sleep(RL_WAIT);
const far = await sedit(nm, { op: 'update', id: u3.body.blockId, nonce: nonce('far', 1), col: b3.col + 6, row: b3.row + 5 });
const fb = blockOf(far.body.state, u3.body.blockId), fa = blockOf(far.body.state, u1.body.blockId);
check('a block cannot be dragged away from its box', Math.abs(fb.col - fa.col) + Math.abs(fb.row - fa.row), 1);
await sleep(RL_WAIT);
const clean11 = [[nm2, u2.body.blockId], [nm, u3.body.blockId]];
for (const [dev, id] of clean11) { const r = await sedit(dev, { op: 'delete', id, nonce: nonce('c11', id) }); check(`removed ${id}`, r.status, 200); }
await sleep(RL_WAIT);
const last = await sedit(nm, { op: 'delete', id: u1.body.blockId, nonce: nonce('c11', 'last') });
check('and the box note goes with its last block', [last.status, last.body.state.boxes[myBox]], [200, undefined]);

section('[11b] a box moves as one, and only its maker can move it');
const mover = await newDevice();
const mb = 'test moving box';
const m1 = await sedit(mover, { op: 'fork', parent: ROOT, nonce: nonce('box', 1), name: 'test mover one', author: 'test mover', group: mb, col: 20, row: 20 });
await sleep(RL_WAIT);
const m2 = await sedit(mover, { op: 'fork', parent: ROOT, nonce: nonce('box', 2), name: 'test mover two', group: mb });
const cellsOf = (st) => [m1, m2].map((r) => { const b = blockOf(st, r.body.blockId); return [b.col, b.row]; });
const at0 = cellsOf(m2.body.state);
await sleep(RL_WAIT);
const mv1 = await sedit(mover, { op: 'move', group: mb, dc: 3, dr: 2, nonce: nonce('box', 3) });
check('the whole box shifts together', [mv1.status, cellsOf(mv1.body.state)], [200, at0.map(([c, r]) => [c + 3, r + 2])]);
const thief = await newDevice();
const boxSteal = await sedit(thief, { op: 'move', group: mb, dc: 1, dr: 0, nonce: nonce('box', 4) });
check('nobody else can move it', [boxSteal.status, boxSteal.body.error], [403, 'not-yours']);
await sleep(RL_WAIT);
const seedBoxMove = await sedit(thief, { op: 'move', group: 'giant thirds', dc: 5, dr: 0, nonce: nonce('box', 5) });
check('nor an example', [seedBoxMove.status, seedBoxMove.body.error], [403, 'not-yours']);
await sleep(RL_WAIT);
const noBox = await sedit(thief, { op: 'move', group: 'test no such box', dc: 1, dr: 0, nonce: nonce('box', 6) });
check('a box that is not there', [noBox.status, noBox.body.error], [404, 'no-such-box']);
const sineB = blockOf(mv1.body.state, ROOT), at1 = cellsOf(mv1.body.state);
await sleep(RL_WAIT);
const onto = await sedit(mover, { op: 'move', group: mb, dc: sineB.col - at1[0][0], dr: sineB.row - at1[0][1], nonce: nonce('box', 7) });
const bboxOf = (st, g) => {
  const bs = st.blocks.filter((b) => b.group === g);
  return { c0: Math.min(...bs.map((b) => b.col)), c1: Math.max(...bs.map((b) => b.col)), r0: Math.min(...bs.map((b) => b.row)), r1: Math.max(...bs.map((b) => b.row)) };
};
const myBbox = bboxOf(onto.body.state, mb);
const crowding = [...new Set(onto.body.state.blocks.map((b) => b.group))].filter((g) => g !== mb).filter((g) => {
  const o = bboxOf(onto.body.state, g);
  return myBbox.c0 <= o.c1 + 1 && myBbox.c1 >= o.c0 - 1 && myBbox.r0 <= o.r1 + 1 && myBbox.r1 >= o.r0 - 1;
});
check('dropped on the examples, it lands one cell clear of every box', [onto.status, crowding], [200, []]);
const at2 = cellsOf(onto.body.state);
check('and still in one piece', Math.abs(at2[0][0] - at2[1][0]) + Math.abs(at2[0][1] - at2[1][1]), 1);
await sleep(RL_WAIT);
for (const r of [m2, m1]) {
  const d = await sedit(mover, { op: 'delete', id: r.body.blockId, nonce: nonce('c11b', r.body.blockId) });
  check(`removed ${r.body.blockId}`, d.status, 200);
  await sleep(RL_WAIT);
}

section('[9] cleanup');
await sleep(RL_WAIT);
const cleanup = [
  [a2, id2],
  [inh, second.body.blockId],
  [inh, fi.body.blockId],
  [dA, c1.body.blockId],
  [dB, c2.body.blockId],
  [hasty, h1.body.blockId],
];
let lastDev = null;
for (const [dev, id] of cleanup) {
  if (dev === lastDev) await sleep(RL_WAIT);
  lastDev = dev;
  const r = await sedit(dev, { op: 'delete', id, nonce: nonce('clean', id) });
  check(`removed ${id}`, r.status, 200);
}
const st9 = await getSine();
check('no test block from this suite is left over',
  st9.blocks.filter((b) => b.name.startsWith('test ')).length, 0);

finish();
