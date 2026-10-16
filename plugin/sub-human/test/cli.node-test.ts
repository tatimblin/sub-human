// Tests for scripts/sub-human. The CLI runs as a child of this test process, so it resolves to whatever is
// registered for process.pid (process ancestry), exactly as it resolves to claude in a real session.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import * as h from './helpers.ts';
import * as room from '../lib/room.ts';
import * as session from '../lib/room/session.ts';
import * as identity from '../lib/identity.ts';
import * as proposal from '../lib/proposal.ts';
import * as textMod from '../lib/text.ts';
import * as store from '../lib/room/store.ts';
import * as links from '../lib/room/links.ts';
import * as linkMod from '../lib/remote/link.ts';
import { roomsDir } from '../lib/home.ts';
import type { Room } from '../lib/room.ts';
import type { FsRoomStore } from '../lib/room/store.ts';
import type { EntryInput, Via } from '../lib/room/types.ts';
let R!: Room; // the room under test

// tail looks its seat up by CLAUDE_PID when it has no session id (no ps walk).
const FAST = { CLAUDE_PID: String(process.pid), SUB_HUMAN_RESOLVE_MS: '100', SUB_HUMAN_UNSEATED_MS: '100', SUB_HUMAN_POLL_MS: '50', SUB_HUMAN_SETTLE_MS: '300', SUB_HUMAN_SETTLE_MAX_MS: '1000', SUB_HUMAN_LEAVE_MS: '600' };
const children = new Set<ChildProcess>();
test.afterEach(() => { for (const c of children) c.kill(); children.clear(); });

/** One line of the tail's stdout: a chat batch (its lines) or a wake (its text). */
interface TailEvent { type: string; lines: string[]; text: string }
interface TailRun {
  child: ChildProcessWithoutNullStreams;
  out: string;
  exited: Promise<number | null>;
  events(): TailEvent[];
  of(type: string): TailEvent[];
  lines(): string[];
  text(): string;
  chat(): string[];
  forClaude(): string[];
  entries(): string[];
  ids(): number[];
  batches(): number;
  until(needle: string, ms?: number): Promise<void>;
  stop(): Promise<void>;
}

