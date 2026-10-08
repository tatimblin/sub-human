'use strict';
// Moving a room's host, three machines on one (three SUB_HUMAN_HOMEs: alice's host A, bob's B, carol's C), the
// real hooks as child processes and the link daemons over the pipe transport. `claude` is a stub per machine that
// records its calls, so the orch's move shows as a `stop` on A and a `--bg` on B.
//   planned: alice's /sub-human handoff bob -> bob's tail wakes his Claude -> the hooks' card -> "Host it here":
//     host_changed (epoch 1, both seats' signatures) on every machine, B hosts (no link file), A and C mirror B and
//     post through it, the orch stopped on A and started on B, A's old log refuses lines (STALE)
//   refused: "Not now" leaves everything where it was, and alice's tail says so
//   unreachable: the new host's locator unreachable for the others: they go offline with a reason that says what to
//     do (no hang); a fresh invite from the new host re-points carol
//   promote: the host gone, bob's promote (refused while online, then with --confirm) takes the room at epoch 1;
//     carol re-joins by the printed invite; the old host back is STALE for a mirror at epoch 1, and demote sets its
//     own log aside and mirrors bob
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.js'));
const identity = require(path.join(h.LIB, 'identity.js'));
const envelope = require(path.join(h.LIB, 'room', 'envelope.js'));
const link = require(path.join(h.LIB, 'remote', 'link.js'));
const links = require(path.join(h.LIB, 'room', 'links.js'));
const handoff = require(path.join(h.LIB, 'handoff.js'));
const client = require(path.join(h.LIB, 'remote', 'client.js'));
const transports = require(path.join(h.LIB, 'remote', 'transports', 'index.js'));
const { isAlive } = require(path.join(h.LIB, 'io.js'));
const { Machine } = require('./support/two-homes.js');

/** h.until, failing the test when fn never holds. */
async function until(fn, ms, step) {
  const v = await h.until(fn, ms, step);
  assert.ok(v, `timed out: ${fn}`);
  return v;
}

const LINK_ENV = { SUB_HUMAN_LINK_RETRY_MS: '300', SUB_HUMAN_LINK_IDLE_MS: '20000' };

