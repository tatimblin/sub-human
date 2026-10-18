// Invites end to end over the pipe transport, two homes on one machine (test/support/two-homes.ts): the host's
// /sub-human invite --pipe shows `/sub-human join pipe:HOME ROOM SECRET` and, apart from it, a 4-digit PIN, to the
// person only; the joiner types the line (a hidden step: the model never sees the SECRET), the link daemon checks the
// host's key against it and shows the host the SECRET, which knocks (the host's card waits), and the joiner types
// `/sub-human join PIN` while it waits (hidden too), or types the PIN after the line, which sends it in the first hello
// once the host's key is checked; the right PIN links the machine in that hello, with no card (a room line names its
// check and the kick), and the hooks module then takes the seat in a turn of its own (the tail's take event, the join
// hook with sub_human_take: PLAN-JOIN step 3), its line naming the same check; a bare /sub-human still does, where no
// module took it. The line with no PIN knocks: the host seat's Claude is woken to open the card (hooks/consent.ts), the
// knock's only way in but the PIN typed meanwhile: Let in links the machine, Refuse stops it, an AFK card records
// nothing, and a request nobody answers lapses. A wrong PIN costs a try with a room line and is asked for again, the
// fifth burns the invite; neither the SECRET nor the PIN is ever in a log, a link file after the host answered it, or
// what the model gets.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as linkSocket from '../lib/remote/link-socket.ts';
import * as invites from '../lib/remote/invites.ts';
import * as hostLinks from '../lib/remote/host-links.ts';
import * as admission from '../lib/remote/admission.ts';
import { Machine, shownInvite, childOf, kill, hiddenBlock, stopDaemon } from './support/two-homes.ts';
import type { MachineRun, Seat } from './support/two-homes.ts';
import * as identityLib from '../lib/identity.ts';
import * as hosting from '../lib/remote/hosting.ts';
import * as inviteSecret from '../lib/remote/invite-secret.ts';
import type { Invites } from '../lib/remote/types-core.ts';
import * as links from '../lib/room/links.ts';
import type { RoomCode } from '../lib/brand.ts';
import type { Link } from '../lib/room/types.ts';
import type { TailEvent } from '../lib/types-app.ts';
import { must } from './support/must.ts';

