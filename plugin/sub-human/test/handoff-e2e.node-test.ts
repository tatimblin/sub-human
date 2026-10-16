// Moving a room's host, three machines on one (three SUB_HUMAN_HOMEs: alice's host A, bob's B, carol's C), the
// real hooks as child processes and the link daemons over the pipe transport. `claude` is a stub per machine that
// records its calls, so the room Claude's move shows as a `stop` on A and a `--bg` on B.
//   planned: alice's /sub-human handoff bob -> bob's tail wakes his Claude -> the hooks' card -> "Host it here":
//     host_changed (epoch 1, both seats' signatures) on every machine, B hosts (no link file), A and C mirror B and
//     post through it, the room's Claude stopped on A and started on B, A's old log refuses lines (STALE)
//   refused: "Not now" leaves everything where it was, and alice's tail says so
//   unreachable: the new host's locator unreachable for the others: they go offline with a reason that says what to
//     do (no hang); a fresh invite from the new host (/sub-human invite, its line, the admit) re-points carol
//   promote: the host gone, bob's promote (refused while online, then with --confirm) takes the room at epoch 1;
//     carol follows with `sub-human demote CODE` and her line pasted (INVITE PIN on stdin) and a bare /sub-human; the old host back is
//     STALE for a mirror at epoch 1, and its demote sets its own log aside and mirrors bob
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { TestContext } from 'node:test';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as identity from '../lib/identity.ts';
import * as envelope from '../lib/room/envelope.ts';
import * as linkSocket from '../lib/remote/link-socket.ts';
import * as linkConnect from '../lib/remote/link-connect.ts';
import * as links from '../lib/room/links.ts';
import * as handoff from '../lib/handoff.ts';
import * as client from '../lib/remote/client.ts';
import * as transports from '../lib/remote/transports/index.ts';
import { isAlive } from '../lib/io.ts';
import { Machine, type Seat } from './support/two-homes.ts';
import type { Entry } from '../lib/room/types.ts';
import type { HandoffAskDoc } from '../lib/types-app.ts';
import type { LinkSpec, PipeSpec, SshSpec } from '../lib/remote/types-rest.ts';

/** h.until, failing the test when fn never holds. */
async function until<T>(fn: () => T, ms: number, step: number): Promise<T> {
  const v = await h.until(fn, ms, step);
  assert.ok(v, `timed out: ${fn}`);
  return v;
}

const LINK_ENV = { SUB_HUMAN_LINK_RETRY_MS: '300', SUB_HUMAN_LINK_IDLE_MS: '20000' };

/** A stub claude: its path and the argv of every call so far. */
interface Stub { bin: string; calls: () => string[][] }
/** A Machine with this file's extras (machine() sets them). */
type TestMachine = Machine & {
  stub: Stub;
  cli: (args: string[], extra?: Record<string, string>, input?: string) => SpawnSyncReturns<string>;
  status: (code: string) => ReturnType<typeof linkSocket.status>;
  store: (code: string) => ReturnType<typeof store.open>;
  read: (code: string) => readonly Entry[];
};
/** room()'s machines and seats: carol's only when she was asked for. */
interface Room { A: TestMachine; B: TestMachine; alice: Seat; bob: Seat; code: string }
interface RoomWithCarol extends Room { C: TestMachine; carol: Seat }
/** The card the consent hook's Pre rewrites AskUserQuestion's input to. */
interface Card { questions: { question: string; options: { description: string }[] }[] }

