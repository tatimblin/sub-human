'use strict';
// mcp/hold.js through its plug-in contract (create(ctx) -> {tools, call}) with a fake ctx: streaming,
// STOP on leave, JOINED / RESPAWN for the member's room row, duplicate holds, and cancel handling.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..');
Object.assign(process.env, {
  SUB_HUMAN_HOLD_BEAT_MS: '150', SUB_HUMAN_HOLD_POLL_MS: '20', SUB_HUMAN_HOLD_GRACE_MS: '250',
  SUB_HUMAN_HOLD_RESPAWN_MS: '60', SUB_HUMAN_HOLD_WHO_MS: '20',
});
const identity = require(path.join(PLUGIN, 'lib', 'identity.js'));
const rows = require(path.join(PLUGIN, 'lib', 'rows.js'));
const hold = require(path.join(PLUGIN, 'mcp', 'hold.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const textOf = r => r && r.content && r.content[0] && r.content[0].text;

/** A room written by hand, and a fake room-server ctx for seat `self`. */
function setup(names, self) {
  process.env.SUB_HUMAN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-hold-'));
  const code = 'marmot-2509';
  const dir = path.join(process.env.SUB_HUMAN_HOME, 'rooms', code);
  fs.mkdirSync(dir, { recursive: true });
  const ms = {};
  for (const n of names) ms[n] = { name: n, role: n === 'orch' ? 'orch' : 'member', joined_at: new Date().toISOString() };
  const save = () => fs.writeFileSync(path.join(dir, 'members.json'), JSON.stringify(ms));
  save();
  let id = 0;
  const add = (from, kind, extra = {}) => fs.appendFileSync(path.join(dir, 'log.jsonl'),
    JSON.stringify({ id: ++id, at: new Date().toISOString(), from, via: 'human', kind, text: `${kind} ${id}`, to: 'room', ...extra }) + '\n');
  let me = { code, name: self, role: self === 'orch' ? 'orch' : 'member' };
  const progress = [];
  const cancels = new Map();
  const ctx = {
    identity, whoami: () => me, progress: (token, n, message) => progress.push({ token, n, message }),
    onCancel: (rid, fn) => cancels.set(rid, fn), text: (s, isError) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) }),
    log: () => {},
  };
  const plug = hold.create(ctx);
  let rid = 0;
  const call = args => { const meta = { id: ++rid, progressToken: `t${rid}` }; return { id: rid, p: Promise.resolve(plug.call('hold', me, args, meta)) }; };
  return {
    code, dir, ms, save, add, progress, plug, call, cancel: r => cancels.get(r)(),
    leaveMe: () => { me = null; },
    join: n => { ms[n] = { name: n, role: 'member', joined_at: new Date().toISOString() }; save(); },
    leave: n => { ms[n].left_at = new Date().toISOString(); save(); },
  };
}
const pending = async (p, ms = 80) => (await Promise.race([p.then(() => 'done'), sleep(ms).then(() => 'pending')])) === 'pending';

test('hold: tool definition and argument errors', async () => {
  const w = setup(['orch', 'alice'], 'orch');
  assert.deepEqual(w.plug.tools.map(t => t.name), ['hold']);
  assert.equal(w.plug.call('nope', null, {}, {}), null);
  assert.match(textOf(await w.call({}).p), /hold needs/);
  assert.match(textOf(await w.call({ member: 'zed' }).p), /^STOP: zed is not in room/);
  assert.match(textOf(await w.call({ member: 'orch' }).p), /^STOP: that is you/);
  assert.match(textOf(await w.call({ member: '../x' }).p), /^STOP/);
  assert.match(textOf(await w.call({ room: 'otter-1111' }).p), /^STOP: you are in room marmot-2509/);
  w.leaveMe();
  assert.match(textOf(await Promise.resolve(w.plug.call('hold', null, { member: 'alice' }, { id: 99 }))), /^STOP: not in a room/);
});