function startTail(env: Record<string, string> = {}): TailRun {
  const child = spawn(h.BIN, ['tail', '/plugin/root', '/project/dir'], { env: h.childEnv({ ...FAST, ...env }) });
  children.add(child);
  const t = { child, out: '', exited: new Promise<number | null>(r => child.on('exit', code => r(code))) } as TailRun;
  child.stdout.on('data', d => { t.out += d; });
  // one JSON event per line; lines(): what the batches show (each chat event's lines, then its wake's)
  t.events = () => t.out.split('\n').filter(Boolean).map(l => JSON.parse(l));
  t.of = (type: string) => t.events().filter(x => x.type === type);
  t.lines = () => t.events().flatMap(x => (x.type === 'chat' ? x.lines : x.type === 'wake' ? x.text.split('\n') : []));
  t.text = () => t.lines().map(l => l + '\n').join('');
  t.chat = () => t.lines().filter(l => !l.startsWith('(for Claude)'));
  t.forClaude = () => t.lines().filter(l => l.startsWith('(for Claude)'));
  t.entries = () => t.lines().filter(l => /^#\d+ /.test(l));
  t.ids = () => t.entries().map(l => Number(l.split(' ')[0].slice(1)));
  t.batches = () => t.lines().filter(l => l.startsWith('room now: ')).length;
  t.until = async (needle: string, ms = 5000) => {
    await h.until(() => t.text().includes(needle), ms);
    assert.ok(t.text().includes(needle), `tail never printed ${needle}; got:\n${t.out}`);
  };
  t.stop = async () => { child.kill(); await t.exited; children.delete(child); };
  return t;
}
const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(h.BIN, args, { env: h.childEnv(env), encoding: 'utf8' });
const say = (from: string, text: string, extra: Partial<EntryInput> = {}, via: Via = 'human') => R.append({ kind: 'say', text, ...extra }, { via, from });
const sys = (kind: string, from: string, extra: Partial<EntryInput> = {}) => R.append({ kind, text: `${from} ${kind}`, ...extra }, { via: 'system', from, system: true });

const prop = (from: string, hash: string, approvers: string[]) => R.append({ kind: 'proposal', text: `${from} proposes`, hash, approvers }, { via: 'agent', from });

// The tail's batching, settle, leave hold, cursor restart, room switch and error recovery are tested
// in-process on a fake clock (test/tail.node-test.ts). These are the real-time smoke tests of the binary.
test('cli tail (smoke): silent before join, then one settled block; resumes from its cursor after a restart', async () => {
  h.freshHome();
  const code = h.newRoom();
  R = room.open(code);
  const a = startTail();
  say('bob', 'before alice joined');                     // #1
  await h.sleep(200);
  assert.equal(a.text(), '', 'silent until this session joins');
  h.register('alice', 'member', process.pid, code);
  sys('member_joined', 'alice');                         // #2 own: none
  say('bob', 'bob says hi');                             // #3
  R.append({ kind: 'question', text: 'q for alice', to: 'alice' }, { via: 'agent', from: 'bob' }); // #4
  await a.until("bob's Claude (to you): q for alice\n");
  assert.deepEqual(a.lines(), ['bob: bob says hi', "bob's Claude (to you): q for alice", `(for Claude) to answer bob's Claude: SendMessage bob.${code}`], a.out);
  assert.deepEqual([a.of('chat').length, a.of('wake').length], [1, 1], 'one burst: one chat, one wake');
  // The cursor is saved once stdout drained; stopping before then replays #4 (at-least-once), so wait for it.
  assert.equal(await h.until(() => session.get(R.store, 'alice', 'cursor') === 4, 3000), true, 'the cursor reached #4');
  await a.stop();
  say('bob', 'posted in the gap');                       // #5: nobody is watching
  const b = startTail();
  await b.until('bob: posted in the gap\n');
  assert.deepEqual(b.lines(), ['bob: posted in the gap'], b.out);
  await b.stop();
  // --max-seconds exits cleanly.
  const c = spawn(h.BIN, ['tail', '--max-seconds', '1'], { env: h.childEnv(FAST) });
  children.add(c);
  assert.equal(await new Promise(r => c.on('exit', r)), 0);
});

test('cli tail --ndjson (smoke): by session id, one JSON event per line; SIGTERM exits cleanly', async () => {
  h.freshHome();
  const code = h.newRoom();
  R = room.open(code);
  h.register('alice', 'member', process.pid, code); // session id sess-alice-<pid>
  sys('member_joined', 'alice');                         // #1
  const child = spawn(h.BIN, ['tail', '--ndjson'], { env: h.childEnv({ ...FAST, CLAUDE_PID: '', CLAUDE_CODE_SESSION_ID: `sess-alice-${process.pid}` }) });
  children.add(child);
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const exited = new Promise(r => child.on('exit', (code_, sig) => r(code_ ?? sig)));
  await h.until(() => out.includes('"type":"seat"'), 5000);
  say('bob', 'hi alice');                                // #2
  await h.until(() => out.includes('"type":"chat"'), 5000);
  const events = out.split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(events.find(x => x.type === 'chat').lines, ['bob: hi alice'], out);
  assert.equal(events.find(x => x.type === 'seat').seat.addr, `alice.${code}`);
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});

test('cli tail: while unseated it never runs ps and looks the seat up only every SUB_HUMAN_UNSEATED_MS', async () => {
  h.freshHome();
  const code = h.newRoom();
  R = room.open(code);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-human-ps-'));
  const marker = path.join(bin, 'ps-ran');
  // Only the ancestry walk (`ps -A`) counts: once seated, the seat's start-time check may run `ps -p PID` once.
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\ncase " $* " in *" -A "*) echo x >> "${marker}";; esac\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  // Register only after the tail's first (unseated) lookup: a fixed sleep let a slow child start look up after
  // the register and seat at once. support/started.ts stamps the end of the CLI's synchronous start, which
  // runs that first lookup.
  const started = path.join(bin, 'started');
  const t = startTail({
    PATH: `${bin}:${process.env.PATH}`, SUB_HUMAN_UNSEATED_MS: '1500', SUB_HUMAN_TEST_STARTED: started,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${path.join(import.meta.dirname, 'support', 'started.ts')}`.trim(),
  });
  assert.ok(await h.until(() => fs.existsSync(started) && fs.readFileSync(started, 'utf8'), 10_000), 'the tail started');
  const t0 = Number(fs.readFileSync(started, 'utf8'));
  h.register('alice', 'member', process.pid, code);
  sys('member_joined', 'alice');
  say('bob', 'hello');
  await t.until('bob: hello', 8000);
  assert.ok(Date.now() - t0 >= 1500, `seated ${Date.now() - t0} ms after the first lookup, before the unseated interval`);
  assert.ok(!fs.existsSync(marker), 'no ps walk with CLAUDE_PID set');
});

test('cli: who / read / digest resolve by session id, then ancestry', () => {
  h.freshHome();
  const code = h.newRoom();
  let r = cli(['who']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not in a room; type \/sub-human in your Claude Code session/);
  assert.equal(cli(['read']).status, 1);
  const bob = h.spawnSleeper();
  identity.join({ code, name: 'bob', role: 'member', pid: bob.pid, session_id: 'sbob' });
  h.register('alice', 'member', process.pid, code);
  r = cli(['who']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `alice (member) in ${code}\n`, 'nearest registered ancestor');
  r = cli(['who'], { CLAUDE_CODE_SESSION_ID: 'sbob' });
  assert.equal(r.stdout, `bob (member) in ${code}\n`, 'the session id wins');
  // --room: that room's people (live: it was ignored)
  r = cli(['who', '--room', code]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').sort(), [`alice (member) in ${code}`, `bob (member) in ${code}`]);
  R = room.open(code);
  say('bob', 'line one\n  line `two` $(x)');
  say('bob', 'second');
  r = cli(['read', '--id', '2,1']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.indexOf('#2') < r.stdout.indexOf('#1'));
  assert.ok(r.stdout.includes('  │ line one\n  │   line `two` $(x)'), 'every text line nested under the header');
  assert.ok(cli(['read', '2']).stdout.startsWith('[#2 '), 'a bare id works, as the cut marker says');
  r = cli(['read', '--json']);
  assert.deepEqual(r.stdout.trim().split('\n').map(l => JSON.parse(l).id), [1, 2]);
  assert.match(cli(['read']).stdout, /no new messages/);
  assert.equal(cli(['read', '--id', '99']).status, 1);
  r = cli(['digest']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ROOM DIGEST/);
  assert.match(r.stdout, /alice \(member\)/);
  assert.ok(r.stdout.length <= room.DIGEST_CAP + 1);
  assert.equal(cli(['digest', '--room', 'nope-0000']).status, 1);
  assert.equal(cli(['post', 'hello']).status, 2, 'there is no post command');
  const usage = cli(['nope']).stderr;
  assert.match(usage, /^usage: sub-human COMMAND\n/);
  for (const c of ['read [--id N,M]', 'digest', 'show HASH', 'who', 'tasks [--json]', 'watch NAME', 'invite [--ssh [USER@HOST]] [--via JUMP]', 'invite --cancel [REF]', 'admit [REF]', 'kick NAME', 'prime ROOM', 'link CODE [--reset | --forget [--force]]', 'handoff NAME', 'demote CODE [--from FILE]', 'options CODE', 'doctor', 'tail', 'serve --stdio CODE [--link ID [--login]]', 'agent-statusline']) assert.ok(usage.includes(c), c);
  assert.ok(usage.split('\n').every(l => l.length <= 100), 'readable lines, not one 600-character line');
  for (const gone of ['plan', 'statusline', 'host', 'unhost', 'revoke', 'authorize']) assert.equal(cli([gone]).status, 2, `${gone} is dropped`);
  bob.kill();
});

test('cli show HASH: a proposal\'s stored text, this session\'s room or --room; unknown or malformed hashes fail', () => {
  h.freshHome();
  const code = h.newRoom();
  h.register('alice', 'member', process.pid, code);
  const text = '# Cursor paging\n\n1. add cursor param\n';
  const { hash } = proposal.create({ code, name: 'alice' }, { text, approvers: ['alice'] });
  let r = cli(['show', hash]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, text);
  r = cli(['show', hash, '--room', code], { CLAUDE_PID: '1' });
  assert.equal(r.stdout, text, 'an explicit room');
  r = cli(['show', '000000000000']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`no proposal 000000000000 in room ${code}`));
  assert.equal(cli(['show', '../../keys/x']).status, 1, 'not a hash: never a path');
  assert.equal(cli(['show']).status, 2);
  assert.equal(cli(['show', hash, '--room', 'nope-0000']).status, 1);
  // what a session is told to run (propose's reply, lib/text.ts cliCmd): the shim by its full path, no PATH lookup
  const was = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = h.PLUGIN;
  let cmd, spaced;
  try { cmd = textMod.cliCmd(`show ${hash}`); process.env.CLAUDE_PLUGIN_ROOT = '/a b/it\'s'; spaced = textMod.cliCmd('show x'); } finally {
    if (was === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = was;
  }
  assert.equal(cmd, `${h.BIN} show ${hash}`);
  assert.equal(spaced, `'/a b/it'\\''s/scripts/sub-human' show x`, 'a root a shell would split is quoted');
  r = spawnSync('/bin/sh', ['-c', cmd], { env: h.childEnv(), encoding: 'utf8' });
  assert.equal(r.stdout, text, r.stderr);
});

// ---------- tasks / watch NAME ----------
test('cli tasks: the room list from lib/tasks.ts list(code), plain and --json', () => {
  h.freshHome();
  const { code } = h.register('alice');
  R = room.open(code);
  let r = cli(['tasks']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `(no tasks in room ${code})\n`);
  const list = [
    { id: '2', subject: 'parser   tests', status: 'in_progress', owner: 'bob', blockedBy: [] },
    { id: '3', subject: 'docs', status: 'pending', owner: null, blockedBy: ['2'] },
    { id: '1', subject: `room ${code} open`, status: 'in_progress', owner: 'room', metadata: { _internal: true } },
  ];
  fs.writeFileSync(path.join(R.store.dir!, 'tasks.json'), JSON.stringify(list));
  r = cli(['tasks']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '#2  in progress  bob  parser tests\n#3  open         -    docs  (blocked by #2)\n', 'the rows\' words: open, in progress, done');
  r = cli(['tasks', '--json', '--room', code]);
  assert.deepEqual(JSON.parse(r.stdout).map((t: { id: string }) => t.id), ['2', '3']);
  assert.equal(cli(['tasks', '--room', 'nope-0000']).status, 1);
});

test('cli watch NAME: their words, their Claude, sign-offs, joins/leaves, the room Claude; nobody else', () => {
  h.freshHome();
  const { code } = h.register('alice');
  R = room.open(code);
  const H = 'abcdef012345';
  sys('member_joined', 'bob');                                                           // #1 shown
  say('bob', 'I want cursor paging');                                                     // #2 shown
  R.append({ kind: 'status', text: 'bob claude proposes' }, { via: 'agent', from: 'bob' }); // #3 shown
  say('alice', 'alice talks to the room');                                                // #4 hidden
  R.append({ kind: 'question', text: 'alice claude asks carol', to: 'carol' }, { via: 'agent', from: 'alice' }); // #5 hidden
  R.append({ kind: 'question', text: 'bob, cursor or offset?', to: 'bob' }, { via: 'agent', from: 'claude' }); // #6 shown
  say('claude', 'claude to the room', {}, 'agent');                                           // #7 hidden
  prop('alice', H, ['bob']);                                                              // #8 hidden
  say('bob', 'too broad\n  keep it small', { kind: 'objection', proposal_hash: H });      // #9 shown
  say('bob', 'ok', { kind: 'signoff', proposal_hash: H });                                // #10 shown
  sys('member_left', 'bob');                                                              // #11 shown
  const r = cli(['watch', 'bob']);
  assert.equal(r.status, 0, r.stderr);
  const heads = r.stdout.split('\n').filter(l => /^#\d+ /.test(l));
  assert.deepEqual(heads.map(l => Number(l.split(' ')[0].slice(1))), [1, 2, 3, 6, 9, 10, 11], r.stdout);
  const whoOf = (id: number) => heads.find(l => l.startsWith(`#${id} `))!.split(/\s{2,}/)[1];
  assert.equal(whoOf(1), 'room');
  assert.equal(whoOf(2), 'bob');
  assert.equal(whoOf(3), "bob's Claude");
  assert.equal(whoOf(6), 'claude');
  assert.equal(whoOf(9), 'bob');
  assert.match(heads.find(l => l.startsWith('#9 '))!, /objection {2}proposal abcdef$/);
  assert.ok(r.stdout.includes('    too broad\n      keep it small\n'), 'text verbatim, indented');
  assert.ok(!r.stdout.includes('\x1b['), 'no color when not a terminal');
  // the room Claude's own thread labels it claude
  const o = cli(['watch', 'claude']).stdout;
  assert.match(o, /^#6 \S+ {2}claude {2}question {2}→ bob/m);
  assert.match(o, /^#7 \S+ {2}claude {2}say/m);
  assert.match(cli(['watch', 'zed']).stdout, /nothing from or to zed/);
  assert.equal(cli(['watch']).status, 2);
});

test('cli link CODE --forget: refused on a room hosted here, and for a link stopped for another reason without --force; then the copy is archived and the link removed', () => {
  const stopped = (lastError: string, lastReason?: string) => ({ state: 'stopped', since: new Date().toISOString(), attempt: 0, lastError, ...(lastReason ? { lastReason } : {}), rttMs: null, queued: 0, detail: 'stopped', at: new Date().toISOString() });
  h.freshHome();
  const hosted = h.newRoom();
  store.createRoom(hosted); // newCode() may have made it already
  assert.ok(store.roomExists(hosted) && store.open(hosted).isHost);
  const r0 = cli(['link', hosted, '--forget']);
  assert.equal(r0.status, 1);
  assert.match(r0.stderr, /this machine hosts room .*; there is no connection to forget/);
  assert.ok(store.roomExists(hosted), 'a room hosted here is untouched');

  const code = h.newRoom();
  links.set(code, { code, transport: { kind: 'pipe', home: '/h' }, token: 't' });
  const s = store.open(code) as FsRoomStore; // a room on disk: the fs store, with its logFile
  assert.equal(s.isHost, false);
  fs.mkdirSync(s.dir!, { recursive: true, mode: 0o700 });
  fs.writeFileSync(s.logFile, '{"id":1}\n');
  fs.writeFileSync(path.join(s.dir!, 'outbox.json'), '[]');
  // stopped for another reason: only --force forgets it
  links.writeState(code, stopped('AUTH: unknown link token'));
  const r2 = cli(['link', code, '--forget']);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /did not stop because the room closed, no seat of this machine is left or the host removed it \(AUTH: unknown link token\); add --force/);
  assert.ok(links.has(code) && fs.existsSync(s.logFile), 'nothing moved');
  assert.equal(cli(['link', code, '--reset', '--forget']).status, 2, 'one at a time');

  links.writeState(code, stopped(linkMod.ROOM_CLOSED_REASON, 'ROOM_CLOSED'));
  const r3 = cli(['link', code, '--forget']);
  assert.equal(r3.status, 0, r3.stderr);
  const m = r3.stdout.match(/^room \S+: forgotten; this machine's copy is kept at (.+)$/m);
  assert.ok(m, r3.stdout);
  const archive = m[1];
  assert.equal(path.dirname(archive), roomsDir());
  assert.match(path.basename(archive), new RegExp(`^${code}\\.forgotten-`));
  assert.ok(fs.existsSync(path.join(archive, 'outbox.json')), 'unsent posts are kept');
  assert.equal(fs.readdirSync(archive).filter(f => /^orphaned-.*\.jsonl$/.test(f)).length, 1, 'the log is set aside');
  assert.ok(!fs.existsSync(path.join(archive, path.basename(s.logFile))));
  assert.equal(links.has(code), false);
  assert.equal(fs.existsSync(links.dirOf(code)), false);
  assert.equal(fs.existsSync(s.dir!), false);
  // verify12 remote/07d: the link's own state file goes with the copy, none stays in links/
  assert.equal(fs.existsSync(links.stateFile(code)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(archive, 'link.state.json'), 'utf8')).lastReason, 'ROOM_CLOSED');
  store.forget(code); // this process's cache (the CLI dropped its own)
  assert.equal(store.roomExists(code), false);
  assert.deepEqual(store.listRooms(), [hosted], 'no listing sees the archive, and nothing opens it as a room hosted here');
  // forgotten already, or never known: no room, not "this machine hosts room"
  for (const c of [code, 'nope-0000']) {
    for (const args of [['link', c, '--forget'], ['link', c, '--forget', '--force'], ['link', c]]) {
      const r = cli(args);
      assert.equal(r.status, 1, args.join(' '));
      assert.equal(r.stderr.trim(), `no room ${c} on this machine`, args.join(' '));
    }
  }
  assert.equal(store.roomExists(code), false, 'nothing was created');

  // a seatless stop forgets too; --force any link, here one with no copy on disk
  const seatless = h.newRoom();
  links.set(seatless, { code: seatless, transport: { kind: 'pipe', home: '/h' }, token: 't' });
  fs.mkdirSync(store.open(seatless).dir!, { recursive: true, mode: 0o700 });
  links.writeState(seatless, stopped(linkMod.NO_SEAT_REASON, 'NO_SEAT'));
  assert.equal(cli(['link', seatless, '--forget']).status, 0);
  assert.equal(links.has(seatless), false);
  const other = h.newRoom();
  links.set(other, { code: other, transport: { kind: 'pipe', home: '/h' }, token: 't' });
  fs.rmSync(path.join(roomsDir(), other), { recursive: true, force: true }); // newCode() reserved it
  fs.writeFileSync(links.logFile(other), 'a daemon line\n');
  const r4 = cli(['link', other, '--forget', '--force']);
  assert.equal(r4.status, 0, r4.stderr);
  assert.match(r4.stdout, /forgotten \(this machine had no copy of it\)/);
  assert.equal(fs.existsSync(links.logFile(other)), false, 'no copy to keep it beside: the log goes');
  assert.equal(links.has(other), false);
  assert.equal(store.roomExists(other), false);
});


test('R1 (live verify, verify6/12): after link CODE --forget, a process still holding the seat writes nothing there and no "hosted" room comes back; a leftover folder is no room, and --forget sets it aside', () => {
  const stopped = { state: 'stopped', since: new Date().toISOString(), attempt: 0, lastError: 'the host removed this machine', lastReason: 'LINK_REVOKED', rttMs: null, queued: 0, detail: 'stopped', at: new Date().toISOString() };
  h.freshHome();
  const code = h.newRoom();
  links.set(code, { code, transport: { kind: 'pipe', home: '/h' }, token: 't' });
  const s = store.open(code) as FsRoomStore;
  fs.mkdirSync(s.dir!, { recursive: true, mode: 0o700 });
  fs.writeFileSync(s.logFile, '{"id":1}\n');
  // bob's seat in it, as this machine's session indexes record it
  const idx = { code, name: 'bob', role: 'member', pid: process.pid, session_id: 'aaaaaaaa-0000-4000-8000-0000000000b0', address: `bob.${code}` };
  fs.mkdirSync(path.join(identity.home(), 'sessions', 'by-sid'), { recursive: true });
  fs.writeFileSync(path.join(identity.home(), 'sessions', 'by-sid', `${idx.session_id}.json`), JSON.stringify(idx));
  links.writeState(code, stopped);
  const r = cli(['link', code, '--forget']);
  assert.equal(r.status, 0, r.stderr);
  store.forget(code);
  assert.equal(fs.existsSync(path.join(identity.home(), 'sessions', 'by-sid', `${idx.session_id}.json`)), false, 'the seat ends: its index is gone');
  assert.equal(identity.lastSeat(idx.session_id), null);
  // what bob's hold server or tail would write next: refused, and no folder comes back
  const after = store.open(code) as FsRoomStore;
  assert.throws(() => session.put(after, 'bob', 'holds', { pid: 1, at: new Date().toISOString(), members: [], room: false }), (e: Error & { code?: string }) => e.code === 'NO_ROOM');
  assert.throws(() => after.kv.update('members/bob/session', () => ({ v: 1 })), (e: Error & { code?: string }) => e.code === 'NO_ROOM');
  assert.equal(fs.existsSync(after.dir!), false);
  assert.equal(store.roomExists(code), false);
  // the stray state an older run left: a folder with only a seat's session document, untouched for minutes
  fs.mkdirSync(path.join(after.dir!, 'members', 'bob'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(after.dir!, 'members', 'bob', 'session.json'), '{"v":1}');
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(after.dir!, old, old);
  assert.equal(store.isLeftover(code), true);
  assert.equal(store.roomExists(code), false, 'never a room hosted here');
  // stage 8e I.10: a stray write a moment ago (its mtime now) leaves it a leftover: made long ago is what counts
  // (where the filesystem keeps a birth time that utimes moved back with it, as on macOS)
  fs.writeFileSync(path.join(after.dir!, 'members', 'bob', 'x.json'), '{}');
  fs.utimesSync(after.dir!, new Date(), new Date());
  if (fs.statSync(after.dir!).birthtimeMs > 0 && fs.statSync(after.dir!).birthtimeMs < Date.now() - 60_000) assert.equal(store.isLeftover(code), true, 'written just now, made minutes ago');
  fs.utimesSync(after.dir!, old, old);
  // the store's locks refuse a room this machine does not have, as its writes do
  const gone = h.newRoom();
  const ghost = store.open(gone) as FsRoomStore;
  fs.rmSync(ghost.dir!, { recursive: true, force: true });
  assert.throws(() => ghost.lock('x', () => 1), (e: Error & { code?: string }) => e.code === 'NO_ROOM');
  assert.throws(() => ghost.kv.lock('members/bob/session', () => 1), (e: Error & { code?: string }) => e.code === 'NO_ROOM');
  assert.equal(fs.existsSync(ghost.dir!), false, 'no folder made for a lock');
  const fresh = h.newRoom();
  store.createRoom(fresh);
  assert.equal(store.isLeftover(fresh), false, 'a room just made, before its first join, is a room');
  const d = cli(['link', code, '--forget']);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, new RegExp(`^room ${code}: a leftover folder .* is set aside at .*${code}\\.forgotten-`));
  assert.equal(fs.existsSync(after.dir!), false);
});

test('cli link CODE --forget (stage 8f item 3): a daemon still running is stopped first, then the room is forgotten in the same step', () => {
  h.freshHome();
  const code = h.newRoom();
  links.set(code, { code, transport: { kind: 'pipe', home: '/h' }, token: 't' });
  const s = store.open(code) as FsRoomStore;
  fs.mkdirSync(s.dir!, { recursive: true, mode: 0o700 });
  fs.writeFileSync(s.logFile, '{"id":1}\n');
  // a stand-in daemon: its document `link` names a live pid, online (no stop reason on record)
  // started through a shell that exits, so it is reaped once it stops, as the detached daemon is
  const pid = Number(spawnSync('sh', ['-c', `'${process.execPath}' -e 'setInterval(() => {}, 1000)' >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).stdout.trim());
  assert.ok(pid > 0 && identity.isAlive(pid));
  s.kv.set('link', { pid, state: 'online', since: new Date().toISOString() });
  const r = cli(['link', code, '--forget']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^room ${code}: its connection \\(pid ${pid}\\) stopped, and forgotten; this machine's copy is kept at `, 'm'));
  assert.equal(identity.isAlive(pid), false, 'the daemon is gone');
  assert.equal(links.has(code), false);
  assert.equal(fs.existsSync(s.dir!), false);
  store.forget(code);
});

test('cli link CODE --forget on a link that is not online (verify12 remote/05b): the host is not tried, and the line says it sees the seat lapse', () => {
  h.freshHome();
  const code = h.newRoom();
  links.set(code, { code, transport: { kind: 'pipe', home: '/h' }, token: 't' });
  const s = store.open(code) as FsRoomStore;
  fs.mkdirSync(s.dir!, { recursive: true, mode: 0o700 });
  fs.writeFileSync(s.logFile, '{"id":1}\n');
  // bob's seat, this machine's, as the host's document (sent to the mirror) has it
  const mirrorLocal = (store.open(code) as unknown as { local: FsRoomStore }).local;
  mirrorLocal.members.update(() => ({ bob: { name: 'bob', role: 'member', machine: identity.machineId(), joined_at: new Date().toISOString() } } as never));
  const pid = Number(spawnSync('sh', ['-c', `'${process.execPath}' -e 'setInterval(() => {}, 1000)' >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).stdout.trim());
  s.kv.set('link', { pid, state: 'connecting', since: new Date().toISOString() });
  const t0 = Date.now();
  const r = cli(['link', code, '--forget']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 5000);
  assert.match(r.stdout, /forgotten; this machine's copy is kept at \S+; the host was not told bob left \(the connection was connecting\): it sees the seat lapse$/m);
  assert.equal(identity.isAlive(pid), false);
  store.forget(code);
});

test('cliLine: a sub-human folder other than ~/.sub-human is named before the command, so a terminal acts on it (verify12 remote/05a)', () => {
  const was = process.env.SUB_HUMAN_HOME;
  try {
    process.env.SUB_HUMAN_HOME = '/tmp/x home';
    assert.match(textMod.cliLine('link vole-1234 --forget'), /^SUB_HUMAN_HOME='\/tmp\/x home' node \S+\/scripts\/sub-human link vole-1234 --forget$/);
    process.env.SUB_HUMAN_HOME = path.join(os.homedir(), '.sub-human');
    assert.match(textMod.cliLine('doctor'), /^node /, 'the default folder: no prefix');
    delete process.env.SUB_HUMAN_HOME;
    assert.match(textMod.cliLine('doctor'), /^node /);
    assert.equal(textMod.homePrefix('/srv/sh', '/u'), 'SUB_HUMAN_HOME=/srv/sh ');
    assert.equal(textMod.homePrefix('/u/.sub-human/', '/u'), '');
  } finally { if (was === undefined) delete process.env.SUB_HUMAN_HOME; else process.env.SUB_HUMAN_HOME = was; }
});
