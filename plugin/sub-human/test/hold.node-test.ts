// mcp/hold.ts through its plug-in contract (create(ctx) -> {tools, call}) with a fake ctx: the one room row's hold,
// streaming, STOP on leave, a duplicate refused, and cancel handling.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as identity from '../lib/identity.ts';
import * as hold from '../mcp/hold.ts';
import * as linkStateMod from '../lib/room/link-state.ts';
import * as seatKey from '../hooks/seat-key.ts';
import * as envelope from '../lib/room/envelope.ts';
import type { JsonRpcId, Me, ProgressToken, ToolArgs, ToolResult } from '../mcp/types.ts';
import type { LinkState, Member } from '../lib/room/types.ts';
import { rc, sn } from './support/brands.ts';
import { must } from './support/must.ts';

// The hold's poll timer is unref'd (mcp/hold.ts; in the server, stdin keeps the process alive). Node 22's test runner
// ends a test whose only pending work is an unref'd timer, so this keeps the loop alive while these tests run.
const alive = setInterval(() => {}, 1 << 30);
after(() => clearInterval(alive));

Object.assign(process.env, {
  SUB_HUMAN_HOLD_BEAT_MS: '150', SUB_HUMAN_HOLD_POLL_MS: '20', SUB_HUMAN_HOLD_WHO_MS: '20',
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
    const p: Record<string, unknown> = { from, via: 'human', kind, text: `${kind} ${++id}`, to: 'room', ...extra };
    const e = { id, at: new Date().toISOString(), ...(p.via === 'human' ? envelope.sign(p, seatKey.ensure(code, sn(from)), { room: code, from }) : p) };
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
    code, dir, ms, save, add, progress, plug, call, cancel: (r: JsonRpcId) => must(cancels.get(r))(),
    leaveMe: () => { me = null; },
    join: (n: string) => { ms[n] = { name: sn(n), role: 'member', joined_at: new Date().toISOString() }; save(); },
    leave: (n: string) => { must(ms[n]).left_at = new Date().toISOString(); save(); },
  };
}
const pending = async (p: Promise<unknown>, ms = 80) => (await Promise.race([p.then(() => 'done'), sleep(ms).then(() => 'pending')])) === 'pending';

test('hold: tool definition and argument errors', async () => {
  const w = setup(['claude', 'alice'], 'alice');
  assert.deepEqual(w.plug.tools.map(t => t.name), ['hold']);
  assert.deepEqual(Object.keys(must(w.plug.tools[0]).inputSchema.properties ?? {}), ['room'], 'the room row only');
  assert.equal(w.plug.call('nope', null, {}, {}), null);
  const bad = await w.call({}).p;
  assert.match(textOf(bad), /hold needs/);
  assert.equal(must(bad).isError, true, 'a call without room is refused as an error');
  const old = await w.call({ member: sn('claude') }).p;
  assert.match(textOf(old), /^STOP: rows are one room row now/, "an older version's participant row ends");
  assert.equal(must(old).isError, undefined, 'a STOP is an answer for the row, not an error');
  assert.match(textOf(await w.call({ room: rc('otter-1111') }).p), /^STOP: you are in room marmot-2509/);
  w.leaveMe();
  assert.match(textOf(await Promise.resolve(w.plug.call('hold', null, { room: w.code }, { id: 99 }))), /^STOP: not in a room/);
});

