'use strict';
// Short invites end to end over the pipe transport, two homes on one machine (test/support/two-homes.js): the host's
// /sub-human host --short shows `/sub-human join NAME pipe:HOME CODE 482913` to the person only; the joiner types it
// (a hidden step: the model never sees the code); the link daemon runs CPace with the code (lib/remote/enroll.js) and
// then waits; the host's tail wakes the host seat's Claude, whose card (hooks/consent.js) is the only way in: Let in
// links the machine, Refuse stops it, an AFK card records nothing, and a request nobody answers lapses. A wrong code
// costs a try with a room line, the fifth burns the invite; the code is never in a log, a link file after the
// attempt, or what the model gets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.js'));
const link = require(path.join(h.LIB, 'remote', 'link.js'));
const auth = require(path.join(h.LIB, 'remote', 'auth.js'));
const admission = require(path.join(h.LIB, 'remote', 'admission.js'));
const { Machine } = require('./support/two-homes.js');

const LINK_ENV = { SUB_HUMAN_LINK_RETRY_MS: '200', SUB_HUMAN_LINK_RETRY_MAX_MS: '400', SUB_HUMAN_LINK_IDLE_MS: '1500' };
const childOf = pid => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = pid => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
const stopDaemon = (t, m, code) => t.after(() => {
  const d = m.lib(() => link.status(code));
  if (d.pid) { kill(childOf(d.pid)); kill(d.pid); }
  fs.rmSync(path.dirname(link.socketPath(path.join(m.home, 'rooms', code))), { recursive: true, force: true });
});
const hiddenBlock = r => r.json && r.json.decision === 'block' && r.json.hookSpecificOutput && r.json.hookSpecificOutput.suppressOriginalPrompt === true;
const modelSees = r => JSON.stringify([r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext, r.json && r.json.systemMessage]);
const shown = reason => /\/sub-human join NAME (\S+) ([a-z]+-\d{4}) (\d{6})/.exec(reason);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const v = fn(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}`);
}

function room(t, env = LINK_ENV) {
  const host = new Machine(t, 'host'), remote = new Machine(t, 'remote', env);
  const alice = host.seat('alice'), bob = remote.seat('bob');
  assert.equal(host.join(alice, 'alice').json.decision, undefined);
  const code = host.lib(() => store.listRooms()[0]);
  return { host, remote, alice, bob, code };
}

function card(host, alice, ref, label, extra = {}) {
  const pre = host.hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `admit ${ref}`, options: [] }] } }, alice);
  const c = pre.json.hookSpecificOutput.updatedInput;
  const q = c.questions[0].question;
  const post = host.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: c, tool_response: { questions: c.questions, answers: label ? { [q]: label } : {}, ...extra } }, alice);
  return { pre, card: c, post };
}

test('short code over pipe: host shows one line to the person; join links in a hidden step; the host person\'s card lets the machine in', async t => {
  const { host, remote, alice, bob, code } = room(t);
  const out = host.join(alice, 'host --short');
  assert.ok(hiddenBlock(out), 'the invite: a hidden block');
  assert.equal(out.json.systemMessage, undefined);
  const m = shown(out.json.reason);
  assert.ok(m, out.json.reason);
  assert.equal(m[1], `pipe:${host.home}`);
  assert.equal(m[2], code);
  const pin = m[3];
  assert.match(out.json.reason, /The 6-digit code is the whole secret/);
  assert.match(out.json.reason, /a card here asks you to let them in/);

  const linked = remote.join(bob, `join bob pipe:${host.home} ${code} ${pin}`);
  stopDaemon(t, remote, code);
  assert.ok(hiddenBlock(linked), linked.stderr);
  assert.ok(!modelSees(linked).includes(pin), 'the code is in nothing the model or Remote Control get');
  assert.ok(!linked.json.reason.includes(pin), 'and not echoed');
  assert.match(linked.json.reason, /checked your code\. A card there now asks them to let you in; it names bob \(request [0-9a-f]{6}\)/);
  const lf = JSON.parse(fs.readFileSync(path.join(remote.home, 'links', `${code}.json`), 'utf8'));
  assert.equal('enroll' in lf, false, 'the code left the link file once the host answered');
  assert.equal(JSON.stringify(lf).includes(pin), false);
  assert.equal(typeof lf.invite, 'string');
  assert.equal(typeof lf.awaiting.ref, 'string');

  // nothing gets in before the host person answers: the daemon keeps hearing "waiting"
  const reqs = host.lib(() => admission.pending(code));
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].name, 'bob');
  assert.equal(reqs[0].ref, lf.awaiting.ref);
  await sleep(600);
  assert.notEqual(remote.lib(() => link.status(code)).state, 'online');
  assert.equal(host.lib(() => Object.keys(auth.links(store.open(code)))).length, 0, 'no link yet');

  // the host's tail wakes alice's Claude to open the card, once
  const ev = (await host.tail(alice, 1.5)).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const wake = ev.find(e => e.type === 'wake' && /admit/.test(e.text));
  assert.ok(wake, JSON.stringify(ev));
  assert.match(wake.text, new RegExp(`call AskUserQuestion with the question "admit ${reqs[0].ref}"`));
  assert.ok(!wake.text.includes(pin));

  // an AFK card records nothing
  const afk = card(host, alice, reqs[0].ref, null, { afkTimeoutMs: 60000 });
  assert.match(afk.card.questions[0].question, new RegExp(`Let bob \\(request [0-9a-f]{6}\\) on \\S+ join room ${code}\\? \\(admit ${reqs[0].ref}\\)`));
  assert.deepEqual(afk.card.questions[0].options.map(o => o.label), ['Let in', 'Refuse']);
  assert.match(afk.post.json.hookSpecificOutput.additionalContext, /Nothing was decided/);
  assert.equal(host.lib(() => admission.pending(code)).length, 1);

  // Let in, on the card as the hooks built it
  const yes = card(host, alice, reqs[0].ref, 'Let in');
  assert.match(yes.post.json.hookSpecificOutput.additionalContext, /alice let bob's machine into room/);
  await until(() => remote.lib(() => link.status(code)).state === 'online', 10000, 'the link online');
  const seated = remote.join(bob, `bob ${code}`);
  assert.equal(seated.json.decision, undefined, seated.stdout);
  const said = host.lib(() => store.open(code).readAll()).filter(e => e.from === 'room' && e.kind === 'status').map(e => e.text).join('\n');
  assert.match(said, /bob on \S+ typed the code of invite [0-9a-f]{12}; waiting for alice to let them in/);
  assert.match(said, /alice let bob \(request [0-9a-f]{6}\) on \S+ in \(link [0-9a-f]{12}\)/);
  assert.match(said, /bob's machine \(\S+\) linked to the room, let in by alice \(link [0-9a-f]{12}\)/);
  const admitted = host.lib(() => admission.find(code, reqs[0].ref));
  assert.equal(admitted.admit, 'let-in');
  assert.ok(admitted.admit_sig && admitted.admit_sig.from === 'alice', 'the answer is signed with alice\'s seat key');
  for (const f of [host.log(code), remote.log(code), fs.readFileSync(path.join(remote.home, 'links', `${code}.log`), 'utf8')]) assert.ok(!f.includes(pin), 'the code is in no log');
  const inv = host.lib(() => store.open(code).kv.get(auth.INVITES_KEY));
  assert.ok(!JSON.stringify(inv).includes(`"prs":"${pin}"`), 'the host forgot the code once it was used');
});

test('short code: a wrong code costs a try with a room line; the fifth burns the invite; the right code after a wrong one still works', async t => {
  const { host, remote, alice, bob, code } = room(t);
  const pin = shown(host.join(alice, 'host --short').json.reason)[3];
  const wrong = String((Number(pin) + 1) % 1_000_000).padStart(6, '0');
  stopDaemon(t, remote, code);
  const first = remote.join(bob, `join bob pipe:${host.home} ${code} ${wrong}`);
  assert.ok(hiddenBlock(first));
  assert.match(first.json.reason, /could not link to room \S+: wrong code \(4 tries left\)/);
  assert.ok(!first.json.reason.includes(wrong));
  const lf = JSON.parse(fs.readFileSync(path.join(remote.home, 'links', `${code}.json`), 'utf8'));
  assert.equal('enroll' in lf, false, 'a refused code is dropped from the link file');
  const rejoin = remote.join(bob, `bob ${code}`);
  assert.match(rejoin.json.reason, /wrong code/, 'a rejoin never re-sends a refused code');
  const ok = remote.join(bob, `join bob pipe:${host.home} ${code} ${pin}`);
  assert.match(ok.json.reason, /checked your code/);
  const said = host.lib(() => store.open(code).readAll()).filter(e => e.from === 'room').map(e => e.text).join('\n');
  assert.match(said, /someone typed a wrong code for an invite to this room \(4 tries left\)/);
  assert.ok(!said.includes(wrong) && !said.includes(pin));

  // a second invite: five wrong codes burn it
  const pin2 = shown(host.join(alice, 'host --short').json.reason)[3];
  const bad = String((Number(pin2) + 7) % 1_000_000).padStart(6, '0');
  let last;
  for (let i = 0; i < 5; i++) last = remote.join(bob, `join bob pipe:${host.home} ${code} ${bad}`);
  assert.match(last.json.reason, /that was the last try: the invite is burnt/);
  const after = remote.join(bob, `join bob pipe:${host.home} ${code} ${pin2}`);
  assert.match(after.json.reason, /no code for room \S+ is open here/, 'the right code no longer works once burnt');
});

test('short code: Refuse stops the join; a request nobody answers lapses; revoke NAME withdraws a waiting one', async t => {
  const { host, remote, alice, bob, code } = room(t, { ...LINK_ENV, SUB_HUMAN_ADMIT_TTL_MS: '1500' });
  stopDaemon(t, remote, code);
  // refuse
  let pin = shown(host.join(alice, 'host --short').json.reason)[3];
  remote.join(bob, `join bob pipe:${host.home} ${code} ${pin}`);
  let ref = host.lib(() => admission.pending(code))[0].ref;
  const no = card(host, alice, ref, 'Refuse');
  assert.match(no.post.json.hookSpecificOutput.additionalContext, /alice refused bob; nothing got in/);
  await until(() => remote.lib(() => link.status(code)).state === 'stopped', 8000, 'the joiner\'s link stopped');
  assert.match(remote.lib(() => link.status(code)).reason, /the host refused to let this machine in/);

  // lapse: the request waits ADMIT_TTL_MS, then the host's tail says so and the joiner stops
  pin = shown(host.join(alice, 'host --short').json.reason)[3];
  const carol = remote.seat('carol');
  remote.join(carol, `join carol pipe:${host.home} ${code} ${pin}`);
  ref = host.lib(() => admission.pending(code))[0].ref;
  await sleep(1700);
  const ev = (await host.tail(alice, 1.2)).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(ev.some(e => e.type === 'health' && /nobody let them in/.test(e.text)), JSON.stringify(ev));
  const late = host.hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `admit ${ref}`, options: [] }] } }, alice);
  assert.equal(late.json, null, 'a lapsed request opens no card');
  const q = `Let carol (request ${ref.slice(0, 6)}) on x join room ${code}? (admit ${ref})`;
  const forged = host.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: q }] }, tool_response: { questions: [{ question: q, options: [] }], answers: { [q]: 'Let in' } } }, alice);
  assert.match(forged.json.hookSpecificOutput.additionalContext, /Nothing was decided/, 'an answer on a card the hooks did not build records nothing');
  assert.equal(host.lib(() => admission.find(code, ref)).admit, 'lapsed');
  await until(() => remote.lib(() => link.status(code)).state === 'stopped', 8000, 'the lapsed join stopped');

  // revoke NAME while it waits
  pin = shown(host.join(alice, 'host --short').json.reason)[3];
  const dave = remote.seat('dave');
  remote.join(dave, `join dave pipe:${host.home} ${code} ${pin}`);
  const r = host.join(alice, 'revoke dave');
  assert.match(r.json.reason, /revoked link [0-9a-f]{12}/);
  assert.equal(host.lib(() => admission.pending(code)).length, 0);
});

test('short code: the host CLI masks the code inside Claude Code, `sub-human admit` lists and lets in from a shell', async t => {
  const { host, remote, alice, bob, code } = room(t);
  stopDaemon(t, remote, code);
  const masked = spawnSync(process.execPath, [h.BIN, 'host', '--short'], { env: { ...host.env(null), CLAUDECODE: '1' }, encoding: 'utf8' });
  assert.equal(masked.status, 0, masked.stderr);
  assert.match(masked.stdout, /\/sub-human join NAME \S+ \S+ ######/);
  assert.match(masked.stdout, /PIN hidden/);
  const plain = spawnSync(process.execPath, [h.BIN, 'host', '--short'], { env: host.env(null), encoding: 'utf8' });
  const pin = shown(plain.stdout)[3];
  remote.join(bob, `join bob pipe:${host.home} ${code} ${pin}`);
  const list = spawnSync(process.execPath, [h.BIN, 'admit'], { env: host.env(null), encoding: 'utf8' });
  assert.match(list.stdout, /bob \(request [0-9a-f]{6}\) on \S+ wants to join room/);
  const ref = /^([0-9a-f]{12}) /m.exec(list.stdout)[1];
  const noTty = spawnSync(process.execPath, [h.BIN, 'admit', ref], { env: host.env(null), encoding: 'utf8' });
  assert.equal(noTty.status, 1);
  assert.match(noTty.stderr, /add --yes/);
  const yes = spawnSync(process.execPath, [h.BIN, 'admit', ref, '--yes'], { env: host.env(null), encoding: 'utf8' });
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /let in: bob/);
  await until(() => remote.lib(() => link.status(code)).state === 'online', 10000, 'online');
});
