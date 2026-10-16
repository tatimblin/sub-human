// mcp/hold.ts through its plug-in contract (create(ctx) -> {tools, call}) with a fake ctx: streaming,
// STOP on leave, JOINED / RESPAWN for the member's room row, duplicate holds, and cancel handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as identity from '../lib/identity.ts';
import * as rows from '../lib/rows.ts';
import * as hold from '../mcp/hold.ts';
import * as linkStateMod from '../lib/room/link-state.ts';
import * as seatKey from '../hooks/seat-key.ts';
import type { JsonRpcId, Me, ProgressToken, ToolArgs, ToolResult } from '../mcp/types.ts';
import type { LinkState, Member } from '../lib/room/types.ts';
import { rc, sn } from './support/brands.ts';

Object.assign(process.env, {
  SUB_HUMAN_HOLD_BEAT_MS: '150', SUB_HUMAN_HOLD_POLL_MS: '20', SUB_HUMAN_HOLD_GRACE_MS: '250',
  SUB_HUMAN_HOLD_RESPAWN_MS: '60', SUB_HUMAN_HOLD_WHO_MS: '20',
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// the calls under test answer with text; a missing one fails the assertion that reads it
const textOf = (r: ToolResult | null | undefined): string => (r && r.content && r.content[0] && r.content[0].text) as string;

type HoldCtx = Parameters<typeof hold.create>[0];
/** The fake seat: only the fields hold reads (the full Me also carries session_id, pid, address). */
type FakeMe = Pick<Me, 'code' | 'name' | 'role'>;
interface Progress { token: ProgressToken | null | undefined; n: number; message: string }

/** A room written by hand, and a fake room-server ctx for seat `self`. */
function setup(names: string[], self: string) {
  process.env.SUB_HUMAN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-hold-'));
  const code = rc('marmot-2509');
  const dir = path.join(process.env.SUB_HUMAN_HOME, 'rooms', code);
  fs.mkdirSync(dir, { recursive: true });
  const ms: Record<string, Partial<Member>> = {};
  for (const n of names) ms[n] = { name: sn(n), role: n === 'claude' ? 'claude' : 'member', joined_at: new Date().toISOString() };
  const save = () => fs.writeFileSync(path.join(dir, 'members.json'), JSON.stringify(ms));
  save();
  let id = 0;
  // signed as the at-room hook signs a person's post (hooks/seat-key.ts), so it reads as theirs, not "(unverified)"
  const add = (from: string, kind: string, extra: Record<string, unknown> = {}) => {
    const e: Record<string, unknown> = { id: ++id, at: new Date().toISOString(), from, via: 'human', kind, text: `${kind} ${id}`, to: 'room', ...extra };
    if (e.via === 'human') { e.room = code; e.sig = crypto.sign(null, Buffer.from(JSON.stringify(e)), seatKey.ensure(code, sn(from))).toString('base64'); }
    fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify(e) + '\n');
  };
  let me: FakeMe | null = { code, name: sn(self), role: self === 'claude' ? 'claude' : 'member' };
  const progress: Progress[] = [];
  const cancels = new Map<JsonRpcId, (reason?: unknown) => void>();
  const ctx: HoldCtx = {
    identity, whoami: () => me as Me | null, progress: (token, n, message) => progress.push({ token, n, message: message as string }), // hold always sends one
    onCancel: (rid, fn) => cancels.set(rid, fn), text: (s, isError) => ({ content: [{ type: 'text', text: s as string }], ...(isError ? { isError: true } : {}) }),
    log: () => {},
  };
  const plug = hold.create(ctx);
  let rid = 0;
  const call = (args: ToolArgs) => { const meta = { id: ++rid, progressToken: `t${rid}` }; return { id: rid, p: Promise.resolve(plug.call('hold', me as Me | null, args, meta)) }; };
  return {
    code, dir, ms, save, add, progress, plug, call, cancel: (r: JsonRpcId) => cancels.get(r)!(),
    leaveMe: () => { me = null; },
    join: (n: string) => { ms[n] = { name: sn(n), role: 'member', joined_at: new Date().toISOString() }; save(); },
    leave: (n: string) => { ms[n].left_at = new Date().toISOString(); save(); },
  };
}
const pending = async (p: Promise<unknown>, ms = 80) => (await Promise.race([p.then(() => 'done'), sleep(ms).then(() => 'pending')])) === 'pending';

test('hold: tool definition and argument errors', async () => {
  const w = setup(['claude', 'alice'], 'claude');
  assert.deepEqual(w.plug.tools.map(t => t.name), ['hold']);
  assert.equal(w.plug.call('nope', null, {}, {}), null);
  const bad = await w.call({}).p;
  assert.match(textOf(bad), /hold needs/);
  assert.equal(bad!.isError, true, 'a call without member or room is refused as an error');
  const stop = await w.call({ member: sn('zed') }).p;
  assert.match(textOf(stop), /^STOP: zed is not in room/);
  assert.equal(stop!.isError, undefined, 'a STOP is an answer for the row, not an error');
  assert.match(textOf(await w.call({ member: sn('claude') }).p), /^STOP: that is you/);
  assert.match(textOf(await w.call({ member: '../x' }).p), /^STOP/);
  assert.match(textOf(await w.call({ room: rc('otter-1111') }).p), /^STOP: you are in room marmot-2509/);
  w.leaveMe();
  assert.match(textOf(await Promise.resolve(w.plug.call('hold', null, { member: sn('alice') }, { id: 99 }))), /^STOP: not in a room/);
});

test('hold {member}: blocks with progress, streams the thread, refuses a duplicate, keeps holding when the member leaves', async () => {
  const w = setup(['claude', 'alice', 'bob'], 'claude');
  w.add('alice', 'say');
  const a = w.call({ member: sn('alice') });
  assert.ok(await pending(a.p), 'blocks');
  assert.equal(w.progress[0].token, `t${a.id}`);
  assert.equal(w.progress[0].message, `alice: say 1${hold.HINT}`);
  assert.match(hold.HINT, /read-only · talk in main \(@room\)$/);
  w.add('bob', 'say');                       // not alice's thread
  w.add('claude', 'question', { via: 'agent', to: 'alice' });
  await sleep(80);
  assert.match(w.progress.at(-1)!.message, /^claude \(to alice\): question 3/);
  assert.ok(!w.progress.some(p => /^bob/.test(p.message)), 'other threads are not streamed');
  const n = w.progress.length;
  await sleep(250);
  assert.ok(w.progress.length > n, 'heartbeat keeps the idle timeout away');
  assert.match(textOf(await w.call({ member: sn('alice') }).p), /^STOP: duplicate row: alice's row is already open/, 'one row per member');
  assert.deepEqual(rows.readHolds(w.code, sn('claude'))!.members, ['alice']);
  w.add('alice', 'member_left', { via: 'system' });
  w.leave('alice');
  assert.ok(await pending(a.p, 200), 'the row outlives the leave (it reads "left")');
  assert.match(w.progress.at(-1)!.message, /^alice left/);
  assert.deepEqual(rows.readHolds(w.code, sn('claude'))!.members, ['alice']);
});

test('hold: duplicate holds are refused for both kinds; the first one stays', async () => {
  const w = setup(['claude', 'alice', 'bob'], 'alice');
  const r1 = w.call({ room: w.code });
  const b1 = w.call({ member: sn('bob') });
  assert.ok(await pending(r1.p) && await pending(b1.p));
  assert.match(textOf(await w.call({ room: w.code }).p), /^STOP: duplicate row: room marmot-2509 already has its row/, 'room row re-spawned after /clear');
  assert.match(textOf(await w.call({ member: sn('bob') }).p), /^STOP: duplicate row/);
  assert.ok(await pending(r1.p) && await pending(b1.p), 'the originals keep holding');
  assert.deepEqual(rows.readHolds(w.code, sn('alice')), { ...rows.readHolds(w.code, sn('alice')), members: ['bob'], room: true });
});

test('hold: leave + rejoin keeps one hold per member, announces nothing, and spawns no second row', async () => {
  const w = setup(['claude', 'alice', 'bob'], 'alice');
  const r1 = w.call({ room: w.code });
  const b1 = w.call({ member: sn('bob') });
  await sleep(30);
  w.add('bob', 'member_left', { via: 'system' });
  w.leave('bob');
  await sleep(100);
  w.join('bob');                             // rejoin: same name, left_at cleared
  w.add('bob', 'member_joined', { via: 'system' });
  assert.ok(await pending(r1.p, 500), 'no JOINED for a member whose row is still held (well past the grace period)');
  assert.ok(await pending(b1.p), 'the same row is live again');
  assert.match(textOf(await w.call({ member: sn('bob') }).p), /^STOP: duplicate row/);
  assert.deepEqual(rows.readHolds(w.code, sn('alice'))!.members, ['bob']);
  // A row spawned for a member who already left still holds (reads "left") instead of finishing at once.
  w.leave('bob');
  w.cancel(b1.id);
  await sleep(150);
  const b2 = w.call({ member: sn('bob') });
  assert.ok(await pending(b2.p), 'a left member is still a row');
  w.leaveMe();
  assert.match(textOf(await b2.p), /^STOP: alice is no longer in room/, 'it ends when the viewer leaves');
  assert.match(textOf(await r1.p), /^STOP/);
});

test('hold: every hold STOPs when this seat leaves the room', async () => {
  const w = setup(['claude', 'alice', 'bob'], 'alice');
  const b = w.call({ member: sn('bob') });
  const r = w.call({ room: w.code });
  assert.ok(await pending(r.p));
  w.leaveMe();
  assert.match(textOf(await b.p), /^STOP: alice is no longer in room/);
  assert.match(textOf(await r.p), /^STOP/);
});

test('hold {room}: children spawned with it are not announced; a newcomer is JOINED; one that never shows is re-announced', async () => {
  const w = setup(['claude', 'alice', 'bob', 'carol'], 'alice');
  const r1 = w.call({ room: w.code });
  await sleep(30);
  const b = w.call({ member: sn('bob') });       // carol's row never shows up
  assert.ok(await pending(r1.p, 120), 'within the grace period nobody is missing');
  w.join('dave');
  assert.equal(textOf(await r1.p), 'JOINED dave');
  const r2 = w.call({ room: w.code });
  const d = w.call({ member: sn('dave') });
  const t = textOf(await r2.p);
  assert.equal(t, 'JOINED carol', 'carol was expected but never held: announced after the grace period');
  assert.ok(await pending(b.p) && await pending(d.p));
});

test('hold {room}: RESPAWN when a child row is cancelled (Esc-kill); not when the room dies too', async () => {
  const w = setup(['claude', 'alice', 'bob', 'carol'], 'alice');
  const r1 = w.call({ room: w.code });
  const b = w.call({ member: sn('bob') });
  const c = w.call({ member: sn('carol') });
  assert.ok(await pending(r1.p));
  w.cancel(b.id);
  assert.equal(textOf(await r1.p), 'RESPAWN bob');
  const r2 = w.call({ room: w.code });
  const b2 = w.call({ member: sn('bob') });
  assert.ok(await pending(r2.p, 300), 'the respawned bob is held: nothing to report');
  // Room killed: its cancel and its children's arrive together; nothing is respawned.
  w.cancel(c.id);
  w.cancel(r2.id);
  w.cancel(b2.id);
  await sleep(200);
  const r3 = w.call({ room: w.code });       // main re-spawns the room, which spawns its children itself
  w.call({ member: sn('bob') }); w.call({ member: sn('carol') });
  assert.ok(await pending(r3.p, 300), 'no stale RESPAWN after a cascade');
});

test('hold {room}: a respawn that lands while the room is re-calling is delivered on the next call', async () => {
  const w = setup(['claude', 'alice', 'bob', 'carol'], 'alice');
  const r1 = w.call({ room: w.code });
  const b = w.call({ member: sn('bob') });
  w.call({ member: sn('carol') });
  await sleep(30);
  w.join('dave');
  assert.equal(textOf(await r1.p), 'JOINED dave');
  w.cancel(b.id);                            // the room is between calls
  await sleep(120);
  w.call({ member: sn('dave') });
  assert.equal(textOf(await w.call({ room: w.code }).p), 'RESPAWN bob');
});

test('hold {member} on the room\'s Claude side: a cancelled row is simply dropped', async () => {
  const w = setup(['claude', 'alice'], 'claude');
  const a = w.call({ member: sn('alice') });
  await sleep(30);
  w.cancel(a.id);
  assert.equal(textOf(await a.p), '(cancelled)');
  const a2 = w.call({ member: sn('alice') });
  assert.ok(await pending(a2.p), 'a new row for alice may hold again');
  w.leaveMe();
  assert.match(textOf(await a2.p), /^STOP/);
});

test('hold {room}: after JOINED the room row still reads as running while it re-calls (no second room row invited)', async () => {
  process.env.SUB_HUMAN_HOLD_ROOM_GAP_MS = '300';
  try {
    // seat "erin": earlier tests' hold servers still tick for "alice" and share SUB_HUMAN_HOME lookups
    const w = setup(['claude', 'erin', 'bob'], 'erin');
    const me = { code: w.code, name: sn('erin'), role: 'member' } as Me; // the fields joinNote and rowsNeeded read
    const r1 = w.call({ room: w.code });
    w.call({ member: sn('bob') });
    await sleep(40);
    assert.equal(rows.readHolds(w.code, sn('erin'))!.room, true);
    w.join('carol');
    assert.equal(textOf(await r1.p), 'JOINED carol');
    const h = rows.readHolds(w.code, sn('erin'))!;
    assert.equal(h.room, true, 'between the return and the re-call');
    assert.match(rows.joinNote(me, 'carol'), /your room row adds carol by itself; make NO Agent call/);
    assert.deepEqual(rows.rowsNeeded(w.code, me, { held: h }), []);
    w.call({ member: sn('carol') });
    await sleep(350);
    assert.equal(rows.readHolds(w.code, sn('erin'))!.room, false, 'never re-called within the gap: not running');
    const r2 = w.call({ room: w.code });
    assert.ok(await pending(r2.p, 40));
    assert.equal(rows.readHolds(w.code, sn('erin'))!.room, true);
    w.cancel(r2.id);
    assert.equal(rows.readHolds(w.code, sn('erin'))!.room, false, 'an Esc-killed room row is not running');
  } finally { delete process.env.SUB_HUMAN_HOLD_ROOM_GAP_MS; }
});

test('hold: every progress line ends with the read-only hint and stays within 140 chars + hint', async () => {
  const w = setup(['claude', 'alice', 'bob'], 'alice');
  const r = w.call({ room: w.code });
  w.call({ member: sn('bob') });
  await sleep(30);
  w.add('bob', 'say', { text: 'y'.repeat(500) });
  await sleep(200);
  assert.ok(w.progress.length > 0);
  for (const p of w.progress) {
    assert.ok(p.message.endsWith(hold.HINT), p.message);
    assert.ok(Array.from(p.message).length <= 140 + hold.HINT.length);
  }
  w.leaveMe();
  await r.p;
});

test('hold: a post marked provisional (old logs) shows at once, like any other', async () => {
  const w = setup(['claude', 'alice'], 'claude');
  const a = w.call({ member: sn('alice') });
  assert.ok(await pending(a.p));
  w.add('alice', 'say', { provisional: true }); // #1
  await sleep(100);
  assert.match(w.progress.at(-1)!.message, /^alice: say 1/);
  w.leaveMe();
  await a.p;
});

test('hold (item 15): removed by the host (a kick), the rows keep holding (they show it), so none hands "left" back to the kicked person\'s Claude', async () => {
  const w = setup(['claude', 'alice', 'bob'], 'alice');
  const real = linkStateMod.seam.read;
  linkStateMod.seam.read = (c: string) => (c === w.code ? { state: 'stopped', lastReason: 'LINK_REVOKED', lastError: 'the host removed this machine' } as LinkState : null);
  try {
    const b = w.call({ member: sn('bob') });
    const r = w.call({ room: w.code });
    assert.ok(await pending(r.p));
    w.leaveMe();
    assert.ok(await pending(b.p, 400), 'the member row holds');
    assert.ok(await pending(r.p, 50), 'the room row holds');
  } finally { linkStateMod.seam.read = real; }
});
