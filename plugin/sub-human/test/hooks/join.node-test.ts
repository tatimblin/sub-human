import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn as sp } from 'node:child_process';
import crypto from 'node:crypto';
import { World, fixture, hso, identity, room, sleeper, withHome, PLUGIN, baseEnv, HOOKS } from './helpers.ts';
import { pidStart } from '../../lib/lock.ts';
import * as helpersLib from '../helpers.ts';
import * as common from '../../hooks/context.ts';
import * as membersLib from '../../lib/room/members.ts';
import * as linkSocket from '../../lib/remote/link-socket.ts';
import * as inviteSecret from '../../lib/remote/invite-secret.ts';
import type { HookLine, HookRun } from './helpers.ts';
import type { Identity } from '../../lib/identity.ts';
import type { Member, Members, Role } from '../../lib/room/types.ts';
import type { RoomCode } from '../../lib/brand.ts';
import { rc, sn, mid } from '../support/brands.ts';
import { must } from '../support/must.ts';

/** An invite line's SECRET word (lib/remote/invite-secret.ts): well formed, naming no host this test has. */
const SECRET = inviteSecret.encode(Buffer.alloc(16, 1), Buffer.alloc(8, 2));

/** One run of the stub claude, as it logs it. */
interface StubCall { argv: string[]; env: Record<string, string>; cwd: string }

const until = async <T,>(fn: () => T, ms = 8000): Promise<T | null> => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 30)); } return null; };
/** A seat in w's members.json, asserted present. */
const seat = (w: World, name: string): Member => must(w.members()[name], name);
/** An Identity as contextBlock / seatTitle read it (no session, no pid). */
const ident = (code: RoomCode, name: string, role: Role): Identity => ({ code, name: sn(name), role, session_id: null, pid: null, address: identity.address(name, code) });
const bgCalls = (s: ReturnType<typeof stub>) => s.calls().filter(c => c.argv.includes('--bg'));
const expand = (args: string) => ({ ...fixture('user-prompt-expansion'), command_args: args, prompt: `/sub-human:sub-human ${args}`.trim() });

/** A stub claude that records its argv / env / cwd and prints the --bg line. */
function stub(code = 'x') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-stub-'));
  const log = path.join(dir, 'calls.jsonl');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2), env: process.env, cwd: process.cwd()}) + '\\n');\n` +
    `if (process.argv.includes('--bg')) console.log('backgrounded · 0b500131 · claude.' + ${JSON.stringify(code)});\n`);
  fs.chmodSync(bin, 0o755);
  return { bin, calls: () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as StubCall); } catch { return []; } } };
}

test('/sub-human NAME with no open room: opens a room, joins as a member, spawns the headless claude (detached) in the joiner\'s cwd', async () => {
  const w = new World({}, { room: false });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000001';
  const s = stub();
  const r = w.hook('join', expand('alice'), { as: 'alice', env: { SUB_HUMAN_CLAUDE: s.bin, SUB_HUMAN_PLUGIN_DIR: PLUGIN } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(must(r.json).systemMessage, undefined, 'a join that worked shows no (warning-styled) systemMessage');
  const m = /in room ([a-z]+-\d{4})/.exec(must(hso(r).additionalContext));
  assert.ok(m, hso(r).additionalContext);
  w.code = rc(must(m[1]));
  assert.ok(['pending', '0b500131'].includes(must(seat(w, 'claude').job)), 'claimed before the hook returned');
  assert.ok(await until(() => seat(w, 'claude').job === '0b500131'), 'the detached starter records members.json claude {job}');
  const ms = w.members();
  assert.equal(must(ms.alice).role, 'member');
  assert.equal(must(ms.claude).pid, null, 'pid filled when the room\'s Claude binds');
  assert.equal(must(ms.claude).by, 'alice');
  const call = must(bgCalls(s)[0], 'the --bg call');
  assert.equal(call.cwd, fs.realpathSync(w.cwd));
  assert.deepEqual(call.argv.slice(0, 5), ['--bg', '-n', `claude.${w.code}`, '--plugin-dir', PLUGIN]);
  const settings = JSON.parse(must(call.argv[call.argv.indexOf('--settings') + 1])) as { env: Record<string, string>; crossSessionInbound: string };
  // the joiner's timing overrides (the test env sets the reaper's to 0) ride along for the room Claude's own reaper
  assert.deepEqual(settings.env, {
    SUB_HUMAN_HOME: w.home, SUB_HUMAN_ROOM: w.code, CLAUDE_CODE_TASK_LIST_ID: `sh-${w.code}`, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_STOP_MS: '200',
  });
  assert.equal(settings.crossSessionInbound, 'refuse', 'a peer\'s message would start a turn: nobody needs to reach it');
  assert.equal(Object.keys(call.env).filter(k => k.startsWith('CLAUDE')).length, 0, 'no CLAUDE_* reaches the room\'s Claude');
  assert.equal(call.env.SUB_HUMAN_HOME, undefined, 'the room\'s Claude env comes only from --settings');
  // the room session's task list, made before it starts (its task view watches it): nothing else in tasks/
  assert.deepEqual(fs.readdirSync(path.join(w.userHome, '.claude', 'tasks')), [`sh-${w.code}`]);
  assert.deepEqual(fs.readdirSync(path.join(w.userHome, '.claude', 'tasks', `sh-${w.code}`)), [], 'no task yet: the first request writes the room task');
  const c = must(hso(r).additionalContext);
  assert.ok(c.startsWith(`SUB-HUMAN: you are alice's Claude in room ${w.code}`), c.slice(0, 80));
  assert.doesNotMatch(c, /\{(NAME|CODE|OTHERS|ADDR_EXAMPLE|PLUGIN)\}/);
  assert.match(c, /\nROWS\n/);
  assert.match(c, /subagent_type: "sub-human:room"/);
  const es = w.entries();
  assert.deepEqual([must(es[0]).kind, must(es[0]).from, must(es[0]).via], ['member_joined', 'alice', 'system']);
  // already seated: idempotent, no second room or room Claude
  const r2 = w.hook('join', expand('alice'), { as: 'alice', env: { SUB_HUMAN_CLAUDE: s.bin } });
  assert.equal(must(r2.json).systemMessage, undefined);
  assert.match(must(hso(r2).additionalContext), /\(already joined\)$/);
  assert.equal(fs.readdirSync(path.join(w.home, 'rooms')).length, 1);
  assert.equal(bgCalls(s).length, 1);
});