/** A stub claude that appends its argv to calls.jsonl; `--bg` prints the backgrounded line with job id `job`. */
function stubClaude(t, job) {
  const dir = h.tmpDir('sh-stub-', t);
  const log = path.join(dir, 'calls.jsonl');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`
    + `if (process.argv.includes('--bg')) console.log('backgrounded · ${job} · orch.x');\n`);
  fs.chmodSync(bin, 0o755);
  const calls = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  return { bin, calls };
}

const childOf = pid => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = pid => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
const inviteOf = text => /sh1\.\S+/.exec(text)[0];
const kinds = log => log.split('\n').filter(Boolean).map(l => JSON.parse(l).kind);
const texts = log => log.split('\n').filter(Boolean).map(l => JSON.parse(l).text);

/** A machine, its stub claude, and its link daemon stopped when the test ends. */
function machine(t, name, job) {
  const stub = stubClaude(t, job);
  const m = new Machine(t, name, { ...LINK_ENV, SUB_HUMAN_CLAUDE: stub.bin });
  m.stub = stub;
  m.cli = (args, extra = {}) => spawnSync(process.execPath, [h.BIN, ...args], { env: m.env(null, extra), cwd: m.cwd, encoding: 'utf8', timeout: 30_000 });
  m.status = code => m.lib(() => link.status(code));
  m.store = code => m.lib(() => store.open(code));
  m.read = code => m.lib(() => store.open(code).readAll());
  t.after(() => {
    for (const code of m.lib(() => store.listRooms())) {
      const st = m.status(code);
      if (st.pid) { kill(childOf(st.pid)); kill(st.pid); }
      fs.rmSync(path.dirname(link.socketPath(path.join(m.home, 'rooms', code))), { recursive: true, force: true });
    }
  });
  return m;
}

/** alice hosts a room on A; bob (B) and carol (C, when given) join it by invite. */
async function room(t, { carol: withCarol = true } = {}) {
  const A = machine(t, 'a', 'aaaa1111'), B = machine(t, 'b', 'bbbb2222'), C = withCarol ? machine(t, 'c', 'cccc3333') : null;
  const alice = A.seat('alice'), bob = B.seat('bob'), carol = C && C.seat('carol');
  assert.equal(A.join(alice, 'alice').json.decision, undefined);
  const code = A.lib(() => store.listRooms()[0]);
  await until(() => A.lib(() => identity.readMembers(code).orch || {}).job === 'aaaa1111', 8000, 50);
  assert.equal(B.join(bob, `join bob ${inviteOf(A.join(alice, 'host').json.reason)}`).json.systemMessage, undefined);
  if (C) assert.equal(C.join(carol, `join carol ${inviteOf(A.join(alice, 'host').json.reason)}`).json.systemMessage, undefined);
  return { A, B, C, alice, bob, carol, code };
}

/** bob's card: the Pre the hooks rewrite, then his answer on it. */
function answerCard(B, bob, id, label) {
  const pre = B.hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `handoff ${id}`, options: [] }] } }, bob);
  const card = pre.json.hookSpecificOutput.updatedInput;
  assert.equal(pre.json.hookSpecificOutput.permissionDecision, 'ask', pre.stderr);
  const q = card.questions[0].question;
  const post = B.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: card, tool_response: { questions: card.questions, answers: { [q]: label } } }, bob);
  return { card, post };
}

const ask = (B, code) => B.lib(() => store.open(code).kv.get(handoff.ASK_DOC));

test('handoff e2e: planned, A to B with C following; the orch moves; the old host is STALE', async t => {
  const { A, B, C, alice, bob, carol, code } = await room(t);

  // alice asks; bob's machine gets the ask privately, his tail wakes his Claude to open the card
  const asked = A.join(alice, 'handoff bob').json;
  assert.equal(asked.decision, 'block', 'shown to alice, never to her Claude');
  assert.match(asked.reason, /asked bob to host room .*orch then runs on bob's model account/);
  await until(() => ask(B, code), 5000, 50);
  assert.equal(C.lib(() => store.open(code).kv.get(handoff.ASK_DOC)), null, 'carol\'s machine never sees it');
  const woke = (await B.tail(bob, 2)).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const id = ask(B, code).id;
  assert.match(woke.find(e => e.type === 'wake').text, new RegExp(`call AskUserQuestion with the question "handoff ${id}"`));
  assert.match(woke.filter(e => e.type === 'chat').flatMap(e => e.lines).join('\n'), /alice asks you to host room/);

  // the card says what it costs; bob agrees on it
  const { card, post } = answerCard(B, bob, id, 'Host it here');
  assert.match(card.questions[0].options[0].description, /YOUR model account: your Claude or Bedrock billing and rate limits.*reachable/);
  assert.match(post.json.systemMessage, /hosted here now \(epoch 1\)/, post.stderr);
  assert.match(post.json.hookSpecificOutput.additionalContext, /hosted on this machine now/);

  // B hosts: no link, its log names it at epoch 1 with both signatures
  assert.equal(B.lib(() => links.has(code)), false);
  const bs = B.store(code);
  assert.equal(bs.isHost, true);
  const moved = B.read(code).find(e => e.kind === 'host_changed');
  assert.deepEqual([moved.epoch, moved.host, moved.machine, moved.from], [1, 'bob', B.lib(() => identity.machineId()), 'alice']);
  B.lib(() => {
    assert.ok(envelope.verify(moved.accept, store.publicKey('bob', store.open(code))), 'bob\'s acceptance');
    assert.ok(envelope.verify(moved.ask, store.publicKey('alice', store.open(code))), 'alice\'s ask');
  });
  assert.equal(B.lib(() => identity.resolveBySession(bob.sid)).name, 'bob', 'bob\'s seat resolves on the new host');

  // A and C follow: their links point at B and come online; every copy is the same log and chains
  for (const m of [A, C]) {
    await until(() => m.status(code).state === 'online' && m.log(code) === B.log(code), 10_000, 50);
    assert.equal(m.lib(() => links.get(code)).transport.home, B.home);
    assert.equal(m.lib(() => store.open(code).verifyChain()).ok, true);
  }
  assert.equal(A.store(code).isHost, false);

  // the orch: stopped on A (its job), started on B (billed to bob's account)
  // (A's server runs with the env of the pipe that spawned it, bob's daemon's, so the stop may land in either stub)
  await until(() => [...A.stub.calls(), ...B.stub.calls()].some(a => a[0] === 'stop' && a[1] === 'aaaa1111'), 8000, 50);
  await until(() => B.stub.calls().some(a => a.includes('--bg')), 8000, 50);
  await until(() => B.lib(() => identity.readMembers(code).orch || {}).job === 'bbbb2222', 8000, 50);

  // people post through the new host from both old machines
  assert.equal(C.say(carol, 'hello new host').json.continue, false);
  assert.equal(A.say(alice, 'from the old host').json.continue, false);
  const last = B.read(code).slice(-2);
  assert.deepEqual(last.map(e => [e.from, e.text]), [['carol', 'hello new host'], ['alice', 'from the old host']]);
  assert.deepEqual(B.lib(() => last.map(e => store.humanTrust(e))), ['verified', 'verified']);
  await until(() => A.log(code) === B.log(code) && C.log(code) === B.log(code), 5000, 50);

  // the old host's own log takes no more lines (its file, read as a host's)
  const old = A.lib(() => store.open(code, { dir: path.join(A.home, 'rooms', code) }));
  assert.throws(() => A.lib(() => old.append({ kind: 'say', text: 'stale' }, { via: 'agent', from: 'alice' })), e => e.code === 'STALE');

  // every member saw the move as a room line
  const seen = (await C.tail(carol, 1)) + (await B.tail(bob, 1));
  assert.doesNotMatch(seen, /OFFLINE/);
  const st = B.cli(['handoff', '--status', '--room', code]);
  assert.match(st.stdout, /hosted on this machine; host epoch 1 \(bob's machine/);
  assert.match(st.stdout, /alice: reconnected here/);
  assert.match(st.stdout, /carol: reconnected here/);
});

test('handoff e2e: "Not now" on the card moves nothing; alice\'s tail says bob declined', async t => {
  const { A, B, alice, bob, code } = await room(t, { carol: false });
  A.join(alice, 'handoff bob');
  await until(() => ask(B, code), 5000, 50);
  const { post } = answerCard(B, bob, ask(B, code).id, 'Not now');
  assert.match(post.json.hookSpecificOutput.additionalContext, /bob declined to host room/);
  assert.equal(A.lib(() => handoff.hostDoc(store.open(code))).state, 'refused');
  assert.equal(ask(B, code), null);
  assert.equal(B.store(code).isHost, false);
  assert.ok(!kinds(A.log(code)).includes('host_changed'));
  assert.match(await A.tail(alice, 1), /room handoff: bob declined to host room/);
  // a card closed without an answer records nothing either
  A.join(alice, 'handoff bob');
  await until(() => ask(B, code), 5000, 50);
  const pre = B.hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'handoff?' }] } }, bob);
  const card = pre.json.hookSpecificOutput.updatedInput;
  const afk = B.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: card, tool_response: { questions: card.questions, answers: {}, afkTimeoutMs: 60000 } }, bob);
  assert.match(afk.json.hookSpecificOutput.additionalContext, /Nothing was decided/);
  assert.equal(A.lib(() => handoff.hostDoc(store.open(code))).state, 'asked');
});

test('handoff e2e: a new host the others cannot reach: offline with what to do, no hang; a fresh invite re-points', async t => {
  const { A, B, C, alice, bob, carol, code } = await room(t);
  const nowhere = path.join(os.tmpdir(), `sh-nowhere-${process.pid}`);
  A.lib(() => handoff.ask(code, { from: 'alice', to: 'bob', locator: `pipe:${nowhere}` }));
  await until(() => ask(B, code), 5000, 50);
  assert.match(answerCard(B, bob, ask(B, code).id, 'Host it here').post.json.systemMessage, /hosted here now/);

  await until(() => /cannot reach yet/.test(C.status(code).reason || ''), 8000, 50);
  assert.match(C.status(code).reason, /moved to bob's machine \(pipe:.*sh-nowhere.*\), which this machine cannot reach yet .*\/sub-human join NAME INVITE/);
  const t0 = Date.now();
  const refused = C.say(carol, 'anyone?');
  assert.equal(refused.json.decision, 'block');
  assert.ok(Date.now() - t0 < 8000, 'refused at once, never hung');
  assert.match(await C.tail(carol, 1), /room link: OFFLINE \(room .* moved to bob's machine/);

  // bob, now the host, gives carol an invite she can use: her link re-points and she posts through it
  const fresh = inviteOf(B.join(bob, 'host').json.reason);
  const rejoined = C.join(carol, `join carol ${fresh}`);
  assert.equal(rejoined.json.systemMessage, undefined, rejoined.stderr);
  assert.equal(C.lib(() => links.get(code)).transport.home, B.home);
  const back = C.say(carol, 'back via a fresh invite');
  assert.equal(back.json.continue, false, JSON.stringify(back.json) + back.stderr);
  assert.equal(texts(B.log(code)).at(-1), 'back via a fresh invite');
  assert.equal(A.status(code).state === 'online', false, 'alice\'s machine stays offline until it gets one too');
  void alice;
});

test('handoff e2e: promote when the host is gone; the old host back is STALE to a later epoch; demote', async t => {
  const { A, B, C, bob, carol, code } = await room(t);
  const promote = extra => B.cli(['promote', code, '--as', 'bob', ...extra]);

  // refused while the host is reachable, and without the confirmation
  let r = promote(['--confirm', code, '--force']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /reachable \(the link is online\): use a planned handoff/);

  // the host goes away (after bob's copy holds carol's seat: a promote mints invites for the seats it knows)
  await until(() => B.lib(() => identity.readMembers(code).carol), 5000, 50);
  const hostDir = path.join(A.home, 'rooms', code), hidden = `${hostDir}.away`;
  const oldToken = C.lib(() => links.get(code)).token;
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
  assert.match(r.stdout, /this machine hosts room .* now \(host epoch 1\)/);
  assert.match(r.stdout, /carol: .*\n.*alice: |alice: .*\n.*carol: /, r.stdout);
  const carolInvite = inviteOf(/carol: .*/.exec(r.stdout)[0]), aliceInvite = inviteOf(/alice: .*/.exec(r.stdout)[0]);
  const e = B.read(code).at(-1);
  assert.deepEqual([e.kind, e.epoch, e.host, e.promoted, e.from], ['host_changed', 1, 'bob', true, 'bob']);
  await until(() => B.stub.calls().some(a => a.includes('--bg')), 8000, 50);

  // carol re-joins by her invite and follows bob
  assert.equal(C.join(carol, `join carol ${carolInvite}`).json.systemMessage, undefined);
  await until(() => C.status(code).state === 'online' && C.log(code) === B.log(code), 8000, 50);
  assert.equal(C.say(carol, 'on the promoted host').json.continue, false);

  // the old host comes back still believing it hosts the room (epoch 0): a mirror at epoch 1 is refused there
  fs.rmSync(hostDir, { recursive: true, force: true });
  fs.renameSync(hidden, hostDir);
  const tr = A.lib(() => transports.open({ kind: 'pipe', home: A.home }, { code }));
  await assert.rejects(client.connect(tr, { machine: C.lib(() => identity.machineId()), token: oldToken, epoch: 1 }),
    err => err.code === 'STALE' && /moved away from this host/.test(err.message));

  // demote: its own log is set aside, its orch stopped, and it mirrors bob
  const d = A.cli(['demote', code, aliceInvite]);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /mirrors its new host now; its own log is kept in .*orphaned-/);
  assert.ok(fs.readdirSync(hostDir).some(f => /^orphaned-.*\.jsonl$/.test(f)));
  await until(() => A.stub.calls().some(a => a[0] === 'stop'), 8000, 50);
  await until(() => A.status(code).state === 'online' && A.log(code) === B.log(code), 8000, 50);
  assert.equal(A.store(code).isHost, false);
  assert.equal(isAlive(process.pid), true);
  void bob;
});