test('hold {member}: blocks with progress, streams the thread, dedupes, STOPs when the member leaves', async () => {
  const w = setup(['orch', 'alice', 'bob'], 'orch');
  w.add('alice', 'say');
  const a = w.call({ member: 'alice' });
  assert.ok(await pending(a.p), 'blocks');
  assert.equal(w.progress[0].token, `t${a.id}`);
  assert.match(w.progress[0].message, /^#1 alice · say: say 1$/);
  w.add('bob', 'say');                       // not alice's thread
  w.add('orch', 'question', { via: 'agent', to: 'alice' });
  await sleep(80);
  assert.match(w.progress.at(-1).message, /^#3 facilitator → alice · question/);
  assert.ok(!w.progress.some(p => /#2/.test(p.message)), 'other threads are not streamed');
  const n = w.progress.length;
  await sleep(250);
  assert.ok(w.progress.length > n, 'heartbeat keeps the idle timeout away');
  assert.match(textOf(await w.call({ member: 'alice' }).p), /already open/, 'one row per member');
  assert.deepEqual(rows.readHolds(w.code, 'orch').members, ['alice']);
  w.add('alice', 'member_left', { via: 'system' });
  w.leave('alice');
  assert.match(textOf(await a.p), /^STOP: alice left room marmot-2509/);
  await sleep(150);
  assert.deepEqual(rows.readHolds(w.code, 'orch').members, []);
});

test('hold: every hold STOPs when this seat leaves the room', async () => {
  const w = setup(['orch', 'alice', 'bob'], 'alice');
  const b = w.call({ member: 'bob' });
  const r = w.call({ room: w.code });
  assert.ok(await pending(r.p));
  w.leaveMe();
  assert.match(textOf(await b.p), /^STOP: alice is no longer in room/);
  assert.match(textOf(await r.p), /^STOP/);
});

test('hold {room}: children spawned with it are not announced; a newcomer is JOINED; one that never shows is re-announced', async () => {
  const w = setup(['orch', 'alice', 'bob', 'carol'], 'alice');
  const r1 = w.call({ room: w.code });
  await sleep(30);
  const b = w.call({ member: 'bob' });       // carol's row never shows up
  assert.ok(await pending(r1.p, 120), 'within the grace period nobody is missing');
  w.join('dave');
  assert.equal(textOf(await r1.p), 'JOINED dave');
  const r2 = w.call({ room: w.code });
  const d = w.call({ member: 'dave' });
  const t = textOf(await r2.p);
  assert.equal(t, 'JOINED carol', 'carol was expected but never held: announced after the grace period');
  assert.ok(await pending(b.p) && await pending(d.p));
});

test('hold {room}: RESPAWN when a child row is cancelled (Esc-kill); not when the room dies too', async () => {
  const w = setup(['orch', 'alice', 'bob', 'carol'], 'alice');
  const r1 = w.call({ room: w.code });
  const b = w.call({ member: 'bob' });
  const c = w.call({ member: 'carol' });
  assert.ok(await pending(r1.p));
  w.cancel(b.id);
  assert.equal(textOf(await r1.p), 'RESPAWN bob');
  const r2 = w.call({ room: w.code });
  const b2 = w.call({ member: 'bob' });
  assert.ok(await pending(r2.p, 300), 'the respawned bob is held: nothing to report');
  // Room killed: its cancel and its children's arrive together; nothing is respawned.
  w.cancel(c.id);
  w.cancel(r2.id);
  w.cancel(b2.id);
  await sleep(200);
  const r3 = w.call({ room: w.code });       // main re-spawns the room, which spawns its children itself
  w.call({ member: 'bob' }); w.call({ member: 'carol' });
  assert.ok(await pending(r3.p, 300), 'no stale RESPAWN after a cascade');
});

test('hold {room}: a respawn that lands while the room is re-calling is delivered on the next call', async () => {
  const w = setup(['orch', 'alice', 'bob', 'carol'], 'alice');
  const r1 = w.call({ room: w.code });
  const b = w.call({ member: 'bob' });
  w.call({ member: 'carol' });
  await sleep(30);
  w.join('dave');
  assert.equal(textOf(await r1.p), 'JOINED dave');
  w.cancel(b.id);                            // the room is between calls
  await sleep(120);
  w.call({ member: 'dave' });
  assert.equal(textOf(await w.call({ room: w.code }).p), 'RESPAWN bob');
});

test('hold {member} on the orch side: a cancelled row is simply dropped', async () => {
  const w = setup(['orch', 'alice'], 'orch');
  const a = w.call({ member: 'alice' });
  await sleep(30);
  w.cancel(a.id);
  assert.equal(textOf(await a.p), '(cancelled)');
  const a2 = w.call({ member: 'alice' });
  assert.ok(await pending(a2.p), 'a new row for alice may hold again');
  w.leave('alice');
  assert.match(textOf(await a2.p), /^STOP/);
});