test('the room\'s Claude\'s launch /sub-human binds it (agent_type sub-human:room-claude + SUB_HUMAN_ROOM) and keeps the job', () => {
  const w = new World({ alice: 'sleep' });
  w.lib(() => identity.updateRoomClaude(w.code, () => ({ job: '0b500131', spawned_at: new Date().toISOString() })));
  w.pid.claude = process.pid; w.sid.claude = 'aaaaaaaa-0000-4000-8000-000000000002';
  const input = { ...expand(''), agent_type: 'sub-human:room-claude', permission_mode: 'plan' };
  const r = w.hook('join', input, { as: 'claude', env: { SUB_HUMAN_ROOM: w.code } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(must(r.json).decision, undefined, must(r.json).reason);
  assert.equal(must(r.json).systemMessage, undefined);
  const o = seat(w, 'claude');
  assert.deepEqual([o.role, o.pid, o.job, o.session_id], ['claude', process.pid, '0b500131', w.sid.claude]);
  const c = must(hso(r).additionalContext);
  assert.ok(c.startsWith(`SUB-HUMAN: you are the room session of room ${w.code} (members: alice)`), c.slice(0, 100));
  assert.match(c, /subagent_type: "sub-human:participant", description: "alice"/);
  assert.equal(w.entries().length, 0, 'the room\'s Claude logs no member_joined');
  const again = w.hook('join', input, { as: 'claude', env: { SUB_HUMAN_ROOM: w.code } });
  assert.equal(must(again.json).systemMessage, undefined);
  assert.match(must(hso(again).additionalContext), /\(room already open\)$/);
  const named = w.hook('join', { ...expand('bob'), agent_type: 'sub-human:room-claude' }, { as: 'claude', env: { SUB_HUMAN_ROOM: w.code } });
  assert.equal(must(named.json).decision, 'block');
  assert.match(must(must(named.json).reason), /room's Claude agent/);
});

test('debug launch: a room-claude agent session without SUB_HUMAN_ROOM opens a room, or binds /sub-human CODE', () => {
  const w = new World({}, { room: false });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000003';
  const input = { ...expand(''), agent_type: 'sub-human:room-claude' };
  const r = w.hook('join', input, { as: 'me', env: { SUB_HUMAN_ROOM: undefined } });
  const m = /the room session of room ([a-z]+-\d{4})/.exec(must(hso(r).additionalContext));
  assert.ok(m && must(r.json).systemMessage === undefined, JSON.stringify(r.json));
  w.code = rc(must(m[1]));
  assert.equal(seat(w, 'claude').pid, process.pid);
  const w2 = new World({ bob: 'sleep' });
  w2.pid.me = process.pid; w2.sid.me = 'aaaaaaaa-0000-4000-8000-000000000004';
  const r2 = w2.hook('join', { ...expand(w2.code), agent_type: 'sub-human:room-claude' }, { as: 'me', env: { SUB_HUMAN_ROOM: undefined } });
  assert.equal(must(r2.json).systemMessage, undefined);
  assert.equal(seat(w2, 'claude').pid, process.pid);
});

const NO_GIT = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

test('bare /sub-human: not in a room, it opens one as the default name (git user.name, first word, lowercased); in a room, a short status', () => {
  const plain = new World({}, { room: false });
  plain.pid.me = process.ppid; plain.sid.me = 'aaaaaaaa-0000-4000-8000-000000000005';
  spawnSync('git', ['init', '-q', plain.cwd]);
  spawnSync('git', ['-C', plain.cwd, 'config', 'user.name', 'Dana Scully']);
  let r = plain.hook('join', expand(''), { as: 'me', env: { ...NO_GIT, USER: 'ignored' } });
  assert.equal(must(r.json).decision, undefined, r.stdout);
  const code = rc(must(fs.readdirSync(path.join(plain.home, 'rooms'))[0]));
  assert.ok(withHome(plain.home, () => identity.readMembers(code)).dana, 'joined as dana');
  // seated: the status, no model turn
  r = plain.hook('join', expand(''), { as: 'me', env: NO_GIT });
  assert.equal(must(r.json).decision, 'block');
  assert.match(must(must(r.json).reason), new RegExp(`^sub-human: you're dana in room ${code}, nobody else here yet · another machine: /sub-human invite · leave: /sub-human leave( · starting the room's Claude….*)?$`));
});

test('/sub-human CODE (a room code alone) joins that room as the default name, never as a person named after the room', () => {
  const w = new World({ alice: 'act' });
  w.pid.me = process.ppid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000015';
  spawnSync('git', ['init', '-q', w.cwd]);
  spawnSync('git', ['-C', w.cwd, 'config', 'user.name', 'Dana Scully']);
  const r = w.hook('join', expand(w.code), { as: 'me', env: NO_GIT });
  assert.equal(must(r.json).decision, undefined, r.stdout);
  const ms = w.members();
  assert.ok(ms.dana, 'joined as dana');
  assert.equal(ms[w.code], undefined);
});

test('SECURITY: a PIN-shaped prompt the hook throws on is still answered hidden (never a plain exit that expands the prompt)', () => {
  const w = new World({ alice: 'act' });
  w.pid.me = process.ppid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000016';
  fs.writeFileSync(path.join(w.home, 'links'), 'not a directory'); // the link registry cannot be written: the join flow throws
  const r = w.hook('join', expand(`join me@far vole-1234 ${SECRET}`), { as: 'me' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(must(r.json).decision, 'block');
  assert.equal(must(must(r.json).hookSpecificOutput).suppressOriginalPrompt, true, 'the typed prompt stays out of the conversation');
  assert.match(must(must(r.json).reason), /^sub-human: ✗ /, 'a refusal with the failure, not a bare exit 1');
  assert.ok(!must(must(r.json).reason).includes(SECRET) && !must(must(r.json).reason).includes('me@far'), 'nothing typed is echoed');
});

test('budget: a join whose host never answers (ssh hangs) still replies, hidden, inside the hook\'s 10 s; the link keeps trying', t => {
  const w = new World({ alice: 'act' }, { t });
  w.pid.me = process.ppid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000017';
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-hangssh-'));
  const pids = path.join(bin, 'pids');
  // connects nowhere and says nothing (each run notes its pid, so the test can stop it; 15 s at most regardless)
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\necho $$ >> '${pids}'\nexec sleep 15\n`, { mode: 0o755 });
  const code = rc('vole-4321');
  t.after(() => {
    const kill = (pid: number) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
    const daemon = w.lib(() => linkSocket.status(code)).pid;
    if (daemon) kill(daemon);
    try { fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean).forEach(p => kill(Number(p))); } catch { /* none ran */ }
  });
  const t0 = Date.now();
  // the real store (not test:thread-store's preload): the link daemon this join starts must be a production one
  const r = w.hook('join', expand(`join me@devbox ${code} ${SECRET}`), { as: 'me', env: { PATH: `${bin}:${process.env.PATH}` } });
  const ms = Date.now() - t0;
  assert.equal(r.code, 0, r.stderr);
  assert.ok(ms < 9000, `the join took ${ms} ms of its 10 s`);
  assert.equal(must(must(r.json).hookSpecificOutput).suppressOriginalPrompt, true, 'hidden: the prompt held a SECRET');
  assert.match(must(must(r.json).reason), new RegExp(`still connecting to room ${code}`), must(r.json).reason);
  assert.ok(!must(must(r.json).reason).includes(SECRET), 'the SECRET is not echoed');
  assert.equal(w.lib(() => linkSocket.status(code)).running, true, 'the link daemon keeps trying after the hook');
});

test('the default name: git user.name, else the local part of user.email, else $USER; a taken one says how to pick another', () => {
  const w = new World({ claude: 'sleep', dana: 'sleep' });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000015';
  // no git name here: $USER, normalized
  let r = w.hook('join', expand(''), { as: 'me', env: { ...NO_GIT, USER: 'Eve Polastri' } });
  assert.equal(must(r.json).decision, undefined, r.stdout);
  assert.ok(w.members().eve, 'joined as eve');
  // the email's local part, when there is no user.name
  const w2 = new World({ claude: 'sleep', dana: 'sleep' });
  w2.pid.me = process.ppid; w2.sid.me = 'aaaaaaaa-0000-4000-8000-000000000016';
  spawnSync('git', ['init', '-q', w2.cwd]);
  spawnSync('git', ['-C', w2.cwd, 'config', 'user.email', 'Frank.Smith@example.com']);
  r = w2.hook('join', expand(''), { as: 'me', env: { ...NO_GIT, USER: 'ignored' } });
  assert.equal(must(r.json).decision, undefined, r.stdout);
  assert.ok(w2.members()['frank.smith'], JSON.stringify(Object.keys(w2.members())));
  // taken: refused with the hint; an explicit NAME always wins
  const w3 = new World({ claude: 'sleep', dana: 'sleep' });
  w3.pid.me = process.ppid; w3.sid.me = 'aaaaaaaa-0000-4000-8000-000000000017';
  // that dana sits in another folder (the same folder's live seat is this person's own: see the fork test below)
  const mf = path.join(w3.home, 'rooms', w3.code, 'members.json');
  const ms = JSON.parse(fs.readFileSync(mf, 'utf8')) as Members;
  must(ms.dana).cwd = '/elsewhere';
  fs.writeFileSync(mf, JSON.stringify(ms));
  r = w3.hook('join', expand(''), { as: 'me', env: { ...NO_GIT, USER: 'dana' } });
  assert.equal(must(r.json).decision, 'block');
  assert.match(must(must(r.json).reason), new RegExp(`^sub-human: ✗ "dana" is taken in room ${w3.code}; pick another: /sub-human NAME ${w3.code}$`));
  r = w3.hook('join', expand('dana2'), { as: 'me', env: { ...NO_GIT, USER: 'dana' } });
  assert.equal(must(r.json).decision, undefined, r.stdout);
  // the rule itself
  for (const [text, want] of [['Tristan Timblin', 'tristan'], ['José', 'jose'], ['doctor', null], ['help', null], ['  ', null], ['ann-marie', 'ann-marie']] as const) {
    assert.equal(identity.normalizeName(text), want, text);
  }
});

test('every verb is a reserved name: /sub-human doctor or help is never a person called doctor', () => {
  for (const v of ['invite', 'join', 'kick', 'leave', 'doctor', 'help', 'admit', 'handoff']) assert.ok(identity.RESERVED.includes(v), v);
  const w = new World({ claude: 'sleep', alice: 'act' });
  const h = w.hook('join', expand('help'), { as: 'alice' });
  assert.match(must(must(h.json).reason), /\/sub-human invite .*\n[\s\S]*\/sub-human join HOST ROOM SECRET[\s\S]*\/sub-human join PIN /);
  assert.equal(w.members().help, undefined);
  for (const name of ['kick', 'leave', 'doctor']) {
    const r = w.hook('join', expand(`${name} vole-1234`), { as: 'alice' });
    assert.equal(must(r.json).decision, 'block', name);
  }
});

test('/sub-human leave: the seat leaves (as /exit would), the session stays; /sub-human joins again', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const r = w.hook('join', expand('leave'), { as: 'alice' });
  assert.equal(must(r.json).decision, 'block');
  assert.equal(must(r.json).reason, `sub-human: left ${w.code} · /sub-human joins again`, 'a plain confirmation, not a refusal');
  assert.ok(seat(w, 'alice').left_at, 'alice left');
  assert.match(w.entries().map(e => e.text).join('\n'), /^alice left$/m);
  assert.match(must(must(w.hook('join', expand('leave'), { as: 'alice' }).json).reason), /not in a room/);
});

test('verify12 local/37: a leave asks ps once (one call for every seat\'s start time), not once per seat; a young lease needs none', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep', carol: 'sleep', dana: 'sleep' });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-ps-'));
  const log = path.join(bin, 'ps.log');
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexec /bin/ps "$@"\n`);
  fs.chmodSync(path.join(bin, 'ps'), 0o755);
  viaModule(w, 'bob', `bob ${w.code}`);
  try { fs.rmSync(log); } catch { /* none yet */ }
  const nonce = 'ab'.repeat(16);
  const left = w.hook('join', { ...expand('leave'), sub_human_via: 'command.run', sub_human_nonce: nonce }, { as: 'bob', modLease: false, env: { CLAUDE_PID: undefined, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(must(must(left.json).subHuman).say, `left ${w.code} · /sub-human joins again`);
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  assert.ok(calls.length <= 1, calls.join('\n'));
});

test('NAME CODE joins a room whose claude runs: no spawn, no systemMessage; the block lists who is here', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep' });
  w.pid.bob = process.pid; w.sid.bob = 'aaaaaaaa-0000-4000-8000-000000000006';
  const s = stub(w.code);
  const r = w.hook('join', expand(`bob ${w.code}`), { as: 'bob', env: { SUB_HUMAN_CLAUDE: s.bin } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(must(r.json).systemMessage, undefined);
  assert.equal(s.calls().length, 0);
  const c = must(hso(r).additionalContext);
  assert.match(c, new RegExp(`room ${w.code} \\(with alice, claude\\)`));
  assert.ok(c.includes(`alice.${w.code}`), 'ADDR_EXAMPLE');
  assert.equal(seat(w, 'bob').session_id, w.sid.bob);
});

test('joining a room with no live claude restarts it; a failed start is retried by the next join, which says why (a systemMessage)', async () => {
  const w = new World({ alice: 'sleep' });
  w.pid.bob = process.pid; w.sid.bob = 'aaaaaaaa-0000-4000-8000-000000000007';
  const r = w.hook('join', expand(`bob ${w.code}`), { as: 'bob' }); // SUB_HUMAN_CLAUDE=/usr/bin/false
  assert.equal(must(r.json).decision, undefined);
  assert.equal(must(r.json).systemMessage, undefined, 'starting the room\'s Claude is no trouble');
  assert.ok(await until(() => seat(w, 'claude').spawn_error), 'the starter records the failure');
  assert.equal(seat(w, 'claude').job, null);
  const s = stub(w.code);
  const r2 = w.hook('join', expand(`bob ${w.code}`), { as: 'bob', env: { SUB_HUMAN_CLAUDE: s.bin } });
  assert.match(must(must(r2.json).systemMessage), new RegExp(`^sub-human: you're already in ${w.code} as bob, with alice · starting the room's Claude… \\(the last start failed: .+\\)$`));
  assert.ok(await until(() => seat(w, 'claude').job === '0b500131'));
  assert.equal(bgCalls(s).length, 1);
  const r3 = w.hook('join', expand(`bob ${w.code}`), { as: 'bob', env: { SUB_HUMAN_CLAUDE: s.bin } });
  assert.equal(must(r3.json).systemMessage, undefined, 'a job that has not bound yet is not restarted');
});

test('a seated bare /sub-human restarts a room Claude that failed to start, and leaves a starting one alone', async () => {
  const w = new World({ alice: 'sleep' });
  w.pid.bob = process.pid; w.sid.bob = 'aaaaaaaa-0000-4000-8000-000000000017';
  w.hook('join', expand(`bob ${w.code}`), { as: 'bob' }); // SUB_HUMAN_CLAUDE=/usr/bin/false
  assert.ok(await until(() => seat(w, 'claude').spawn_error), 'the starter records the failure');
  const s = stub(w.code);
  const r = w.hook('join', expand(''), { as: 'bob', env: { SUB_HUMAN_CLAUDE: s.bin } });
  assert.equal(must(r.json).decision, 'block', 'still the status, no model turn');
  assert.match(must(must(r.json).reason), new RegExp(`^sub-human: you're bob in room ${w.code}, with alice · .* · starting the room's Claude… \\(the last start failed: .+\\)$`));
  assert.ok(await until(() => seat(w, 'claude').job === '0b500131'));
  assert.equal(bgCalls(s).length, 1);
  const r2 = w.hook('join', expand(''), { as: 'bob', env: { SUB_HUMAN_CLAUDE: s.bin } });
  assert.doesNotMatch(must(must(r2.json).reason), /starting the room's Claude/, 'a job that has not bound yet is not restarted');
  assert.equal(bgCalls(s).length, 1);
});

test('two concurrent joins start one claude: the second sees the pending claim', async () => {
  const w = new World({ alice: 'sleep' });
  w.pid.bob = sleeper(); w.sid.bob = 'aaaaaaaa-0000-4000-8000-000000000015';
  w.pid.carol = sleeper(); w.sid.carol = 'aaaaaaaa-0000-4000-8000-000000000016';
  // The stub's dispatch waits for a gate file the test opens only after both hooks returned, so both joins
  // overlap the spawn whatever the load (a fixed 400 ms wait did not guarantee it, and timing bounds failed
  // under load), and every room Claude starter either join made is still running when they are counted.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-stub-'));
  const log = path.join(dir, 'calls.jsonl');
  const gate = path.join(dir, 'gate');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\nconst fs = require('fs');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n` +
    `if (process.argv.includes('--bg')) { const z = new Int32Array(new SharedArrayBuffer(4)); for (let i = 0; i < 1200 && !fs.existsSync(${JSON.stringify(gate)}); i++) Atomics.wait(z, 0, 0, 25); console.log('backgrounded · 0b500131 · claude.x'); }\n`);
  fs.chmodSync(bin, 0o755);
  const starters = () => spawnSync('ps', ['-Ao', 'args'], { encoding: 'utf8' }).stdout.split('\n')
    .filter(l => l.includes(path.join('lib', 'room-claude.ts')) && l.includes(` start ${w.code} `)).length;
  const run = (who: string) => new Promise<HookLine>(res => {
    w.modLease(w.sid[who]);
    const env = baseEnv({ SUB_HUMAN_HOME: w.home, HOME: w.userHome, CLAUDE_PLUGIN_ROOT: PLUGIN, SUB_HUMAN_CLAUDE: bin, SUB_HUMAN_PLUGIN_DIR: '', CLAUDE_PID: String(w.pid[who]) });
    const p = sp(process.execPath, [path.join(HOOKS, 'run.ts'), 'join'], { env, cwd: w.cwd });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('close', () => res(JSON.parse(out) as HookLine));
    p.stdin.end(JSON.stringify({ ...expand(`${who} ${w.code}`), cwd: w.cwd, session_id: w.sid[who] }));
  });
  // Both hooks return while the dispatch is held: they did not wait for the spawn.
  const [a, b] = await Promise.all([run('bob'), run('carol')]);
  assert.deepEqual([a.systemMessage, b.systemMessage], [undefined, undefined]);
  assert.equal(seat(w, 'claude').job, 'pending', 'claimed, not yet recorded');
  // A join starts its starter (detached) before it returns, and the held dispatch keeps every starter running.
  assert.equal(starters(), 1, 'one starter: the second join saw the pending claim');
  fs.writeFileSync(gate, '');
  assert.ok(await until(() => seat(w, 'claude').job === '0b500131', 30_000));
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as string[]);
  assert.equal(calls.filter(c => c.includes('--bg')).length, 1, 'one spawn');
});

test('NAME without CODE ignores a room where only the room\'s Claude is left, opens a new one, and sweeps the orphan', async () => {
  const w = new World({ claude: 'sleep' });
  const orphan = w.code;
  w.join('dave', 'sleep');
  w.lib(() => {
    // dave crashed long ago (pid dead, no SessionEnd): the room's Claude observed the orphan 2 minutes ago
    const file = path.join(identity.roomDir(orphan), 'members.json');
    const ms = JSON.parse(fs.readFileSync(file, 'utf8')) as Members;
    must(ms.dave).pid = 999999; must(ms.dave).joined_at = new Date(Date.now() - 600_000).toISOString();
    must(ms.claude).job = 'feed0001'; must(ms.claude).orphan_since = new Date(Date.now() - 120_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(ms));
  });
  assert.deepEqual(w.lib(() => identity.openRooms()), []);
  w.pid.erin = process.pid; w.sid.erin = 'aaaaaaaa-0000-4000-8000-000000000017';
  const r = w.hook('join', expand('erin'), { as: 'erin' });
  assert.equal(must(r.json).decision, undefined, must(r.json).reason);
  const m = /in room ([a-z]+-\d{4})/.exec(must(hso(r).additionalContext));
  assert.ok(m && m[1] !== orphan, hso(r).additionalContext);
  assert.ok(seat(w, 'claude').closing, 'the orphan room was marked closing by the sweep');
});

test('bypass-permissions mode: the join systemMessage warns', () => {
  const w = new World({ claude: 'sleep' });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000008';
  const r = w.hook('join', { ...expand(`alice ${w.code}`), permission_mode: 'bypassPermissions' }, { as: 'alice' });
  assert.match(must(must(r.json).systemMessage), /⚠ bypass-permissions mode: messages from other sessions can wait behind a dialog/);
});

test('the bare command name "sub-human" is accepted too; other commands are ignored', () => {
  const w = new World({ claude: 'sleep' });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000009';
  const r = w.hook('join', { ...expand(`alice ${w.code}`), command_name: 'sub-human' }, { as: 'alice' });
  assert.match(must(must(must(r.json).hookSpecificOutput).additionalContext), /^SUB-HUMAN: you are alice's Claude in room /);
  const r2 = w.hook('join', { ...expand(`bob ${w.code}`), command_name: 'other:thing' }, { as: 'alice' });
  assert.equal(r2.stdout, '');
});

test('without the hooks module\'s hello lease for the session the join is refused, and nothing is written', () => {
  const w = new World({ claude: 'sleep' });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000031';
  const r = w.hook('join', expand(`alice ${w.code}`), { as: 'alice', modLease: false });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(must(r.json).decision, 'block');
  assert.match(must(must(r.json).reason), /^sub-human: ✗ sub-human's hooks module isn't running in this session \(.*\)\. Run \/sub-human doctor\.$/, 'the cause it can tell, and the doctor');
  assert.equal(w.members().alice, undefined);
  assert.equal(w.entries().length, 0);
  // another session's lease does not count
  w.modLease('aaaaaaaa-0000-4000-8000-000000000032');
  assert.equal(must(w.hook('join', expand(`alice ${w.code}`), { as: 'alice', modLease: false }).json).decision, 'block');
  // with its own lease it joins
  assert.match(must(must(must(w.hook('join', expand(`alice ${w.code}`), { as: 'alice' }).json).hookSpecificOutput).additionalContext), /^SUB-HUMAN: you are alice's Claude in room /);
});

/** Write sid's hello lease as mod-hello would have, at time `at`, for the claude process pid. */
function leaseAt(w: World, sid: string, pid: number, at: number) {
  const dir = path.join(w.home, 'sessions', 'mods');
  fs.mkdirSync(dir, { recursive: true });
  const start = pidStart(pid);
  const rec = { session_id: sid, pid, ...(start != null ? { pid_start: start } : {}), at: new Date(at).toISOString(), seat: null };
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify(rec));
  return path.join(dir, `${sid}.json`);
}

test('a resumed old session id with a stale lease cannot join; a lease from this claude process can, however old', async () => {
  const w = new World({ claude: 'sleep' });
  const old = Date.now() - 86_400_000; // a day: far past MOD_LEASE_FRESH_MS
  // the session's first process wrote the lease and is gone; `claude --resume SID` with the module off
  w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000041';
  leaseAt(w, w.sid.alice, await helpersLib.deadPid(), old);
  w.pid.alice = sleeper();
  const r = w.hook('join', expand(`alice ${w.code}`), { as: 'alice', modLease: false });
  assert.equal(must(r.json).decision, 'block');
  assert.match(must(must(r.json).reason), /^sub-human: ✗ sub-human's hooks module isn't running in this session \(.*\)\. Run \/sub-human doctor\.$/, 'the cause it can tell, and the doctor');
  assert.equal(w.members().alice, undefined);
  assert.equal(w.entries().length, 0);
  // the lease mod-hello wrote at this process's start, an hour ago
  leaseAt(w, w.sid.alice, w.pid.alice, old);
  assert.match(must(must(must(w.hook('join', expand(`alice ${w.code}`), { as: 'alice', modLease: false }).json).hookSpecificOutput).additionalContext), /^SUB-HUMAN: you are alice's Claude in room /);
});

test('join\'s sweep prunes hello leases whose process is gone', async () => {
  const w = new World({ claude: 'sleep', bob: 'sleep' });
  const live = leaseAt(w, 'aaaaaaaa-0000-4000-8000-000000000051', must(w.pid.bob), Date.now() - 3_600_000);
  const gone = leaseAt(w, 'aaaaaaaa-0000-4000-8000-000000000052', await helpersLib.deadPid(), Date.now());
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000053';
  assert.match(must(must(must(w.hook('join', expand('alice'), { as: 'alice' }).json).hookSpecificOutput).additionalContext), /^SUB-HUMAN: you are alice's Claude in room /);
  assert.ok(fs.existsSync(live), 'a live process keeps its lease');
  assert.ok(!fs.existsSync(gone), 'a gone process\'s lease is pruned');
  assert.ok(fs.existsSync(path.join(w.home, 'sessions', 'mods', `${w.sid.alice}.json`)), 'the joiner keeps its own');
});

test('failures block with a reason and log nothing', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep' });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000010';
  const cases: [string, RegExp][] = [
    [`alice ${w.code}`, /name taken/],
    ['bob otter-0000', /no room otter-0000/],
    [`bob ${w.code} extra`, /usage/],
    [`claude ${w.code}`, /reserved/],
    [`b@d ${w.code}`, /"b@d" isn't a command or a name/],
  ];
  for (const [args, re] of cases) {
    const r = w.hook('join', expand(args), { as: 'me' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(must(r.json).decision, 'block', args);
    assert.match(must(must(r.json).reason), re, args);
  }
  assert.equal(w.entries().length, 0);
  // a closing room is not joined
  w.lib(() => identity.updateRoomClaude(w.code, () => ({ closing: new Date().toISOString() })));
  const r = w.hook('join', expand(`bob ${w.code}`), { as: 'me' });
  assert.match(must(must(r.json).reason), /is closing/);
});

test('/sub-human invite: an invite line for my room, shown to me only (a hidden block), its PIN apart, both new each call; no NAME in it', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep' });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000011';
  assert.match(must(must(w.hook('join', expand('invite --pipe'), { as: 'me' }).json).reason), /join a room first/);
  const shown = must(w.hook('join', expand('invite --pipe'), { as: 'alice' }).json);
  assert.equal(shown.decision, 'block');
  assert.deepEqual([shown.systemMessage, shown.hookSpecificOutput], [undefined, { hookEventName: 'UserPromptExpansion', suppressOriginalPrompt: true }]);
  const m = new RegExp(`\n  /sub-human join pipe:${w.home.replace(/[.]/g, '\\.')} ${w.code} ([0-9a-z]{39})\n`).exec(must(shown.reason));
  assert.ok(m, shown.reason);
  const pin = /tell them its PIN apart from the line \(say it, or send it another way\): (\d{4})\n/.exec(must(shown.reason));
  assert.ok(pin, shown.reason);
  assert.match(must(shown.reason), /the line alone gets nobody in, nor does the PIN/);
  assert.match(must(shown.reason), /\/sub-human invite --cancel [0-9a-f]{12}/);
  assert.notEqual(must(new RegExp(`${w.code} ([0-9a-z]{39})`).exec(must(must(w.hook('join', expand('invite --pipe'), { as: 'alice' }).json).reason)))[1], m[1], 'a new one each time');
  for (const [args, re] of [['invite --frobnicate', /usage: \/sub-human invite/], ['invite --pipe --web', /pick one/], ['invite --ssh NAME@box', /placeholder/], ['invite --ssh USER@box', /placeholder/]] as const) {
    const r = must(w.hook('join', expand(args), { as: 'alice' }).json);
    assert.match(must(r.reason), re, args);
    assert.equal(r.hookSpecificOutput && r.hookSpecificOutput.suppressOriginalPrompt, true, `${args}: hidden`);
  }
  // cancel: by ref, or the one open (here two are open: it lists them)
  const many = must(must(w.hook('join', expand('invite --cancel'), { as: 'alice' }).json).reason);
  assert.match(many, /has 2 open invites; cancel one: \/sub-human invite --cancel [0-9a-f]{12}/);
  const ref = must(/--cancel ([0-9a-f]{12})/.exec(many))[1];
  assert.match(must(must(w.hook('join', expand(`invite --cancel ${ref}`), { as: 'alice' }).json).reason), new RegExp(`cancelled the invite to room ${w.code} \\(${ref}\\)`));
  assert.match(must(must(w.hook('join', expand('invite --cancel'), { as: 'alice' }).json).reason), /cancelled the invite to room \S+ \([0-9a-f]{12}\)/, 'the one left');
  assert.match(must(must(w.hook('join', expand('invite --cancel'), { as: 'alice' }).json).reason), /no open invite/);
  assert.deepEqual(fs.readdirSync(w.home).filter(d => d === 'links'), [], 'no link written');
});

test('SECURITY: every join, invite and admit prompt (and any with a word of digits) is answered hidden, whatever is wrong with it', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  w.pid.me = process.ppid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000012';
  const hiddenReply = (r: HookRun) => r.json && r.json.decision === 'block' && r.json.hookSpecificOutput && r.json.hookSpecificOutput.suppressOriginalPrompt === true;
  const S = SECRET;
  const cases: [string, RegExp][] = [
    ['join dev vole-1234 48291', /the line's SECRET \(its last long word\) did not come through whole/], // not a SECRET
    ['join dev vole-1234 482', /did not come through whole/],
    ['join dev vole-1234 4829', /did not come through whole/], // a 0.5.0-beta.15 line: no SECRET
    [`join dev vole-1234 ${S} 4829`, /type the line without the PIN: the host's machine asks for the PIN once it has answered/],
    [`join dev vole-1234 ${S.slice(0, 30)}`, /did not come through whole/],
    [`join dev vole-1234 ${S} --home rel`, /--home "rel" isn't a plain absolute path/],
    [`join dev vole-1234 ${S} --frob`, /"--frob" isn't a join option/],
    [`join dev vole-1234 ${S} extra x`, /usage: \/sub-human join/],
    ['join https://box/sub-human/vole-1234 48291', /did not come through whole/],
    ['join https://box/sub-human/vole-1234', /needs the SECRET/],
    [`join https://box/sub-human/vole-1234 ${S} 4829`, /type the line without the PIN/],
    [`join https://box/sub-human/vole-1234 ${S} --home /x`, /--home goes with an ssh address/],
    [`join dev vole-1234 ${S} --via j`, /"--via" isn't a join option/],
    [`join https://box/x/4829 ${S}`, /isn't a join address.*Paste the whole line the host sent you/],
    [`join YOU@box vole-1234 ${S}`, /placeholder/],
    ['join dev 4829', /"4829" isn't a room/],
    ['join dev', /which room/],
    ['join 4829', /no invite here is waiting for a PIN: type the invite line first/],
    ['join 4829 --as bob', /the PIN goes alone/],
    ['join 48291', /a PIN is 4 digits/],
    [`join pipe:/nowhere vole-1234 ${S} --as b@d`, /"b@d" isn't a name/],
    ['join dev vole-1234 --as help', /reserved/],
    [`dev vole-1234 ${S}`, /usage/], // "join" left out
    [`bob ${S}`, /that looks like an invite line's SECRET/],
    [S, /that looks like an invite line's SECRET/],
    ['invite 4829', /join a room first/],
    ['admit 4829', /join a room first/],
    ['admit', /join a room first|waiting|hosted on another machine/],
    [`bob ${w.code} 4829`, /usage/],
  ];
  for (const [args, re] of cases) {
    const r = w.hook('join', expand(args), { as: 'me' });
    assert.ok(hiddenReply(r), `${args}: ${r.stdout}`);
    assert.match(must(must(r.json).reason), re, args);
    assert.equal(must(r.json).systemMessage, undefined, `${args}: nothing for Remote Control to carry off`);
  }
  // a mistyped PIN or SECRET never lands anywhere the model reads, nor in the reply
  for (const word of ['48291', '4829123', S.slice(0, 30)]) assert.ok(!must(must(w.hook('join', expand(`join dev vole-1234 ${word}`), { as: 'me' }).json).reason).includes(word));
  for (const word of ['48291', '4829']) assert.ok(!must(must(w.hook('join', expand(`join ${word}`), { as: 'me' }).json).reason).includes(word));
  assert.deepEqual(fs.readdirSync(w.home).filter(d => d === 'links'), [], 'no link written');
  // without the hooks module's lease, a join is still hidden
  const nl = w.hook('join', expand(`join dev vole-1234 ${S}`), { as: 'me', modLease: false });
  assert.ok(hiddenReply(nl), nl.stdout);
});

test('a bad name with no open room creates nothing', () => {
  const w = new World({}, { room: false });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000011';
  for (const [args, re] of [['b@d', /isn't a command or a name/], ['room', /reserved/]] as const) {
    const r = w.hook('join', expand(args), { as: 'me' });
    assert.match(must(must(r.json).reason), re);
  }
  assert.equal(fs.existsSync(path.join(w.home, 'rooms')) ? fs.readdirSync(path.join(w.home, 'rooms')).length : 0, 0);
});

test('joining another room switches to it; the room\'s Claude cannot switch rooms', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  const oldCode = w.code;
  const newCode = w.lib(() => identity.newCode());
  let r = w.hook('join', expand(`alice ${newCode}`), { as: 'alice' });
  assert.equal(must(r.json).decision, undefined, must(r.json).reason);
  assert.match(must(hso(r).additionalContext), new RegExp(`in room ${newCode}`));
  // alice was the old room's last member: its detached reaper (grace 0 in tests) may already have completed the room
  // task after her departure, so the departure is the last entry that is not the room's own task line.
  const left = must(w.entries().filter(e => !(e.kind === 'task' && e.from === 'room')).at(-1));
  assert.deepEqual([left.kind, left.from, left.via], ['member_left', 'alice', 'system'], 'old room logs the departure');
  assert.ok(seat(w, 'alice').left_at, 'old seat marked left');
  w.code = newCode;
  assert.deepEqual([must(w.entries().at(-1)).kind, must(w.entries().at(-1)).from], ['member_joined', 'alice']);
  w.code = oldCode;

  const w2 = new World({ claude: 'act2' });
  const other = w2.lib(() => identity.newCode());
  r = w2.hook('join', expand(`claudey ${other}`), { as: 'claude' });
  assert.equal(must(r.json).decision, 'block');
  assert.match(must(must(r.json).reason), /the room's Claude of room/);
});

test('NAME without CODE joins the only open room (one live seat is enough); several open rooms is an error', () => {
  const w = new World({}, { room: false });
  w.code = w.lib(() => identity.newCode());
  w.join('carol', 'sleep');
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000012';
  let r = w.hook('join', expand('alice'), { as: 'alice' });
  assert.equal(must(r.json).decision, undefined, must(r.json).reason);
  assert.match(must(hso(r).additionalContext), new RegExp(`room ${w.code} \\(with carol`));
  const first = w.code;
  w.code = w.lib(() => identity.newCode());
  w.join('dave', 'sleep');
  w.pid.bob = sleeper(); w.sid.bob = 'aaaaaaaa-0000-4000-8000-000000000013';
  r = w.hook('join', expand('bob'), { as: 'bob' });
  assert.equal(must(r.json).decision, 'block');
  assert.match(must(must(r.json).reason), /2 rooms are open/);
  assert.ok(must(must(r.json).reason).includes(first) && must(must(r.json).reason).includes(w.code), must(r.json).reason);
});

test('join writes no presence (the module is its one writer, on the next typed prompt) and writes the row status launcher', () => {
  const w = new World({ claude: 'sleep' });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000014';
  const r = w.hook('join', expand(`alice ${w.code}`), { as: 'alice', env: { SUB_HUMAN_ALLOW_TMP_ROOT: '1' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.lib(() => room.open(w.code).store.kv.get('presence/alice', null)), null);
  // a seat has rows: the launcher the plugin's subagentStatusLine runs (hooks/launcher.ts), and the serve shim
  assert.match(fs.readFileSync(path.join(w.home, 'bin', 'row-status'), 'utf8'), /agent-statusline/);
});

// ---------- the mechanics block (hooks/context.ts contextBlock) ----------

/** contextBlock in-process, with templates from `root` (a stub plugin root) and a 5-member room. */
function blockFor(role: Role, root: string) {
  const w = new World({ claude: 'sleep', alice: 'sleep', bob: 'sleep', carol: 'sleep', dave: 'sleep', erin: 'sleep' });
  const old = process.env.CLAUDE_PLUGIN_ROOT;
  if (root) process.env.CLAUDE_PLUGIN_ROOT = root; else delete process.env.CLAUDE_PLUGIN_ROOT;
  try {
    return withHome(w.home, () => {
      const name = role === 'claude' ? 'claude' : 'alice';
      return { text: common.contextBlock(ident(w.code, name, role), 'joined'), code: w.code, common };
    });
  } finally { if (old === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = old; }
}

const STUB = {
  // the §2 example texts (~690 / ~720 chars), as templates
  'member.md': 'SUB-HUMAN: you are {NAME}\'s Claude in room {CODE} (members: {OTHERS}). {NAME} is the person typing here.\n'
    + 'Room lines are exact: `#12 bob [human]` is bob\'s own words, `[claude]` a Claude\'s. Quote them, cite #id.\n'
    + '{NAME}\'s prompts that start `@room` are posted as their words by a hook; nothing else can post as {NAME}.\n'
    + 'To reach a session now: SendMessage to {ADDR_EXAMPLE}; those come from Claudes.\n'
    + 'propose(text|path): asks named people to agree on a card. Never say {NAME} agrees.\n'
    + 'task(op): the room\'s task list (`{PLUGIN}/scripts/sub-human tasks`).',
  'room-claude.md': 'SUB-HUMAN: you are claude, the room\'s Claude of room {CODE} (members: {OTHERS}). Nobody types here.\n'
    + 'Reach a member now: SendMessage to {ADDR_EXAMPLE}; post is a note read on their next turn.\n'
    + 'Facilitate only when asked: read {PLUGIN}/skills/sub-human/facilitate.md.',
};
function stubRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-plugin-'));
  fs.mkdirSync(path.join(root, 'skills', 'sub-human'), { recursive: true });
  for (const [f, t] of Object.entries(STUB)) fs.writeFileSync(path.join(root, 'skills', 'sub-human', f), t);
  return root;
}

test('block: <= 900 chars with 5 members (stub templates), placeholders filled, ROWS carries the row call(s)', () => {
  const root = stubRoot();
  for (const role of ['member', 'claude'] as const) {
    const { text, code, common } = blockFor(role, root);
    assert.ok(text.length <= common.BLOCK_MAX, `${role} block is ${text.length} chars:\n${text}`);
    assert.doesNotMatch(text, /\{(NAME|CODE|OTHERS|ADDR_EXAMPLE|PLUGIN)\}/);
    assert.ok(text.includes(root), '{PLUGIN} filled');
    const calls = text.match(/^Agent\(\{.*\}\)$/gm) || [];
    if (role === 'member') {
      assert.match(text, new RegExp(`members: bob, carol, dave, erin, claude\\)`));
      assert.ok(text.includes(`bob.${code}`), 'ADDR_EXAMPLE = the first other human');
      assert.equal(calls.length, 1);
      assert.match(calls[0], /sub-human:room.*members: bob, carol, dave, erin/);
    } else {
      assert.match(text, /members: alice, bob, carol, dave, erin\)/);
      assert.match(text, /^Agent\(\{subagent_type: "sub-human:participant", description: "NAME", prompt: "member: NAME", run_in_background: true\}\)$/m);
      assert.match(text, /^NAME = alice, bob, carol, dave, erin$/m);
    }
  }
});

/**
 * The budget is about the template, not this checkout: the fill carries {PLUGIN} (this checkout's path, ~50 chars
 * on master, ~95 in a worktree) and {CODE} (a random animal of 4-7 letters). Measured raw, the same template passed
 * or failed with the path and the dice. So measure the worst case a user meets: the longest code and a marketplace
 * install path.
 */
const REF_PLUGIN = '/Users/someone/.claude/plugins/cache/sub-human/sub-human/1.0.0';
const LONGEST_CODE = `${identity.ANIMALS.reduce((a, b) => (b.length > a.length ? b : a))}-0000`;
const atReference = (text: string, code: RoomCode) => text.split(PLUGIN).join(REF_PLUGIN).split(code).join(LONGEST_CODE);

test('block: no template file (or one without placeholders) falls back to the built-in text; the shipped templates fill cleanly', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-plugin-'));
  for (const role of ['member', 'claude'] as const) {
    const { text, common } = blockFor(role, empty);
    assert.ok(text.startsWith('SUB-HUMAN: you are'), text.slice(0, 60));
    assert.ok(text.length <= common.BLOCK_MAX, `${role} default block is ${text.length}`);
    const got = blockFor(role, PLUGIN);
    const shipped = atReference(got.text, got.code);
    assert.doesNotMatch(shipped, /\{(NAME|CODE|OTHERS|ADDR_EXAMPLE|PLUGIN)\}/);
    assert.match(shipped, /\nROWS\n/);
    // D's budget: the template fill <= 1,400 with 5 members (the member's room upkeep block included), the whole block
    // (with ROWS) <= 1,900
    assert.ok(must(shipped.split('\n\nROWS\n')[0]).length <= 1400, `${role} fill ${must(shipped.split('\n\nROWS\n')[0]).length}`);
    assert.ok(shipped.length <= 1900, `${role} shipped block ${shipped.length}`);
  }
});

test('seatTitle is the native address NAME.CODE', () => {
  assert.equal(common.seatTitle(ident(rc('vole-8126'), 'alice', 'member')), 'alice.vole-8126');
});

test('classic (no module answering): a reply is the block reason alone, never also a systemMessage (Claude Code shows the reason only); an invite is hidden', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  const r = w.hook('join', expand('a b c'), { as: 'alice' });
  assert.equal(must(r.json).decision, 'block');
  assert.equal(must(r.json).systemMessage, undefined);
  assert.equal(must(r.json).reason, 'sub-human: ✗ usage: /sub-human [NAME] joins or opens a room. All commands: /sub-human help');
  const inv = w.hook('join', expand('invite --pipe'), { as: 'alice' });
  assert.equal(must(inv.json).decision, 'block');
  assert.match(must(must(inv.json).reason), /^sub-human: invite to room /, 'an invite is no refusal: no ✗');
  assert.equal(must(inv.json).systemMessage, undefined, 'the invite stays off Remote Control');
  assert.equal(must(must(inv.json).hookSpecificOutput).suppressOriginalPrompt, true);
});

/** Run join.ts as the module's command.run hook does (mod/core/command.ts joinPayload): no CLAUDE_PID, the lease's
 * nonce, this test process as the claude process (the shim's parent). */
function viaModule(w: World, name: string, args: string, { nonce = 'ab'.repeat(16), leaseNonce = nonce }: { nonce?: string; leaseNonce?: string } = {}) {
  w.pid[name] = process.pid;
  w.sid[name] = w.sid[name] || crypto.randomUUID();
  w.lib(() => identity.writeModLease(w.sid[name], { pid: process.pid, nonce: leaseNonce }));
  const payload = { ...expand(args), sub_human_via: 'command.run', sub_human_nonce: nonce };
  return w.hook('join', payload, { as: name, modLease: false, env: { CLAUDE_PID: undefined } });
}

test('through the module (command.run): every reply is {subHuman: {say}}, never a block; a join that worked also carries the mechanics block and a one-line confirmation', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep' });
  const help = must(viaModule(w, 'me', 'help').json);
  assert.equal(help.decision, undefined);
  assert.equal(must(help.subHuman).refused, false);
  assert.equal(must(help.subHuman).shareable, true, 'help holds no secret: the command\'s own output');
  assert.match(must(must(help.subHuman).say), /^commands:\n {2}\/sub-human /);
  const bad = must(must(viaModule(w, 'me', 'a b c').json).subHuman);
  assert.deepEqual([bad.refused, bad.shareable], [true, true]);
  assert.match(must(bad.say), /^✗ usage: \/sub-human \[NAME\]/);
  const joined = must(viaModule(w, 'bob', `bob ${w.code}`).json);
  assert.equal(joined.decision, undefined);
  assert.match(must(must(joined.hookSpecificOutput).additionalContext), /^SUB-HUMAN: you are bob's Claude in room /);
  assert.equal(must(joined.subHuman).joined, true);
  assert.match(must(must(joined.subHuman).say), new RegExp(`^joined ${w.code} as bob, with alice · @room to talk; your Claude can message other Claudes, edit the room plan and the task list`));
  assert.equal(seat(w, 'bob').pid, process.pid, 'the seat\'s claude process is the shim\'s parent');
  const left = must(must(viaModule(w, 'bob', 'leave').json).subHuman);
  assert.deepEqual([left.say, left.refused], [`left ${w.code} · /sub-human joins again`, false]);
});

test('SECURITY through the module: an invite and anything a PIN may be typed in are never shareable (notices only); a wrong nonce is not the module', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep' });
  const inv = must(must(viaModule(w, 'alice', 'invite --pipe').json).subHuman);
  assert.equal(inv.shareable, false);
  // the line and the PIN are pinned (the module's status line: no transcript row holds them); the notices say where
  assert.doesNotMatch(must(inv.say), new RegExp(`[0-9a-z]{39}`));
  assert.doesNotMatch(must(inv.say), /: \d{4}\b/);
  assert.match(must(inv.say), /pinned under the prompt until \d\d:\d\d: Claude Code saves neither in this conversation/);
  // item 2 (D): the PIN first and short, then the line; nothing before it that costs width
  assert.match(must(inv.pinned).status, new RegExp(`^PIN \\d{4} · /sub-human join pipe:\\S+ ${w.code} [0-9a-z]{39}$`));
  assert.ok(must(inv.pinned).ms > 14 * 60_000 && must(inv.pinned).ms <= 15 * 60_000);
  // for a terminal too narrow for the line: the PIN and the SECRET alone, and notices with SECRET in the word's place
  assert.match(must(must(inv.pinned).short), /^PIN \d{4} · SECRET [0-9a-z]{39}$/);
  assert.match(must(must(inv.pinned).cut), new RegExp(`\\n  /sub-human join pipe:\\S+ ${w.code} SECRET\\n`));
  const pin = must(/^PIN (\d{4})/.exec(must(inv.pinned).status))[1];
  assert.doesNotMatch(must(must(inv.pinned).cut), new RegExp(`[0-9a-z]{39}|PIN ${pin}|\\b${pin}\\b(?!.*${w.code})`));
  assert.match(must(must(inv.pinned).ref), /^[0-9a-f]{12}$/);
  assert.ok(must(inv.say).includes(must(must(inv.pinned).ref)), 'the notices name the ref --cancel takes');
  for (const args of ['join dev vole-1234 48291', `join dev vole-1234 ${SECRET} --frob`, `x ${w.code} 4829`, `x ${SECRET}`, 'join 4829', 'admit']) {
    const r = must(must(viaModule(w, 'me', args).json).subHuman);
    assert.equal(r.shareable, false, args);
    assert.ok(!/48291/.test(must(r.say)) && !must(r.say).includes(SECRET), args);
  }
  // a payload that says "command.run" without this session's nonce is no module: nothing runs, and the module is
  // told its lease did not hold (it says hello again and asks once more; verify12 local/37)
  const forged = viaModule(w, 'eve', 'help', { nonce: 'cd'.repeat(16), leaseNonce: 'ab'.repeat(16) });
  assert.equal(must(forged.json).decision, undefined);
  assert.deepEqual(must(forged.json).subHuman, { lease: 'stale' });
  assert.match(forged.stderr, /lease did not hold/);
  const before = w.entries().length;
  viaModule(w, 'alice', 'leave', { nonce: 'cd'.repeat(16), leaseNonce: 'ab'.repeat(16) });
  assert.equal(w.entries().length, before, 'a stale lease runs no leave');
  assert.equal(seat(w, 'alice').left_at, undefined);
});
test('the block lists the room\'s Claude only while it runs or is starting: never one that never ran or whose start failed', () => {
  const w = new World({ alice: 'sleep', bob: 'sleep' });
  const now = Date.now(), iso = (ms: number) => new Date(ms).toISOString();
  const others = (rec: Partial<Member>) => withHome(w.home, () => membersLib.roomClaudePresence({ name: sn('claude'), role: 'claude', ...rec }, now));
  // the rule (lib/room/members.ts roomClaudePresence), from any machine
  assert.equal(others({ job: null, spawn_error: 'exit 1' }), null, 'a failed start (the harness stub)');
  assert.equal(others({}), null, 'never spawned');
  assert.equal(others({ job: 'pending', spawned_at: iso(now - 1000) }), 'starting');
  assert.equal(others({ job: 'pending', spawned_at: iso(now - 10 * 60_000) }), null, 'a stale claim');
  assert.equal(others({ job: 'j1', spawned_at: iso(now - 1000) }), 'starting', 'spawned, not bound yet');
  assert.equal(others({ job: 'j1', spawned_at: iso(now - 10 * 60_000), joined_at: iso(now - 9 * 60_000), seen_at: iso(now - 1000), machine: mid('m-host') }), 'live', 'another machine\'s claude: its lease');
  assert.equal(others({ job: 'j1', spawned_at: iso(now - 10 * 60_000), joined_at: iso(now - 9 * 60_000), seen_at: iso(now - 5 * 60_000), machine: mid('m-host') }), null, 'its lease ran out');
  // @ts-expect-error -- deliberate: any truthy closing counts
  assert.equal(others({ job: 'j1', closing: true, seen_at: iso(now), joined_at: iso(now) }), null);
  // the block itself: a room whose room Claude failed to start does not say "with … room Claude"
  withHome(w.home, () => identity.updateRoomClaude(w.code, () => ({ name: sn('claude'), role: 'claude', job: null, spawn_error: 'exit 1', pid: null })));
  const text = withHome(w.home, () => common.contextBlock(ident(w.code, 'alice', 'member'), 'rejoined'));
  assert.match(text, new RegExp(`room ${w.code} \\(with bob\\)`), text.slice(0, 120));
});

test('/sub-human help WORDS shows the list (it was refused), without the module too', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  for (const args of ['help', 'help join', 'help me please']) {
    const r = w.hook('join', expand(args), { as: 'alice', modLease: false });
    assert.equal(must(r.json).decision, 'block', args);
    assert.match(must(must(r.json).reason), /^sub-human: commands:\n {2}\/sub-human /, args);
    assert.equal(must(r.json).hookSpecificOutput, undefined, `${args}: no secret in it`);
  }
  // a word of digits after help: the same list, hidden (it may be a PIN)
  const pin = w.hook('join', expand('help 4829'), { as: 'alice' });
  assert.match(must(must(pin.json).reason), /^sub-human: commands:/);
  assert.equal(must(must(pin.json).hookSpecificOutput).suppressOriginalPrompt, true);
});

test('/sub-human join ROOM joins that room on this machine (the default name, or --as); join with no room still asks which', () => {
  const w = new World({ alice: 'act' });
  w.pid.me = process.ppid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000017';
  spawnSync('git', ['init', '-q', w.cwd]);
  spawnSync('git', ['-C', w.cwd, 'config', 'user.name', 'Dana Scully']);
  const r = w.hook('join', expand(`join ${w.code}`), { as: 'me', env: NO_GIT });
  assert.equal(must(r.json).decision, undefined, r.stdout);
  assert.match(must(hso(r).additionalContext), new RegExp(`^SUB-HUMAN: you are dana's Claude in room ${w.code}`));
  assert.ok(w.members().dana, 'joined as dana');
  w.pid.you = process.pid; w.sid.you = 'aaaaaaaa-0000-4000-8000-000000000018';
  const as = w.hook('join', expand(`join ${w.code} --as erin`), { as: 'you' });
  assert.equal(must(as.json).decision, undefined, as.stdout);
  assert.ok(w.members().erin, 'joined as erin');
  const none = w.hook('join', expand('join otter-0000 --as fay'), { as: 'you' });
  assert.match(must(must(none.json).reason), /there's no room otter-0000 on this machine/);
  assert.equal(must(must(none.json).hookSpecificOutput).suppressOriginalPrompt, true, 'a join prompt is hidden, whatever it is');
  assert.match(must(must(w.hook('join', expand(`join ${w.code} --home /x`), { as: 'you' }).json).reason), /--home goes with the other machine's address/);
  assert.match(must(must(w.hook('join', expand('join dev'), { as: 'you' }).json).reason), /which room/);
});

test('a word of digits is no name: /sub-human 4829 says it looks like a PIN, hidden, and nothing is written', () => {
  const w = new World({}, { room: false });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000019';
  for (const args of ['4829', 'join otter-1234 --as 4829']) {
    const r = w.hook('join', expand(args), { as: 'me' });
    assert.equal(must(must(r.json).hookSpecificOutput).suppressOriginalPrompt, true, args);
    assert.match(must(must(r.json).reason), /"4829" looks like a PIN, not a name: a PIN goes in as \/sub-human join PIN once an invite line asks for it/, args);
  }
  // "/sub-human --as 4829": given as a name, so it is no name (live round two: it said "not a room")
  let r = w.hook('join', expand('--as 4829'), { as: 'me' });
  assert.match(must(must(r.json).reason), /"4829" looks like a PIN, not a name/);
  // and a PIN where a room goes is no room
  r = w.hook('join', expand('dana 4829'), { as: 'me' });
  assert.match(must(must(r.json).reason), /"4829" looks like a PIN, not a room/);
  assert.equal(fs.existsSync(path.join(w.home, 'rooms')) && fs.readdirSync(path.join(w.home, 'rooms')).length, false, 'no room opened');
});

test('an invite line without its SECRET: a second sub-human folder has no login path, so it says the SECRET is missing', () => {
  const w = new World({ alice: 'act' });
  w.pid.me = process.ppid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000020';
  for (const dest of ['pipe:/some/home', '/some/home']) {
    const r = w.hook('join', expand(`join ${dest} vole-1234 --as bob`), { as: 'me' });
    assert.equal(must(must(r.json).hookSpecificOutput).suppressOriginalPrompt, true, dest);
    assert.match(must(must(r.json).reason), new RegExp(`that looks like an invite line without its SECRET: /sub-human join ${dest} vole-1234 SECRET`), dest);
  }
  assert.deepEqual(fs.readdirSync(w.home).filter(d => d === 'links'), [], 'no link written');
});

test('bare /sub-human in a fork of a seated session (← the agent view) takes the seat back; with no fork record, a live seat of this folder in another session is refused with where it is, never a second room', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep' });
  spawnSync('git', ['init', '-q', w.cwd]);
  spawnSync('git', ['-C', w.cwd, 'config', 'user.name', 'Alice Liddell']);
  w.pid.fork = process.ppid; w.sid.fork = 'aaaaaaaa-0000-4000-8000-0000000000f1';
  let r = w.hook('join', expand(''), { as: 'fork', env: NO_GIT });
  assert.equal(must(r.json).decision, 'block');
  assert.match(must(must(r.json).reason), new RegExp(`already alice in room ${w.code} from another session in this folder[^]*Enter on alice\\.${w.code}`));
  assert.deepEqual(fs.readdirSync(path.join(w.home, 'rooms')), [w.code], 'no second room');
  // Claude Code's record in the old transcript, beside this session's: the conversation went on in the fork
  const dir = path.join(w.userHome, '.claude', 'projects', fs.realpathSync(w.cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${w.sid.alice}.jsonl`), `${JSON.stringify({ type: 'continued-in', continuedInSessionId: w.sid.fork })}\n`);
  r = w.hook('join', expand(''), { as: 'fork', env: NO_GIT });
  assert.equal(must(r.json).decision, undefined, r.stdout);
  const m = seat(w, 'alice');
  assert.deepEqual([m.session_id, m.pid, m.left_at], [w.sid.fork, process.ppid, undefined]);
  assert.deepEqual(fs.readdirSync(path.join(w.home, 'rooms')), [w.code]);
  assert.ok(!w.entries().some(e => /alice (left|rejoined)/.test(e.text || '')), 'the person never left');
});

test('R2 (live verify, verify6/14): a refused /sub-human NAME CODE leaves the seat this session holds as it was (no "left (switched rooms)", no lost row); one that works leaves it, logged', () => {
  const w = new World({ claude: 'sleep', alice: 'act', dana: 'sleep' });
  const before = w.entries().length;
  // dana's name is held by a live seat: refused, and alice is still alice
  const r = w.hook('join', expand(`dana ${w.code}`), { as: 'alice' });
  assert.equal(must(r.json).decision, 'block');
  assert.match(must(must(r.json).reason), new RegExp(`could not join ${w.code} as dana: name taken[^]*; you're still alice in room ${w.code}$`));
  assert.equal(seat(w, 'alice').left_at, undefined);
  assert.equal(must(w.lib(() => identity.resolveBySession(w.sid.alice))).name, 'alice');
  assert.equal(w.entries().length, before, 'nothing logged');
  // a name that is free: the switch happens, and the old seat's leave is logged
  const ok = w.hook('join', expand(`erin ${w.code}`), { as: 'alice' });
  assert.equal(must(ok.json).decision, undefined, ok.stdout);
  assert.ok(seat(w, 'alice').left_at);
  assert.equal(must(w.lib(() => identity.resolveBySession(w.sid.alice))).name, 'erin');
  assert.ok(w.entries().some(e => e.text === 'alice left (switched rooms)'));
});