const LINK_ENV: Record<string, string> = { SUB_HUMAN_LINK_RETRY_MS: '200', SUB_HUMAN_LINK_RETRY_MAX_MS: '400', SUB_HUMAN_LINK_IDLE_MS: '1500' };
const modelSees = (r: MachineRun) => JSON.stringify([r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext, r.json && r.json.systemMessage]);
const shown = (reason: string | undefined) => must(shownInvite(String(reason)), 'an invite line');
const reason = (r: MachineRun) => must(must(r.json, 'a hook answer').reason, 'a reason');
const ctx = (r: MachineRun) => must(must(r.json, 'a hook answer').hookSpecificOutput?.additionalContext, 'context');
/** The module's reply (hooks/reply.ts {subHuman: {say, joined?}}), as join.ts printed it for a run the module made. */
function subHuman(r: MachineRun): { say: string; joined: boolean } {
  const o: unknown = JSON.parse(r.stdout);
  const s: unknown = o && typeof o === 'object' && 'subHuman' in o ? o.subHuman : null;
  if (!s || typeof s !== 'object' || !('say' in s) || typeof s.say !== 'string') throw new Error(`no module reply: ${r.stdout} ${r.stderr}`);
  return { say: s.say, joined: 'joined' in s && s.joined === true };
}
const linkFile = (m: Machine, code: RoomCode) => JSON.parse(fs.readFileSync(path.join(m.home, 'links', `${code}.json`), 'utf8')) as Link; // the record as stored
const events = (out: string) => out.split('\n').filter(Boolean).map(l => JSON.parse(l) as TailEvent); // a tail's NDJSON
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => T, ms = 8000, what = 'condition'): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const v = fn(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}`);
}

function room(t: TestContext, env = LINK_ENV) {
  const host = new Machine(t, 'host'), remote = new Machine(t, 'remote', env);
  const alice = host.seat('alice'), bob = remote.seat('bob');
  assert.equal(must(host.join(alice, 'alice').json).decision, undefined);
  const code = must(host.lib(() => store.listRooms()[0]), 'the room');
  return { host, remote, alice, bob, code };
}

// the card the hooks built (consent's PreToolUse updatedInput)
interface Card { questions: { question: string; options: { label: string }[] }[] }

function card(host: Machine, alice: Seat, ref: string, label: string | null, extra = {}) {
  const pre = host.hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `admit ${ref}`, options: [] }] } }, alice);
  const c = must(must(pre.json).hookSpecificOutput).updatedInput as Card;
  const q = must(c.questions[0]).question;
  const post = host.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: c, tool_response: { questions: c.questions, answers: label ? { [q]: label } : {}, ...extra } }, alice);
  return { pre, card: c, post };
}

/** The line typed on the remote home with no PIN (hidden): it knocks; resolves once the host's card waits for it (the
 * link file's awaiting). */
async function typeLine(remote: Machine, seat: Seat, code: RoomCode, line: string, as: string) {
  const r = remote.join(seat, `${line} --as ${as}`);
  await until(() => remote.lib(() => !!(links.get(code) || {}).awaiting), 15_000, 'the host\'s card waiting');
  return r;
}

test('an invite over pipe: the host sees the line and the PIN apart; the line alone knocks, then the PIN, typed while the card waits, links in hidden steps; the right PIN lets the machine in with no card, and the room hears its check; the module takes the seat in a turn of its own, with the same check', async t => {
  const { host, remote, alice, bob, code } = room(t);
  const out = host.join(alice, 'invite --pipe');
  assert.ok(hiddenBlock(out), 'the invite: a hidden block');
  assert.equal(must(out.json).systemMessage, undefined);
  const m = shown(reason(out));
  assert.ok(m, reason(out));
  assert.equal(m.dest, `pipe:${host.home}`);
  assert.equal(m.code, code);
  const { pin, word } = m;
  assert.match(reason(out), /tell them its PIN apart from the line \(say it, or send it another way\): \d{4}\n/);
  assert.ok(!new RegExp(`join \\S+ \\S+ ${word}[^\\n]*${pin}`).test(reason(out)), 'the PIN is not on the line');
  assert.match(reason(out), /The right PIN lets them in with no card: the room shows who joined, with a check and the kick\./);
  assert.doesNotMatch(reason(out), /a card here asks you/);
  // noise pass C: no version line for the host (an older joiner is told when it dials)
  assert.doesNotMatch(reason(out), /They need sub-human/);
  assert.doesNotMatch(reason(out), /PIN must be 4 digits/, 'an older (protocol 3) joiner meets the version skew, not a PIN rule');

  stopDaemon(t, remote, code);
  const typed = await typeLine(remote, bob, code, m.line, 'bob');
  assert.ok(hiddenBlock(typed), typed.stderr);
  for (const r of [typed]) assert.ok(!modelSees(r).includes(word) && !reason(r).includes(word), 'the SECRET is in nothing the model or Remote Control get, and not echoed');
  const lf0 = linkFile(remote, code);
  assert.equal(lf0.invite, word);
  assert.equal(lf0.pin_wanted, undefined, 'the line alone is no PIN step: it knocks');
  assert.match(reason(typed), new RegExp(`Asked the host to let you in to room ${code} \\(their card shows check [0-9a-f]{4}-[0-9a-f]{4}\\)\\. If they gave you a PIN: /sub-human join PIN\\.`));
  assert.match(reason(typed), /Once they do, type \/sub-human to join/, 'typed with no hooks module (classic): nothing takes the seat on its own, so it says the bare /sub-human');
  assert.equal(host.lib(() => admission.pending(code)).length, 1, 'the line alone asks the host\'s card');
  const knocked = must(host.lib(() => invites.findInvite(store.open(code), must(host.lib(() => admission.pending(code))[0]).from)), 'the invite').invite;
  assert.ok(knocked.short === true && knocked.tries === 5 && knocked.used_at, 'the knock used the invite, and spent no try');
  const bare0 = remote.join(bob, '');
  assert.match(reason(bare0), /Asked the host to let you in/, 'a bare /sub-human says it waits, never takes a seat');
  const early = remote.take(bob, code);
  assert.deepEqual(subHuman(early), { say: '', joined: false }, 'the module\'s take before the host let it in: nothing');
  assert.equal(remote.lib(() => identityLib.resolveBySession(bob.sid)), null, 'no seat, and never a room of its own');

  // the right PIN, typed while the card waits, lets the machine in with no card: the command's own answer says it is linked
  // (typed through the hooks module, which takes the seat itself: the answer says so)
  const linked = remote.modJoin(bob, `join ${pin}`);
  assert.ok(!linked.stdout.includes(pin) && !linked.stderr.includes(pin), 'the PIN is in nothing the model or Remote Control get, and not echoed');
  assert.match(subHuman(linked).say, new RegExp(`the host let you in to room ${code}: this session takes your seat as bob now`));
  const lf = linkFile(remote, code);
  assert.equal('pin' in lf, false, 'the PIN left the link file once the host answered');
  assert.equal('pin_wanted' in lf, false);
  assert.equal('awaiting' in lf, false, 'nothing waits for a card');
  assert.equal('invite' in lf, false, 'the line is spent: the token replaced it');
  assert.ok(lf.token, 'linked in the PIN\'s own hello');
  assert.equal(lf.join_as, 'bob', 'the seat it takes');
  assert.equal(JSON.stringify(lf).includes(`"${pin}"`), false);
  await until(() => remote.lib(() => linkSocket.status(code)).state === 'online', 10000, 'the link online');

  // no card on the host any more: the knock's request was let in by the PIN, no wake for alice's Claude; the room line
  // names the check and the kick
  assert.equal(host.lib(() => admission.pending(code)).length, 0, 'nothing waits for the host person');
  const ev = events(await host.tail(alice, 1.5));
  assert.ok(!ev.some(e => e.type === 'wake' && /admit/.test(e.text)), JSON.stringify(ev));
  const rec = must(host.lib(() => admission.admissions(store.open(code), { all: true }))[0], 'the admission record');
  assert.deepEqual([rec.admit, rec.admitted_by, rec.admit_sig, rec.name], ['let-in', 'pin', undefined, 'bob']);
  const said = host.lib(() => store.open(code).readAll()).filter(e => e.from === 'room' && e.kind === 'status').map(e => e.text).join('\n');
  assert.match(said, /^bob joined from \S+ \(check [0-9a-f]{4}-[0-9a-f]{4}\) · not them\? \/sub-human kick bob$/m);
  assert.doesNotMatch(said, /waiting for alice to let them in|let in by/);
  const check = must(/\((check [0-9a-f]{4}-[0-9a-f]{4})\)/.exec(said), 'the room line\'s check')[1];

  // bob's tail, with no seat: one take event (the command's answer said it already, so no chat), with the same check
  const told = events(await remote.tail(bob, 2));
  const takes = told.filter((e): e is Extract<TailEvent, { type: 'take' }> => e.type === 'take');
  assert.equal(takes.length, 1, JSON.stringify(told));
  assert.deepEqual(takes[0], { type: 'take', code, name: 'bob', text: `the host let you in to room ${code}: type /sub-human to join it as bob`, check });
  assert.equal(told.filter(e => e.type === 'chat').length, 0, JSON.stringify(told));
  // the module takes it (mod/deliver.ts takeSeat): the seat's block for the model, in a run whose prompt holds nothing
  const seated = remote.take(bob, code);
  assert.equal(subHuman(seated).joined, true, seated.stdout);
  assert.match(ctx(seated), /^SUB-HUMAN: you are bob's Claude in room /);
  assert.ok(!ctx(seated).includes(pin) && !ctx(seated).includes(word), 'neither the PIN nor the SECRET is in the block');
  assert.ok(remote.lib(() => identityLib.readMembers(code)).bob, 'bob is seated');
  assert.equal('join_as' in linkFile(remote, code), false, 'the seat is taken: nothing pending');
  assert.deepEqual(subHuman(remote.take(bob, code)), { say: '', joined: false }, 'a second take (a tail started again): nothing, not a status');
  for (const f of [host.log(code), remote.log(code), fs.readFileSync(path.join(remote.home, 'links', `${code}.log`), 'utf8')]) {
    assert.ok(!f.includes(` ${pin}`) && !f.includes(word), 'neither the PIN nor the SECRET is in any log');
  }
  const inv = JSON.stringify(host.lib((): unknown => store.open(code).kv.get(invites.INVITES_KEY)));
  assert.ok(!inv.includes(`"${pin}"`) && !inv.includes(word), 'the host keeps neither in clear');
});

test('a knock (the line with no PIN): the host\'s tail wakes its Claude to open the card once; an AFK card records nothing; Let in links the machine, signed; its session\'s tail asks the module to take the seat; with no module there, a bare /sub-human takes it', async t => {
  const { host, remote, alice, bob, code } = room(t);
  const m = shown(reason(host.join(alice, 'invite --pipe')));
  stopDaemon(t, remote, code);
  await typeLine(remote, bob, code, m.line, 'bob');
  const awaiting = must(linkFile(remote, code).awaiting, 'awaiting');
  const hello = remote.hook('mod-hello', { nonce: bob.nonce }, bob).json as { seat: unknown; pending?: boolean };
  assert.deepEqual([hello.seat, hello.pending], [null, true], 'no seat, an invite join waiting: the module starts the tail');

  // nothing gets in before the host person answers: the daemon keeps hearing "waiting"
  const reqs = host.lib(() => admission.pending(code));
  assert.equal(reqs.length, 1);
  const req0 = must(reqs[0]);
  assert.equal(req0.name, 'bob');
  assert.equal(req0.ref, awaiting.ref);
  await sleep(600);
  assert.notEqual(remote.lib(() => linkSocket.status(code)).state, 'online');
  assert.equal(host.lib(() => Object.keys(hostLinks.links(store.open(code)))).length, 0, 'no link yet');

  // the host's tail wakes alice's Claude to open the card, once
  const ev = events(await host.tail(alice, 1.5));
  const wake = ev.find((e): e is Extract<TailEvent, { type: 'wake' }> => e.type === 'wake' && /admit/.test(e.text));
  assert.ok(wake, JSON.stringify(ev));
  assert.match(wake.text, new RegExp(`call AskUserQuestion with the question "admit ${req0.ref}"`));
  assert.match(wake.text, /typed your invite line without its PIN and asks to join/);
  assert.ok(!wake.text.includes(m.pin) && !wake.text.includes(m.word));

  // an AFK card records nothing
  const afk = card(host, alice, req0.ref, null, { afkTimeoutMs: 60000 });
  const aq = must(afk.card.questions[0]);
  assert.match(aq.question, new RegExp(`Let bob \\(check [0-9a-f]{4}-[0-9a-f]{4}\\) on \\S+ join room ${code}\\? \\(admit ${req0.ref}\\)`));
  assert.ok(aq.question.includes(`(${awaiting.check})`), 'the card shows the check the joiner\'s screen shows: its machine\'s, not the line\'s');
  assert.deepEqual(aq.options.map(o => o.label), ['Let in', 'Refuse']);
  assert.match(ctx(afk.post), /Nothing was decided/);
  assert.equal(host.lib(() => admission.pending(code)).length, 1);

  // Let in, on the card as the hooks built it
  const yes = card(host, alice, req0.ref, 'Let in');
  assert.match(ctx(yes.post), /alice let bob's machine into room/);
  await until(() => remote.lib(() => linkSocket.status(code)).state === 'online', 10000, 'the link online');
  // the joiner's session, still without a seat: its tail asks the module to take it, once, with the line the person
  // reads when nothing takes it (the session closed), and the check the card showed
  const told = events(await remote.tail(bob, 2));
  const letIn = told.filter((e): e is Extract<TailEvent, { type: 'take' }> => e.type === 'take');
  assert.deepEqual(letIn, [{ type: 'take', code, name: 'bob', text: `the host let you in to room ${code}: type /sub-human to join it as bob`, check: awaiting.check }], JSON.stringify(told));
  // the bare fallback: no module took it, the person types /sub-human
  const seated = remote.join(bob, '');
  assert.equal(must(seated.json).decision, undefined, seated.stdout);
  assert.ok(remote.lib(() => identityLib.readMembers(code)).bob, 'bob is seated');
  const said = host.lib(() => store.open(code).readAll()).filter(e => e.from === 'room' && e.kind === 'status').map(e => e.text).join('\n');
  assert.match(said, /alice let bob \(check [0-9a-f]{4}-[0-9a-f]{4}\) on \S+ in; undo with: \/sub-human kick bob/);
  assert.match(said, /bob's machine \(\S+\) joined the room, let in by alice; undo with: \/sub-human kick bob/);
  const admitted = must(host.lib(() => admission.find(code, req0.ref)));
  assert.equal(admitted.admit, 'let-in');
  assert.ok(admitted.admit_sig && (admitted.admit_sig as { from?: string }).from === 'alice', 'the answer is signed with alice\'s seat key');
});

test('an invite in one line: the line with the PIN after it links in one hidden step (the PIN in the first hello, once the host\'s key is checked); the right PIN lets the machine in with no card, and the room hears its check', async t => {
  const { host, remote, alice, bob, code } = room(t);
  const m = shown(reason(host.join(alice, 'invite --pipe')));
  stopDaemon(t, remote, code);
  const typed = remote.join(bob, `${m.line} ${m.pin} --as bob`);
  assert.ok(hiddenBlock(typed), typed.stderr);
  for (const s of [m.pin, m.word]) assert.ok(!modelSees(typed).includes(s) && !reason(typed).includes(s), 'neither the PIN nor the SECRET reaches the model, nor is echoed');
  await until(() => remote.lib(() => (links.get(code) || {}).token), 8000, 'linked in the first hello');
  const lf = linkFile(remote, code);
  assert.equal('pin' in lf, false, 'the PIN left the link file once the host answered');
  assert.equal('pin_wanted' in lf, false, 'the host never asked for it');
  assert.equal('awaiting' in lf, false, 'nothing waits for a card');
  assert.equal(lf.join_as, 'bob');
  assert.equal(host.lib(() => admission.pending(code)).length, 0, 'no card on the host');
  const rec = must(host.lib(() => admission.admissions(store.open(code), { all: true }))[0], 'the admission record');
  assert.deepEqual([rec.admit, rec.admitted_by, rec.name], ['let-in', 'pin', 'bob']);
  const said = host.lib(() => store.open(code).readAll()).filter(e => e.from === 'room' && e.kind === 'status').map(e => e.text).join('\n');
  assert.match(said, /^bob joined from \S+ \(check [0-9a-f]{4}-[0-9a-f]{4}\) · not them\? \/sub-human kick bob$/m);
  await until(() => remote.lib(() => linkSocket.status(code)).state === 'online', 10000, 'the link online');
  assert.equal(must(remote.join(bob, '').json).decision, undefined, 'a bare /sub-human takes the seat');
  assert.ok(remote.lib(() => identityLib.readMembers(code)).bob, 'bob is seated');
  for (const f of [host.log(code), remote.log(code), fs.readFileSync(path.join(remote.home, 'links', `${code}.log`), 'utf8')]) {
    assert.ok(!f.includes(` ${m.pin}`) && !f.includes(m.word), 'neither the PIN nor the SECRET is in any log');
  }
});

test('an invite in one line: a wrong PIN on the line costs a try and is asked for again, never a card; a line for another host sends neither the SECRET nor the PIN', async t => {
  const { host, remote, alice, bob, code } = room(t);
  const m = shown(reason(host.join(alice, 'invite --pipe')));
  const tries = (word: string) => {
    const ref = invites.inviteRef(inviteSecret.idOf(must(inviteSecret.decode(word)).secret));
    const rec = must(Object.entries(host.lib(() => store.open(code).kv.get<Invites>(invites.INVITES_KEY)) ?? {}).find(([k]) => k.startsWith(ref)), 'the invite')[1];
    return 'tries' in rec ? rec.tries : null;
  };
  const wrong = String((Number(m.pin) + 1) % 10_000).padStart(4, '0');
  stopDaemon(t, remote, code);
  const typed = remote.join(bob, `${m.line} ${wrong} --as bob`);
  assert.ok(hiddenBlock(typed) && !reason(typed).includes(wrong));
  await until(() => remote.lib(() => (links.get(code) || {}).pin_wanted?.why === 'PIN_WRONG'), 8000, 'the host refusing the PIN');
  assert.equal(tries(m.word), 4, 'one try spent');
  assert.equal('pin' in linkFile(remote, code), false, 'a refused PIN is dropped from the link file');
  assert.match(reason(remote.join(bob, '')), /wrong PIN \(4 tries left\)\. Check the digits with the host, then type it again: \/sub-human join PIN/);
  assert.equal(host.lib(() => admission.pending(code)).length, 0, 'a wrong PIN never makes a card');

  // a line whose tag names another machine's key: the host's proof does not match, so neither the SECRET nor the PIN goes
  const other = new Machine(t, 'other', LINK_ENV);
  const carol = other.seat('carol');
  stopDaemon(t, other, code);
  const m2 = shown(reason(host.join(alice, 'invite --pipe')));
  const d = must(inviteSecret.decode(m2.word));
  const forged = inviteSecret.encode(d.secret, inviteSecret.tagOf(d.secret, 'machine', Buffer.alloc(32, 9).toString('base64url')));
  other.join(carol, `${m2.line.replace(m2.word, forged)} ${m2.pin} --as carol`);
  await until(() => other.lib(() => (links.get(code) || {}).refused), 8000, 'the refusal');
  assert.equal(must(other.lib(() => links.get(code))?.refused).why, 'HOST_KEY_MISMATCH');
  const lf = linkFile(other, code);
  assert.equal('pin' in lf || 'invite' in lf, false, 'the line and its PIN are dropped');
  assert.equal(tries(m2.word), 5, 'no try spent: the host never saw the PIN');
  assert.equal(host.lib(() => admission.pending(code)).length, 0);
});

test('an invite: a wrong PIN costs a try with a room line and is asked for again; the right one too soon waits; after the wait it works', async t => {
  const { host, remote, alice, bob, code } = room(t);
  const m = shown(reason(host.join(alice, 'invite --pipe')));
  const wrong = String((Number(m.pin) + 1) % 10_000).padStart(4, '0');
  stopDaemon(t, remote, code);
  await typeLine(remote, bob, code, m.line, 'bob');
  const first = remote.join(bob, `join ${wrong}`);
  assert.ok(hiddenBlock(first));
  assert.match(reason(first), /wrong PIN \(4 tries left\)\. Check the digits with the host, then type it again: \/sub-human join PIN/);
  assert.ok(!reason(first).includes(wrong));
  const lf = linkFile(remote, code);
  assert.equal('pin' in lf, false, 'a refused PIN is dropped from the link file');
  assert.deepEqual([lf.pin_wanted?.left, lf.pin_wanted?.why], [4, 'PIN_WRONG'], 'and the PIN is asked for again');
  const rejoin = remote.join(bob, `bob ${code}`);
  assert.match(reason(rejoin), /wrong PIN \(4 tries left\)/, 'a seat never re-sends a refused PIN');
  const fast = remote.join(bob, `join ${m.pin}`);
  const w = /too many PINs tried just now: wait (\d) s, then type the PIN again: \/sub-human join PIN/.exec(reason(fast));
  assert.ok(w, `too soon after a wrong one: ${must(fast.json).reason}`);
  assert.ok(Number(w[1]) > 2, 'the machine that typed it wrong waits longer than the invite (4 s, not 2)');
  await sleep(Number(w[1]) * 1000 + 200);
  const ok = remote.join(bob, `join ${m.pin}`);
  assert.match(reason(ok), new RegExp(`the host let you in to room ${code}`), 'the right PIN: linked, no card');
  const said = host.lib(() => store.open(code).readAll()).filter(e => e.from === 'room').map(e => e.text).join('\n');
  assert.match(said, /a wrong PIN for invite [0-9a-f]{12} \(4 tries left; it asked to join as bob\)/);
  assert.ok(!said.includes(` ${wrong}`) && !said.includes(` ${m.pin}`));
});

test('a knock, then a wrong PIN: the link keeps waiting for the card, and Let in links it and the module takes the seat with no PIN typed again', async t => {
  const { host, remote, alice, bob, code } = room(t);
  const m = shown(reason(host.join(alice, 'invite --pipe')));
  const wrong = String((Number(m.pin) + 1) % 10_000).padStart(4, '0');
  stopDaemon(t, remote, code);
  await typeLine(remote, bob, code, m.line, 'bob');
  const first = remote.join(bob, `join ${wrong}`);
  assert.match(reason(first), /wrong PIN \(4 tries left\)/);
  await sleep(600);
  const st = remote.lib(() => linkSocket.status(code));
  assert.equal(remote.lib(() => linkSocket.stopReason(st)), null, 'the link did not stop: the card can still let it in');
  const ref = must(host.lib(() => admission.pending(code))[0], 'the card still waits').ref;
  const yes = card(host, alice, ref, 'Let in');
  assert.match(ctx(yes.post), /alice let bob's machine into room/);
  await until(() => remote.lib(() => linkSocket.status(code)).state === 'online', 10000, 'the link online');
  const lf = linkFile(remote, code);
  assert.ok(lf.token && !('pin_wanted' in lf) && !('awaiting' in lf), JSON.stringify(Object.keys(lf)));
  const seated = remote.take(bob, code);
  assert.equal(subHuman(seated).joined, true, seated.stdout);
  assert.ok(remote.lib(() => identityLib.readMembers(code)).bob, 'bob is seated');
});

test('an invite: five wrong PINs burn it; the right one after that is asked for no more', async t => {
  // the waits short (the pipe's serve runs with the joiner's environment)
  const { host, remote, alice, code } = room(t, { ...LINK_ENV, SUB_HUMAN_PIN_BACKOFF_MS: '20' });
  const carol = remote.seat('carol');
  const m2 = shown(reason(host.join(alice, 'invite --pipe')));
  const bad = String((Number(m2.pin) + 7) % 10_000).padStart(4, '0');
  stopDaemon(t, remote, code);
  await typeLine(remote, carol, code, m2.line, 'carol');
  let last: MachineRun | undefined;
  for (let i = 0; i < 5; i++) {
    for (;;) { // past the wait: the invite's and this machine's (doubling)
      last = remote.join(carol, `join ${bad}`);
      if (!/too many PINs tried just now: wait (\d+) s/.test(reason(last))) break;
      await sleep(Number(must(/wait (\d+) s/.exec(reason(last)))[1]) * 1000 + 100);
    }
  }
  assert.match(reason(must(last)), /that was the last try: this invite no longer works\. Ask the host for a new one/);
  const after = remote.join(carol, `join ${m2.pin}`);
  assert.match(reason(after), /no invite here is waiting for a PIN/, 'a burnt invite takes no PIN; its line was scrubbed');
});

test('an invite: Refuse stops the join; a request nobody answers lapses; kick NAME withdraws a waiting one', async t => {
  const { host, remote, alice, bob, code } = room(t, { ...LINK_ENV, SUB_HUMAN_ADMIT_TTL_MS: '1500' });
  stopDaemon(t, remote, code);
  // a knock (the line with no PIN), the card's way in; it waits ADMIT_TTL_MS (the pipe's serve runs with the joiner's
  // environment)
  const both = async (seat: Seat, as: string) => {
    const m = shown(reason(host.join(alice, 'invite --pipe')));
    await typeLine(remote, seat, code, m.line, as);
  };
  // refuse
  await both(bob, 'bob');
  let ref = must(host.lib(() => admission.pending(code))[0]).ref;
  const no = card(host, alice, ref, 'Refuse');
  assert.match(ctx(no.post), /alice refused bob; nothing got in/);
  await until(() => remote.lib(() => linkSocket.status(code)).state === 'stopped', 8000, 'the joiner\'s link stopped');
  assert.match(must(remote.lib(() => linkSocket.status(code)).reason), /the host refused to let this machine in/);

  // lapse: the request waits ADMIT_TTL_MS, then the host's tail says so and the joiner stops
  const carol = remote.seat('carol');
  await both(carol, 'carol');
  ref = must(host.lib(() => admission.pending(code))[0]).ref;
  await sleep(1700);
  const ev = events(await host.tail(alice, 1.2));
  assert.ok(ev.some(e => e.type === 'health' && /nobody let them in/.test(e.text)), JSON.stringify(ev));
  const late = host.hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `admit ${ref}`, options: [] }] } }, alice);
  assert.equal(late.json, null, 'a lapsed request opens no card');
  const q = `Let carol (check 0000-0000) on x join room ${code}? (admit ${ref})`;
  const forged = host.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: q }] }, tool_response: { questions: [{ question: q, options: [] }], answers: { [q]: 'Let in' } } }, alice);
  assert.match(ctx(forged), /Nothing was decided/, 'an answer on a card the hooks did not build records nothing');
  assert.equal(must(host.lib(() => admission.find(code, ref))).admit, 'lapsed');
  await until(() => remote.lib(() => linkSocket.status(code)).state === 'stopped', 8000, 'the lapsed join stopped');

  // kick NAME while it waits
  const dave = remote.seat('dave');
  await both(dave, 'dave');
  const r = host.join(alice, 'kick dave');
  assert.match(reason(r), /ended a connection to room \S+: it no longer reaches the room/);
  assert.equal(host.lib(() => admission.pending(code)).length, 0);
});

test('invite --cancel: an unknown ref is refused; an open invite is cancelled; cancelling it again changes nothing', t => {
  const { host, code } = room(t);
  assert.throws(() => host.lib(() => hosting.cancelInvite(code, '0123456789ab')), /has no open invite 0123456789ab/);
  const inv = host.lib(() => hosting.hostInvite(code, { pipe: true }));
  const r = host.lib(() => hosting.cancelInvite(code, inv.ref));
  assert.match(r.text, /^cancelled the invite to room .* it lets no one in/);
  assert.ok(must(host.lib(() => invites.findInvite(store.open(code), inv.ref))).invite.burnt_at);
  assert.match(host.lib(() => hosting.cancelInvite(code, inv.ref)).text, /no longer worked already/);
  assert.match(host.lib(() => hosting.cancelInvite(code)).text, /has no open invite; nothing to cancel/);
});

test('an invite: the host CLI masks the SECRET and the PIN inside Claude Code, `sub-human admit` lists and lets in from a shell', async t => {
  const { host, remote, bob, code } = room(t);
  stopDaemon(t, remote, code);
  const masked = spawnSync(process.execPath, [h.BIN, 'invite', '--pipe'], { env: { ...host.env(null), CLAUDECODE: '1' }, encoding: 'utf8' });
  assert.equal(masked.status, 0, masked.stderr);
  assert.match(masked.stdout, /\/sub-human join \S+ \S+ ####\n/);
  assert.match(masked.stdout, /another way\): ####\n/);
  assert.match(masked.stdout, /PIN and SECRET hidden/);
  const plain = spawnSync(process.execPath, [h.BIN, 'invite', '--pipe'], { env: host.env(null), encoding: 'utf8' });
  const m = shown(plain.stdout);
  await typeLine(remote, bob, code, m.line, 'bob');
  const list = spawnSync(process.execPath, [h.BIN, 'admit'], { env: host.env(null), encoding: 'utf8' });
  assert.match(list.stdout, /bob \(check [0-9a-f]{4}-[0-9a-f]{4}\) on \S+ wants to join room/);
  const ref = must(must(/admit ([0-9a-f]{12}) \[--refuse\]$/m.exec(list.stdout))[1]);
  assert.ok(!/(^|\s)sub-human admit/.test(list.stdout.replace(/\S*\/scripts\/sub-human admit/g, '')), 'the CLI by its path, never a bare sub-human');
  const noTty = spawnSync(process.execPath, [h.BIN, 'admit', ref], { env: host.env(null), encoding: 'utf8' });
  assert.equal(noTty.status, 1);
  assert.match(noTty.stderr, /add --yes/);
  const yes = spawnSync(process.execPath, [h.BIN, 'admit', ref, '--yes'], { env: host.env(null), encoding: 'utf8' });
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /let in: bob/);
  await until(() => remote.lib(() => linkSocket.status(code)).state === 'online', 10000, 'online');
  // the knock let in: the module takes the seat in a turn of its own (no bare /sub-human)
  const seated = remote.take(bob, code);
  assert.equal(subHuman(seated).joined, true, seated.stdout);
  assert.ok(remote.lib(() => identityLib.readMembers(code)).bob, 'bob is seated');
});

test('kick over pipe: the joiner\'s daemon stops LINK_REVOKED with the host\'s reason and drops its token; a new invite line replaces the link; --forget needs no --force', async t => {
  const { host, remote, alice, bob, code } = room(t);
  stopDaemon(t, remote, code);
  await remote.joinVia(host, alice, bob);
  await until(() => remote.lib(() => linkSocket.status(code)).state === 'online', 10000, 'online');
  const kicked = host.join(alice, 'kick bob');
  assert.match(must(kicked.json).reason || kicked.stdout, /bob is out of room/);
  const why = await until(() => remote.lib(() => linkSocket.stopReason(linkSocket.status(code))), 10000, 'the daemon stopping');
  if (!why) throw new Error("no reason");
  assert.equal(why.why, 'LINK_REVOKED', JSON.stringify(why));
  assert.match(why.reason, /removed this machine from room/);
  const lf = must(remote.lib(() => links.get(code)));
  assert.equal(lf.token, undefined, 'the spent token is dropped');
  assert.equal(lf.refused?.why, 'LINK_REVOKED');
  // no seat over it: the bare /sub-human says why, it takes nothing
  const bare = remote.join(bob, `bob ${code}`);
  assert.match(must(bare.json).reason || '', /removed this machine/, bare.stdout);
  assert.equal(must(host.lib(() => identityLib.readMembers(code)).bob).left_at !== undefined, true, 'no ghost seat on the host');
  // a new invite line for the same room replaces the dead link (no "this machine is in room X already")
  const inv = host.join(alice, 'invite --pipe');
  const m = shown(reason(inv));
  const typed = await typeLine(remote, bob, code, m.line, 'bob');
  assert.doesNotMatch(reason(typed), /in room \S+ already/);
  // forget: a spent link needs no --force
  const daemon = remote.lib(() => linkSocket.status(code));
  if (daemon.pid) { kill(childOf(daemon.pid)); kill(daemon.pid); }
  await until(() => !remote.lib(() => linkSocket.status(code)).running, 5000, 'the daemon gone');
  remote.lib(() => { const { token: _t, invite: _i, ...rest } = must(links.get(code)); links.set(code, { ...rest, refused: { at: new Date().toISOString(), reason: 'kicked', why: 'LINK_REVOKED' } }); });
  fs.writeFileSync(path.join(remote.home, 'links', `${code}.state.json`), JSON.stringify({ state: 'stopped', lastReason: 'LINK_REVOKED', lastError: 'the host removed this machine' }));
  const f = spawnSync(process.execPath, [h.BIN, 'link', code, '--forget'], { env: remote.env(null), encoding: 'utf8' });
  assert.equal(f.status, 0, f.stderr);
  assert.match(f.stdout, /forgotten/);
});

test('verify12 remote/05b: link CODE --forget on a live link tells the host this machine\'s seats left before it stops (not "connection lost" minutes later); the link\'s log and state go with the copy', async t => {
  const { host, remote, alice, bob, code } = room(t);
  stopDaemon(t, remote, code);
  await remote.joinVia(host, alice, bob);
  await until(() => remote.lib(() => linkSocket.status(code)).state === 'online', 10000, 'online');
  assert.ok(fs.existsSync(path.join(remote.home, 'links', `${code}.log`)) && fs.existsSync(path.join(remote.home, 'links', `${code}.state.json`)));
  const t0 = Date.now();
  const f = spawnSync(process.execPath, [h.BIN, 'link', code, '--forget'], { env: remote.env(null), encoding: 'utf8' });
  assert.equal(f.status, 0, f.stderr);
  assert.ok(Date.now() - t0 < 8000, 'bounded');
  assert.match(f.stdout, /stopped, and forgotten; this machine's copy is kept at (\S+); the host was told bob left$/m);
  const archive = must(must(/kept at (\S+);/.exec(f.stdout))[1]);
  const hostMembers = host.lib(() => identityLib.readMembers(code));
  assert.ok(hostMembers.bob?.left_at, 'the host has bob\'s leave at once');
  assert.match(host.log(code), /"text":"bob left"/);
  assert.doesNotMatch(host.log(code), /bob left \(connection lost\)/);
  assert.deepEqual(fs.readdirSync(path.join(remote.home, 'links')).filter(n => n.startsWith(code)), [], 'nothing of the link stays in links/');
  assert.ok(fs.existsSync(path.join(archive, 'link.log')) && fs.existsSync(path.join(archive, 'link.state.json')));
});

test('a re-invite after a kick (stage 8f item 2): the session that typed the new line and PIN is told once that it is in, and never that the old link\'s kick refused its join', async t => {
  const { host, remote, alice, bob, code } = room(t);
  stopDaemon(t, remote, code);
  await remote.joinVia(host, alice, bob);
  await until(() => remote.lib(() => linkSocket.status(code)).state === 'online', 10000, 'online');
  // bob's tail runs all along, as the hooks module's child does (live: it said "down … waiting for the host" and then nothing)
  const tailing = remote.tail(bob, 25);
  await sleep(1500);
  assert.match(must(host.join(alice, 'kick bob').json).reason || '', /bob is out of room/);
  await until(() => remote.lib(() => linkSocket.stopReason(linkSocket.status(code))), 10000, 'the daemon stopping');
  const m = shown(reason(host.join(alice, 'invite --pipe')));
  await typeLine(remote, bob, code, m.line, 'bob');
  // the right PIN lets it in with no card: the command's answer or, if the link came up after it, the tail says so, once
  const gave = remote.join(bob, `join ${m.pin}`);
  await until(() => remote.lib(() => linkSocket.status(code)).state === 'online', 10000, 'the link online again');
  const told = events(await tailing);
  const chat = told.flatMap(e => e.type === 'chat' ? e.lines : []);
  const said = [reason(gave), ...chat].filter(l => l.includes(`the host let you in to room ${code}`));
  assert.equal(said.length, 1, `${reason(gave)} ${JSON.stringify(told)}`);
  // once the kicked copy's seat is gone here, the tail asks the module to take the new one: at most once
  assert.ok(told.filter(e => e.type === 'take').length <= 1, JSON.stringify(told));
  // the kick's stop is no answer to the new line: its join is never said to be refused (live, verify11)
  assert.equal(chat.filter(l => l.startsWith('✗ could not join')).length, 0, JSON.stringify(told));
});
