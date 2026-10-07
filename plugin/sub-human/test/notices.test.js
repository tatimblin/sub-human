'use strict';
// Join / leave lines (lib/notices.js) and where they surface: the room monitor's chat lines (bin/sub-human
// tail), the room row text (lib/rows.js) and the room hold's progress line (mcp/hold.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const h = require('./helpers.js');
const notices = require(path.join(h.LIB, 'notices.js'));
const rows = require(path.join(h.LIB, 'rows.js'));
const room = require(path.join(h.LIB, 'room.js'));

const CODE = 'stoat-3644';
const T0 = Date.parse('2026-10-05T10:00:00.000Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const mv = (id, kind, from, s, text) => ({ id, at: at(s), from, via: 'system', kind, to: 'room', text: text || `${from} ${kind === 'member_left' ? 'left' : 'joined'}` });
const MEMBERS = { orch: { name: 'orch', role: 'orch' }, alice: { name: 'alice', role: 'member' }, bob: { name: 'bob', role: 'member' } };

test('notices.joinLeave: others only, leaves settle after 8 s, a quick leave + rejoin is no notice', () => {
  const es = [
    mv(1, 'member_joined', 'alice', 0), mv(2, 'member_joined', 'orch', 1), mv(3, 'member_joined', 'bob', 10),
    { id: 4, at: at(11), from: 'bob', via: 'human', kind: 'say', text: 'hi' },
    mv(5, 'member_left', 'bob', 20), mv(6, 'member_joined', 'bob', 25, 'bob rejoined'), // back in 5 s: nothing
    mv(7, 'member_left', 'bob', 40), mv(8, 'member_joined', 'bob', 60, 'bob rejoined (resumed)'), // away 20 s
    mv(9, 'member_left', 'bob', 100),
  ];
  const ns = notices.joinLeave(es, 'alice', { now: T0 + 104_000, settle: 8000 });
  assert.deepEqual(ns.map(n => [n.id, n.kind, n.settled, n.rejoin]), [
    [3, 'member_joined', true, false], [7, 'member_left', true, false], [8, 'member_joined', true, true], [9, 'member_left', false, false],
  ], 'own join, the orch, a say and the 5 s round trip are left out; #9 is still settling');
  assert.equal(notices.joinLeave(es, 'alice', { now: T0 + 108_000, settle: 8000 }).at(-1).settled, true);
  assert.deepEqual(notices.joinLeave(es, 'bob', { now: T0 + 200_000 }).map(n => n.id), [1], 'bob sees only alice');
});

test('notices.text and rowSegment: the one-line notice and the room row segment', () => {
  assert.equal(notices.text({ kind: 'member_joined', name: 'bob' }), 'bob joined');
  assert.equal(notices.text({ kind: 'member_joined', name: 'bob', rejoin: true }), 'bob rejoined');
  assert.equal(notices.text({ kind: 'member_left', name: 'bob' }), 'bob left');
  const es = [mv(1, 'member_joined', 'bob', 0)];
  assert.equal(notices.rowSegment(es, 'alice', { now: T0 + 5_000 }), '+bob joined');
  assert.equal(notices.rowSegment(es, 'alice', { now: T0 + 130_000 }), '', 'gone after 2 minutes');
  assert.equal(notices.rowSegment(es, 'bob', { now: T0 + 5_000 }), '', 'not my own join');
  es.push(mv(2, 'member_left', 'bob', 30));
  assert.equal(notices.rowSegment(es, 'alice', { now: T0 + 33_000 }), '+bob joined', 'the leave is still settling');
  assert.equal(notices.rowSegment(es, 'alice', { now: T0 + 39_000 }), '−bob left');
});

test('rows.rowText: the room row leads with a recent join', () => {
  const es = [mv(1, 'member_joined', 'alice', 0), mv(2, 'member_joined', 'bob', 10)];
  const t = rows.rowText(CODE, CODE, 'alice', { entries: es, members: MEMBERS, now: T0 + 12_000, taskSummary: '' });
  assert.equal(t, '+bob joined · 2 here');
  assert.equal(rows.rowText(CODE, CODE, 'alice', { entries: es, members: MEMBERS, now: T0 + 400_000, taskSummary: '' }), '2 here');
});

test('notices shown / markShown: ids merge and sort; via is required', () => {
  h.freshHome();
  const code = h.newRoom();
  assert.deepEqual([...notices.shown(code, 'alice')], []);
  notices.markShown(code, 'alice', [3], 'monitor');
  notices.markShown(code, 'alice', [5, 3], 'prompt');
  notices.markShown(code, 'alice', [7], 'mod'); // tail --ndjson (the hooks module's chat events)
  assert.deepEqual([...notices.shown(code, 'alice')], [3, 5, 7]);
  assert.throws(() => notices.markShown(code, 'alice', [6]), /via/);
  assert.throws(() => notices.markShown(code, 'alice', [6], 'model'), /via/);
});

// ---------- the room hold's progress line ----------
test('hold {room}: joins and settled leaves show as notices on the progress line; a quick round trip shows nothing', async () => {
  const ENV = { SUB_HUMAN_HOLD_POLL_MS: '20', SUB_HUMAN_HOLD_GRACE_MS: '100000', SUB_HUMAN_HOLD_WHO_MS: '20', SUB_HUMAN_LEAVE_MS: '300' };
  const old = Object.fromEntries(Object.keys(ENV).map(k => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  try {
  const hold = require(path.join(h.PLUGIN, 'mcp', 'hold.js'));
  const identity = require(path.join(h.LIB, 'identity.js'));
  process.env.SUB_HUMAN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-notice-hold-'));
  const dir = path.join(process.env.SUB_HUMAN_HOME, 'rooms', CODE);
  fs.mkdirSync(dir, { recursive: true });
  const ms = { orch: { name: 'orch', role: 'orch' }, alice: { name: 'alice', role: 'member' }, bob: { name: 'bob', role: 'member' } };
  const save = () => fs.writeFileSync(path.join(dir, 'members.json'), JSON.stringify(ms));
  save();
  let id = 0;
  const add = (from, kind, text) => fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ id: ++id, at: new Date().toISOString(), from, via: 'system', kind, to: 'room', text }) + '\n');
  add('alice', 'member_joined', 'alice joined');
  const progress = []; // the room hold's line only (bob's row streams his own thread)
  const me = { code: CODE, name: 'alice', role: 'member' };
  let who = me;
  const plug = hold.create({ identity, whoami: () => who, progress: (t, n, m) => { if (t === 'r') progress.push(m); }, onCancel: () => {}, log: () => {}, text: s => ({ content: [{ type: 'text', text: s }] }) });
  // bob's row is already held, so the room hold does not return JOINED for him
  const b = plug.call('hold', me, { member: 'bob' }, { id: 1, progressToken: 'b' });
  const r = plug.call('hold', me, { room: CODE }, { id: 2, progressToken: 'r' });
  await h.sleep(60);
  add('bob', 'member_joined', 'bob joined');
  await h.until(() => progress.some(m => m.startsWith('bob joined')), 2000);
  assert.ok(progress.some(m => m === `bob joined${hold.HINT}`), progress.join('\n'));
  assert.ok(!progress.some(m => /member_joined/.test(m)), 'no raw member_joined line');
  const n = progress.length;
  add('bob', 'member_left', 'bob left'); ms.bob.left_at = new Date().toISOString(); save();
  await h.sleep(100);
  add('bob', 'member_joined', 'bob rejoined'); delete ms.bob.left_at; save();
  await h.sleep(500);
  assert.ok(!progress.slice(n).some(m => /bob left|bob rejoined|member_left/.test(m)), progress.slice(n).join('\n'));
  add('bob', 'member_left', 'bob left'); ms.bob.left_at = new Date().toISOString(); save();
  await h.sleep(100);
  assert.ok(!progress.some(m => m.startsWith('bob left')), 'not before it settles');
  await h.until(() => progress.some(m => m.startsWith('bob left')), 2000);
  assert.ok(progress.some(m => m === `bob left${hold.HINT}`));
  who = null; // this seat leaves: both holds end
  const ends = await Promise.race([Promise.all([b, r]), h.sleep(1000).then(() => null)]);
  assert.ok(ends && ends.every(x => /^STOP/.test(x.content[0].text)), 'both holds return STOP');
  } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ---------- the room monitor prints joins and leaves as chat lines ----------
const FAST = { CLAUDE_PID: String(process.pid), SUB_HUMAN_RESOLVE_MS: '100', SUB_HUMAN_UNSEATED_MS: '100', SUB_HUMAN_POLL_MS: '50', SUB_HUMAN_SETTLE_MS: '300', SUB_HUMAN_SETTLE_MAX_MS: '1000', SUB_HUMAN_LEAVE_MS: '600' };
function startTail() {
  const child = spawn(h.BIN, ['tail'], { env: h.childEnv(FAST) });
  const t = { child, out: '' };
  child.stdout.on('data', d => { t.out += d; });
  return t;
}
const sys = (kind, from, text) => room.append({ kind, text: text || `${from} ${kind}` }, { via: 'system', from, system: true });

test('cli tail (member): a join and a settled leave are chat lines on stdout; a quick round trip prints nothing', async () => {
  h.freshHome();
  const code = h.newRoom();
  room.bind(code);
  h.register('alice', 'member', process.pid, code);
  sys('member_joined', 'alice');
  rows.writeHolds(code, 'alice', { room: true, members: ['bob'] }); // her rows run: no row note is pushed
  const t = startTail();
  try {
    await h.sleep(400);
    sys('member_joined', 'bob', 'bob joined');                 // #2
    await h.until(() => t.out === 'bob joined\n', 3000);
    assert.equal(t.out, 'bob joined\n');
    assert.deepEqual([...notices.shown(code, 'alice')], [2], 'recorded as shown (via monitor)');
    sys('member_left', 'bob', 'bob left');                     // #3
    await h.sleep(200);
    sys('member_joined', 'bob', 'bob rejoined');               // #4, 200 ms later: neither is a line
    await h.sleep(1200);
    assert.equal(t.out, 'bob joined\n');
    sys('member_left', 'bob', 'bob left');                     // #5
    await h.sleep(300);
    assert.equal(t.out, 'bob joined\n', 'still settling');
    await h.until(() => t.out.includes('bob left'), 3000);
    assert.equal(t.out, 'bob joined\nbob left\n');
  } finally { t.child.kill(); }
});