/** A stub claude that appends its argv to calls.jsonl; `--bg` prints the backgrounded line with job id `job`. */
function stubClaude(t: TestContext, job: string): Stub {
  const dir = h.tmpDir('sh-stub-', t);
  const log = path.join(dir, 'calls.jsonl');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`
    + `if (process.argv.includes('--bg')) console.log('backgrounded · ${job} · claude.x');\n`);
  fs.chmodSync(bin, 0o755);
  const calls = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as string[]); } catch { return []; } };
  return { bin, calls };
}

const childOf = (pid: number | undefined) => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = (pid: number | null | undefined) => { try { process.kill(pid as number, 'SIGKILL'); } catch { /* gone */ } };
/** The sh2 invite and its PIN in a text (/sub-human host's block, promote's lines). */
const inviteOf = (text: string) => ({ invite: /sh2\.\S+/.exec(text)![0], pin: /\b(\d{6})\b/.exec(text.slice(text.indexOf('sh2.')))![1] });
const kinds = (log: string) => log.split('\n').filter(Boolean).map(l => (JSON.parse(l) as Entry).kind);
const texts = (log: string) => log.split('\n').filter(Boolean).map(l => (JSON.parse(l) as Entry).text);

/** A machine, its stub claude, and its link daemon stopped when the test ends. */
function machine(t: TestContext, name: string, job: string): TestMachine {
  const stub = stubClaude(t, job);
  // its own TMPDIR: a daemon a pipe's server starts (the old host's follow link) has the dialer's, not this machine's hooks'
  const m = new Machine(t, name, { ...LINK_ENV, SUB_HUMAN_CLAUDE: stub.bin, TMPDIR: h.tmpDir(`sh-tmp-${name}-`, t) }) as TestMachine; // its extras set just below
  m.stub = stub;
  m.cli = (args, extra = {}, input = '') => spawnSync(process.execPath, [h.BIN, ...args], { env: m.env(null, extra), cwd: m.cwd, encoding: 'utf8', timeout: 30_000, input });
  m.status = code => m.lib(() => linkSocket.status(code));
  m.store = code => m.lib(() => store.open(code));
  m.read = code => m.lib(() => store.open(code).readAll());
  t.after(() => {
    for (const code of m.lib(() => store.listRooms())) {
      const st = m.status(code);
      if (st.pid) { kill(childOf(st.pid)); kill(st.pid); }
      fs.rmSync(path.dirname(linkSocket.socketPath(path.join(m.home, 'rooms', code))), { recursive: true, force: true });
    }
  });
  return m;
}

/** alice hosts a room on A; bob (B) and carol (C, when given) join it by invite (the line, alice's admit, the seat). */
async function room(t: TestContext, opts: { carol: false }): Promise<Room>;
async function room(t: TestContext): Promise<RoomWithCarol>;
async function room(t: TestContext, { carol: withCarol = true }: { carol?: boolean } = {}): Promise<Room | RoomWithCarol> {
  const A = machine(t, 'a', 'aaaa1111'), B = machine(t, 'b', 'bbbb2222'), C = withCarol ? machine(t, 'c', 'cccc3333') : null;
  const alice = A.seat('alice'), bob = B.seat('bob'), carol = C && C.seat('carol');
  assert.equal(A.join(alice, 'alice').json!.decision, undefined);
  const code = A.lib(() => store.listRooms()[0]);
  await until(() => A.lib(() => identity.readMembers(code).claude || {}).job === 'aaaa1111', 8000, 50);
  assert.equal((await B.joinVia(A, alice, bob)).seated.json!.systemMessage, undefined);
  if (C && carol) assert.equal((await C.joinVia(A, alice, carol)).seated.json!.systemMessage, undefined);
  return C && carol ? { A, B, C, alice, bob, carol, code } : { A, B, alice, bob, code };
}

/** bob's card: the Pre the hooks rewrite, then his answer on it. */
function answerCard(B: TestMachine, bob: Seat, id: string, label: string) {
  const pre = B.hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `handoff ${id}`, options: [] }] } }, bob);
  const card = pre.json!.hookSpecificOutput!.updatedInput as Card;
  assert.equal(pre.json!.hookSpecificOutput!.permissionDecision, 'ask', pre.stderr);
  const q = card.questions[0].question;
  const post = B.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: card, tool_response: { questions: card.questions, answers: { [q]: label } } }, bob);
  return { card, post };
}

const ask = (B: TestMachine, code: string) => B.lib(() => store.open(code).kv.get<HandoffAskDoc>(handoff.ASK_DOC));

test('handoff e2e: planned, A to B with C following; the room\'s Claude moves; the old host is STALE', async t => {
  const { A, B, C, alice, bob, carol, code } = await room(t);

  // alice asks; bob's machine gets the ask privately, his tail wakes his Claude to open the card
  const asked = A.join(alice, 'handoff bob').json!;
  assert.equal(asked.decision, 'block', 'shown to alice, never to her Claude');
  assert.match(asked.reason!, /^sub-human: asked bob to host room .*: a card asks them until .* UTC, and nothing moves unless they agree\. If they do, the room and its Claude move to bob's machine \(on bob's Claude account\)/);
  await until(() => ask(B, code), 5000, 50);
  assert.equal(C.lib(() => store.open(code).kv.get(handoff.ASK_DOC)), null, 'carol\'s machine never sees it');
  const woke = (await B.tail(bob, 2)).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const id = ask(B, code)!.id;
  assert.match(woke.find(e => e.type === 'wake').text, new RegExp(`call AskUserQuestion with the question "handoff ${id}"`));
  assert.match(woke.filter(e => e.type === 'chat').flatMap(e => e.lines).join('\n'), /alice asks you to host room/);

  // the card says what it costs; bob agrees on it
  const { card, post } = answerCard(B, bob, id, 'Host it here');
  assert.match(card.questions[0].options[0].description, /YOUR model account: your Claude or Bedrock billing and rate limits.*reachable/);
  assert.match(post.json!.systemMessage!, /^sub-human: room \S+ is hosted on this machine now, and its Claude runs on your Claude account/, post.stderr);
  assert.doesNotMatch(post.json!.systemMessage!, /epoch/);
  assert.match(post.json!.hookSpecificOutput!.additionalContext!, /hosted on this machine now/);

  // B hosts: no link, its log names it at epoch 1 with both signatures
  assert.equal(B.lib(() => links.has(code)), false);
  const bs = B.store(code);
  assert.equal(bs.isHost, true);
  const moved = B.read(code).find(e => e.kind === 'host_changed')!;
  assert.deepEqual([moved.epoch, moved.host, moved.machine, moved.from], [1, 'bob', B.lib(() => identity.machineIn(code)), 'alice']);
  B.lib(() => {
    assert.ok(envelope.verify(moved.accept, store.publicKey('bob', store.open(code))), 'bob\'s acceptance');
    assert.ok(envelope.verify(moved.ask, store.publicKey('alice', store.open(code))), 'alice\'s ask');
  });
  assert.equal(B.lib(() => identity.resolveBySession(bob.sid))!.name, 'bob', 'bob\'s seat resolves on the new host');

  // A and C follow: their links point at B and come online; every copy is the same log and chains
  for (const m of [A, C]) {
    // re-pointed first: until its 'moved' event lands, a link may still be online to A's old log (served read-only,
    // the same lines as B's right after the move)
    await until(() => ((m.lib(() => links.get(code)) || { transport: {} }).transport as PipeSpec).home === B.home && m.status(code).state === 'online' && m.log(code) === B.log(code), 10_000, 50);
    assert.equal(m.lib(() => store.open(code).verifyChain()).ok, true);
  }
  assert.equal(A.store(code).isHost, false);

  // the room's Claude: stopped on A (its job), started on B (billed to bob's account)
  // (A's server runs with the env of the pipe that spawned it, bob's daemon's, so the stop may land in either stub)
  await until(() => [...A.stub.calls(), ...B.stub.calls()].some(a => a[0] === 'stop' && a[1] === 'aaaa1111'), 8000, 50);
  await until(() => B.stub.calls().some(a => a.includes('--bg')), 8000, 50);
  await until(() => B.lib(() => identity.readMembers(code).claude || {}).job === 'bbbb2222', 8000, 50);

  // people post through the new host from both old machines
  assert.equal(C.say(carol, 'hello new host').json!.continue, false);
  assert.equal(A.say(alice, 'from the old host').json!.continue, false);
  const last = B.read(code).slice(-2);
  assert.deepEqual(last.map(e => [e.from, e.text]), [['carol', 'hello new host'], ['alice', 'from the old host']]);
  assert.deepEqual(B.lib(() => last.map(e => store.trustOf(e))), ['verified', 'verified']);
  await until(() => A.log(code) === B.log(code) && C.log(code) === B.log(code), 5000, 50);

  // the old host's own log takes no more lines (its file, read as a host's)
  const old = A.lib(() => store.open(code, { dir: path.join(A.home, 'rooms', code) }));
  assert.throws(() => A.lib(() => old.append({ kind: 'say', text: 'stale' }, { via: 'agent', from: 'alice' })), (e: Error & { code?: string }) => e.code === 'STALE');

  // every member saw the move as a room line
  const seen = (await C.tail(carol, 1)) + (await B.tail(bob, 1));
  assert.doesNotMatch(seen, /connection to room \S+ is down/);
  const st = B.cli(['handoff', '--status', '--room', code]);
  assert.match(st.stdout, /hosted on this machine \(bob's machine since #\d+\)/);
  assert.doesNotMatch(st.stdout, /epoch/);
  assert.match(st.stdout, /alice: reconnected here/);
  assert.match(st.stdout, /carol: reconnected here/);
  // the room says how they came: a handoff's invite, which has no PIN
  const after = texts(B.log(code)).slice(texts(B.log(code)).findIndex(x => /moved to bob's machine/.test(x || '')));
  assert.equal(after.filter(x => /followed the room here with the invite its handoff gave it/.test(x || '')).length, 2, after.join('\n'));
  assert.ok(!after.some(x => /with an invite and its PIN/.test(x || '')));
});

test('handoff e2e: "Not now" on the card moves nothing; alice\'s tail says bob declined', async t => {
  const { A, B, alice, bob, code } = await room(t, { carol: false });
  A.join(alice, 'handoff bob');
  await until(() => ask(B, code), 5000, 50);
  const { post } = answerCard(B, bob, ask(B, code)!.id, 'Not now');
  assert.match(post.json!.hookSpecificOutput!.additionalContext!, /bob declined to host room/);
  assert.equal(A.lib(() => handoff.hostDoc(store.open(code)))!.state, 'refused');
  assert.equal(ask(B, code), null);
  assert.equal(B.store(code).isHost, false);
  assert.ok(!kinds(A.log(code)).includes('host_changed'));
  assert.match(await A.tail(alice, 1), /room handoff: bob declined to host room/);
  // a card closed without an answer records nothing either
  A.join(alice, 'handoff bob');
  await until(() => ask(B, code), 5000, 50);
  const pre = B.hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'handoff?' }] } }, bob);
  const card = pre.json!.hookSpecificOutput!.updatedInput as Card;
  const afk = B.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: card, tool_response: { questions: card.questions, answers: {}, afkTimeoutMs: 60000 } }, bob);
  assert.match(afk.json!.hookSpecificOutput!.additionalContext!, /Nothing was decided/);
  assert.equal(A.lib(() => handoff.hostDoc(store.open(code)))!.state, 'asked');
});

test('handoff e2e: a new host the others cannot reach: offline with what to do, no hang; a fresh invite re-points', async t => {
  const { A, B, C, alice, bob, carol, code } = await room(t);
  const nowhere = path.join(os.tmpdir(), `sh-nowhere-${process.pid}`);
  A.lib(() => handoff.ask(code, { from: 'alice', to: 'bob', locator: `pipe:${nowhere}` }));
  await until(() => ask(B, code), 5000, 50);
  assert.match(answerCard(B, bob, ask(B, code)!.id, 'Host it here').post.json!.systemMessage!, /is hosted on this machine now/);

  await until(() => /can't reach yet/.test(C.status(code).reason || ''), 8000, 50);
  assert.match(C.status(code).reason!, /moved to bob's machine, which this machine can't reach yet .*Ask bob for an invite \(\/sub-human invite there\) and type the line it shows here/);
  const t0 = Date.now();
  const queued = C.say(carol, 'anyone?'); // an @room post waits in the outbox (lib/remote/outbox.ts); nothing hangs
  assert.match(JSON.stringify(queued.json), /queued: room .* is offline/, queued.stderr);
  assert.ok(Date.now() - t0 < 8000, 'answered at once, never hung');
  assert.match(await C.tail(carol, 1), /the connection to room \S+ is down \(room .* moved to bob's machine/);

  // bob, now the host, gives carol an invite she can use: her link re-points and she posts through it
  const rejoined = (await C.joinVia(B, bob, carol)).seated;
  assert.equal(rejoined.json!.decision, undefined, rejoined.stdout);
  assert.equal(rejoined.json!.systemMessage, undefined, rejoined.stderr);
  assert.equal((C.lib(() => links.get(code))!.transport as PipeSpec).home, B.home);
  const back = C.say(carol, 'back via a fresh invite');
  assert.equal(back.json!.continue, false, JSON.stringify(back.json) + back.stderr);
  assert.equal(texts(B.log(code)).at(-1), 'back via a fresh invite');
  assert.equal(A.status(code).state === 'online', false, 'alice\'s machine stays offline until it gets one too');
  void alice;
});

test('handoff e2e: promote when the host is gone; the old host back is STALE to a later epoch; demote', async t => {
  const { A, B, C, bob, carol, code } = await room(t);
  const promote = (extra: string[]) => B.cli(['promote', code, '--as', 'bob', ...extra]);

  // refused while the host is reachable, and without the confirmation
  let r = promote(['--confirm', code, '--force']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /reachable \(the link is online\): use a planned handoff/);

  // the host goes away (after bob's copy holds carol's seat: a promote mints invites for the seats it knows)
  await until(() => B.lib(() => identity.readMembers(code).carol), 5000, 50);
  const hostDir = path.join(A.home, 'rooms', code), hidden = `${hostDir}.away`;
  const oldToken = C.lib(() => links.get(code))!.token;
  for (const m of [B, C]) kill(childOf(m.status(code).pid)); // its servers die with it, and no new one finds the room
  fs.renameSync(hostDir, hidden);
  for (const m of [B, C]) await until(() => m.status(code).state === 'offline', 8000, 50);
  r = promote([]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PROMOTE makes this machine's copy .* FORKS/s);
  assert.match(r.stderr, new RegExp(`--confirm ${code}`));
  r = promote(['--confirm', code]);
  assert.match(r.stderr, /has been down \d+ s; promote only after 10 min \(or --force\)/);

  r = promote(['--confirm', code, '--force']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /this machine hosts room \S+ now/);
  assert.doesNotMatch(r.stdout, /epoch|(^|\s)sub-human demote/m);
  assert.match(r.stdout, /carol: run node \S+\/scripts\/sub-human demote \S+ and paste: sh2\.\S+ \d{6}\n.*alice: |alice: run node \S+\/scripts\/sub-human demote \S+ and paste: .*\n.*carol: /, r.stdout);
  const carolInvite = inviteOf(/carol: .*/.exec(r.stdout)![0]), aliceInvite = inviteOf(/alice: .*/.exec(r.stdout)![0]);
  assert.match(B.lib(() => JSON.stringify(store.open(code).kv.get('remote/invites'))), /"machine":/, 'each bound to its machine');
  const e = B.read(code).at(-1)!;
  assert.deepEqual([e.kind, e.epoch, e.host, e.promoted, e.from], ['host_changed', 1, 'bob', true, 'bob']);
  await until(() => B.stub.calls().some(a => a.includes('--bg')), 8000, 50);

  // carol follows bob with her line (in a terminal), then a bare /sub-human takes her seat over the new link
  // the invite and its PIN never as arguments: refused before anything changes
  assert.match(C.cli(['demote', code, carolInvite.invite, carolInvite.pin]).stderr, /on stdin \(or --from FILE\), never as arguments/);
  const fol = C.cli(['demote', code], {}, `${carolInvite.invite} ${carolInvite.pin}\n`);
  assert.equal(fol.status, 0, fol.stderr);
  assert.match(fol.stdout, /Type \/sub-human in your session to join it again/);
  await until(() => C.lib(() => (links.get(code) || {}).token), 8000, 50);
  const back = C.join(carol, '');
  assert.equal(back.json!.decision, undefined, back.stdout);
  await until(() => C.status(code).state === 'online' && C.log(code) === B.log(code), 8000, 50);
  assert.equal(C.say(carol, 'on the promoted host').json!.continue, false);

  // the old host comes back still believing it hosts the room (epoch 0): a mirror at epoch 1 is refused there
  fs.rmSync(hostDir, { recursive: true, force: true });
  fs.renameSync(hidden, hostDir);
  const tr = A.lib(() => transports.open({ kind: 'pipe', home: A.home } as PipeSpec, { code }));
  await assert.rejects(client.connect(tr, { machine: C.lib(() => identity.machineId()), token: oldToken, epoch: 1 }),
    (err: Error & { code?: string }) => err.code === 'STALE' && /moved away from this machine/.test(err.message));

  // demote: its own log is set aside, its room Claude stopped, and it mirrors bob
  const from = path.join(h.tmpDir('sh-demote-', t), 'invite');
  fs.writeFileSync(from, `${aliceInvite.pin}\n${aliceInvite.invite}\n`, { mode: 0o600 }); // either order, a file
  const d = A.cli(['demote', code, '--from', from]);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /follows its new host now; its own log is kept in .*orphaned-/);
  assert.ok(fs.readdirSync(hostDir).some(f => /^orphaned-.*\.jsonl$/.test(f)));
  await until(() => A.stub.calls().some(a => a[0] === 'stop'), 8000, 50);
  await until(() => A.status(code).state === 'online' && A.log(code) === B.log(code), 8000, 50);
  assert.equal(A.store(code).isHost, false);
  assert.equal(isAlive(process.pid), true);
  void bob;
});

test('handoff e2e: over ssh (--via), each follower reaches the new host through its own ssh login (mux kept), with nothing pinned or let in, and is told so while it cannot', async t => {
  const { A, B, C, alice, bob, code } = await room(t);
  const ak = path.join(B.user, '.ssh', 'authorized_keys');
  Object.assign(B.extra, { SUB_HUMAN_AUTHORIZED_KEYS: ak });
  C.lib(() => links.set(code, { ...links.get(code)!, transport: { ...links.get(code)!.transport, mux: true } as LinkSpec })); // a pipe link here, mux to carry over

  // alice: the others reach bob's machine as me@127.0.0.1:1 (nothing listens: they stay offline) through a jump host
  const asked = A.join(alice, 'handoff bob me@127.0.0.1:1 --via jump.example').json!;
  assert.match(asked.reason!, /asked bob to host room/, JSON.stringify(asked));
  assert.equal(A.lib(() => handoff.hostDoc(store.open(code)))!.locator, 'ssh:me@127.0.0.1:1?via=jump.example');
  await until(() => ask(B, code), 5000, 50);
  assert.match(answerCard(B, bob, ask(B, code)!.id, 'Host it here').post.json!.systemMessage!, /is hosted on this machine now/);

  // carol follows over her own ssh login to bob's machine: a login spec, her mux kept, no key, no known_hosts
  await until(() => C.lib(() => (links.get(code) || {}).moved), 10_000, 50);
  const lc = C.lib(() => links.get(code))!;
  const t0 = lc.transport as SshSpec;
  assert.deepEqual([t0.kind, t0.user, t0.host, t0.port, t0.via, t0.login, t0.mux], ['ssh', 'me', '127.0.0.1', 1, 'jump.example', true, true]);
  assert.match(String(t0.link), /^[0-9a-f]{12}$/);
  assert.ok(!('key' in t0) && !('knownHosts' in t0) && !('request' in lc), 'nothing of the plugin\'s own pinned or let in');
  assert.equal(typeof lc.invite, 'string', 'the bound invite bob minted for her machine');
  const cmd = C.lib(() => linkConnect.sshCommand(t0, code, []));
  for (const o of ['ControlMaster=no', '-J', 'jump.example']) assert.ok(cmd.includes(o), `${o} in ${cmd.join(' ')}`);
  assert.ok(!cmd.some(o => /StrictHostKeyChecking|IdentitiesOnly|UserKnownHostsFile/.test(o)), 'the person\'s own ssh config and known_hosts decide');
  assert.match(cmd.at(-1)!, new RegExp(`/bin/serve --stdio ${code} --link ${t0.link} --login$`));
  // offline (nothing listens there); the reason says how: her own login, else a web invite from bob
  await until(() => /can't reach yet/.test(C.status(code).reason || ''), 15_000, 50);
  assert.match(C.status(code).reason!, /Over ssh this machine follows through your own ssh login to bob's machine; without one, ask bob for an invite \(\/sub-human invite --web there\)/);

  // the old host follows the same way
  await until(() => A.lib(() => (links.get(code) || {}).moved), 10_000, 50);
  const la = A.lib(() => links.get(code))!.transport as SshSpec;
  assert.deepEqual([la.kind, la.user, la.host, la.login], ['ssh', 'me', '127.0.0.1', true]);
  assert.ok(!('key' in la));
  assert.equal(fs.existsSync(ak) ? fs.readFileSync(ak, 'utf8').trim() : '', '', 'nothing written to bob\'s authorized_keys');
});

test('handoff and promote CLI: --via carries a ProxyJump into the new locator, as invite --ssh --via does', async t => {
  const { A, B, code } = await room(t, { carol: false });
  const r = A.cli(['handoff', 'bob', '--ssh', 'me@box.example:2222', '--via', 'jump@bastion', '--as', 'alice', '--room', code]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(A.lib(() => handoff.hostDoc(store.open(code)))!.locator, 'ssh:me@box.example:2222?via=jump@bastion');
  const pos = A.cli(['handoff', 'bob', 'me@box.example', '--via', 'j1,j2', '--as', 'alice', '--room', code]);
  assert.equal(pos.status, 0, pos.stderr);
  assert.equal(A.lib(() => handoff.hostDoc(store.open(code)))!.locator, 'ssh:me@box.example?via=j1,j2');
  assert.match(A.cli(['handoff', 'bob', '--via', 'j', '--as', 'alice', '--room', code]).stderr, /--via is for an ssh address/);
  assert.match(A.cli(['handoff', 'bob', '--ssh', 'me@box', '--via', '-oProxyCommand=x', '--as', 'alice', '--room', code]).stderr, /--via needs a plain/);
  assert.match(A.cli(['handoff', 'bob', '--ssh']).stderr, /--ssh needs a value/);
  // promote takes it the same way (refused here only because the host is reachable: the locator was accepted)
  const p = B.cli(['promote', code, '--as', 'bob', '--ssh', 'me@box.example', '--via', 'jump@bastion', '--confirm', code, '--force']);
  assert.match(p.stderr, /reachable \(the link is online\)/);
  assert.match(B.cli(['promote', code, '--as', 'bob', '--ssh', 'me@box', '--via', 'bad host', '--confirm', code, '--force']).stderr, /--via needs a plain/);
});

/** The room's Claude job's own `/sub-human` (agent sub-human:room-claude, SUB_HUMAN_ROOM): it binds the seat "claude". */
function bindRoomClaude(m: TestMachine, code: string) {
  const s = m.seat('claude');
  m.lease(s);
  return m.hook('join', { hook_event_name: 'UserPromptExpansion', command_name: 'sub-human', command_args: '', agent_type: 'sub-human:room-claude' }, s, { env: { SUB_HUMAN_ROOM: code } });
}

test('handoff e2e: the new host\'s claude binds (the old host\'s live claude record, its machine and fresh lease, never holds the name)', async t => {
  const { A, B, alice, bob, code } = await room(t, { carol: false });
  const onA = bindRoomClaude(A, code);
  assert.doesNotMatch(JSON.stringify(onA.json || {}), /could not bind/, onA.stderr);
  const machineA = A.lib(() => identity.machineId());
  await until(() => B.lib(() => (identity.readMembers(code).claude || {}).machine) === machineA, 5000, 50); // B's copy knows it, leased

  A.join(alice, 'handoff bob');
  await until(() => ask(B, code), 5000, 50);
  assert.match(answerCard(B, bob, ask(B, code)!.id, 'Host it here').post.json!.systemMessage!, /is hosted on this machine now/);
  await until(() => B.lib(() => identity.readMembers(code).claude || {}).job === 'bbbb2222', 8000, 50);

  // the job B started runs /sub-human: its seat binds on B
  const onB = bindRoomClaude(B, code);
  assert.doesNotMatch(JSON.stringify(onB.json || {}), /could not bind|name taken/, onB.stderr);
  const o = B.lib(() => identity.readMembers(code).claude);
  assert.equal(o.machine, B.lib(() => identity.machineIn(code)), 'its id in the room, as the old host recorded it');
  assert.equal(o.left_at, undefined);
});