test('hold {room}: blocks with progress, streams the room\'s latest line and its joins, keeps the idle timeout away', async () => {
  const w = setup(['claude', 'alice', 'bob'], 'alice');
  w.add('bob', 'say');
  const r = w.call({ room: w.code });
  assert.ok(await pending(r.p), 'blocks');
  assert.equal(must(w.progress[0]).token, `t${r.id}`);
  assert.equal(must(w.progress[0]).message, `bob here · bob: say 1${hold.HINT}`);
  assert.match(hold.HINT, /read-only · talk in main \(@room\)$/);
  w.add('bob', 'say');
  await sleep(80);
  assert.match(must(w.progress.at(-1)).message, /^bob here · bob: say 2/);
  const n = w.progress.length;
  await sleep(250);
  assert.ok(w.progress.length > n, 'heartbeat keeps the idle timeout away');
  w.join('carol');
  w.add('carol', 'member_joined', { via: 'system' });
  await sleep(120);
  assert.ok(await pending(r.p), 'a join never ends the hold: no model turn for it');
  assert.match(must(w.progress.at(-1)).message, /^bob, carol here · /, 'the row says who is here now (never the spawn\'s label)');
  w.leaveMe();
  assert.match(textOf(await r.p), /^STOP: alice is no longer in room/);
});

test('hold: the row leads with who else is here and what their presence says; a presence older than PRESENCE_STALE_MS says nothing', async () => {
  const w = setup(['claude', 'alice', 'bob', 'carol'], 'alice');
  assert.equal(identity.writePresence(w.code, sn('bob'), { state: 'working' }), true);
  assert.equal(identity.writePresence(w.code, sn('carol'), { state: 'error', detail: 'rate_limit' }), true);
  const r = w.call({ room: w.code });
  assert.ok(await pending(r.p));
  assert.equal(must(w.progress[0]).message, `bob (working), carol (stalled: rate_limit) here · room ${w.code}${hold.HINT}`);
  // carol's presence is old: her name alone; bob back at his prompt (idle): his name alone
  const old = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
  fs.writeFileSync(path.join(w.dir, 'presence', 'carol.json'), JSON.stringify({ state: 'error', at: old, detail: 'rate_limit' }));
  identity.writePresence(w.code, sn('bob'), { state: 'idle' });
  await sleep(120);
  assert.match(must(w.progress.at(-1)).message, /^bob, carol here · /);
  w.leaveMe();
  await r.p;
});

test('hold: a second room row is refused; the first one stays', async () => {
  const w = setup(['claude', 'alice', 'bob'], 'alice');
  const r1 = w.call({ room: w.code });
  assert.ok(await pending(r1.p));
  assert.match(textOf(await w.call({ room: w.code }).p), /^STOP: duplicate row: room marmot-2509 already has its row/, 'a second spawn (a /clear, a reload) ends');
  assert.ok(await pending(r1.p), 'the original keeps holding');
  w.cancel(r1.id);
  assert.equal(textOf(await r1.p), '(cancelled)');
  const r2 = w.call({ room: w.code });
  assert.ok(await pending(r2.p), 'once it is gone (Esc-kill), a new room row holds');
  w.leaveMe();
  assert.match(textOf(await r2.p), /^STOP/);
});

test('hold: every progress line ends with the read-only hint and stays within 140 chars + hint', async () => {
  const w = setup(['claude', 'alice', 'bob'], 'alice');
  const r = w.call({ room: w.code });
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
  const w = setup(['claude', 'alice', 'bob'], 'bob');
  const r = w.call({ room: w.code });
  assert.ok(await pending(r.p));
  w.add('alice', 'say', { provisional: true }); // #1
  await sleep(100);
  assert.match(must(w.progress.at(-1)).message, /^alice here · alice: say 1/);
  w.leaveMe();
  await r.p;
});

test('hold (item 15): removed by the host (a kick), the room row keeps holding (it shows it), so it never hands "left" back to the kicked person\'s Claude', async () => {
  const w = setup(['claude', 'alice', 'bob'], 'alice');
  const real = linkStateMod.seam.read;
  linkStateMod.seam.read = (c: string) => (c === w.code ? { state: 'stopped', lastReason: 'LINK_REVOKED', lastError: 'the host removed this machine' } as LinkState : null);
  try {
    const r = w.call({ room: w.code });
    assert.ok(await pending(r.p));
    w.leaveMe();
    assert.ok(await pending(r.p, 400), 'the room row holds');
  } finally { linkStateMod.seam.read = real; }
});
