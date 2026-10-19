// Two machines on one: two SUB_HUMAN_HOMEs, the host's (alice, carol) and a remote
// member's (bob). The real hooks run as child processes on both sides; bob joins with the line /sub-human invite
// gave (the host's admit lets him in, a bare /sub-human seats him), and his link daemon (scripts/sub-human link, started by the join hook) spawns the host's server
// (scripts/sub-human serve --stdio) through the pipe transport. Checked: the mirror's log is byte-identical to the
// host's and both chain; bob's @room verifies on the host; his signoff leads to the host's decision (the plan was
// prefetched for his card); a post addressed to bob reaches his tail and not carol's; his presence shows in the
// host's rows; nothing session-local of his reaches the host; with the host's server killed his @room posts are
// queued (nothing written anywhere yet), his card answer is not recorded and he is told, and his tail says so once;
// the link resumes with no gap and sends the queued posts in order; after his session ends the daemon exits on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as identity from '../lib/identity.ts';
import * as proposal from '../lib/proposal.ts';
import { propose } from './support/plan.ts';
import * as rows from '../lib/rows.ts';
import * as linkSocket from '../lib/remote/link-socket.ts';
import { isAlive } from '../lib/io.ts';
import { Machine, childOf, kill, stopDaemon } from './support/two-homes.ts';
import * as taskPlugin from '../mcp/task.ts';
import * as plans from '../lib/plans.ts';

import type { Proposal } from '../lib/types-app.ts';
import type { Link, LinkState } from '../lib/room/types.ts';
import { sn } from './support/brands.ts';
import { must } from './support/must.ts';

/** propose's seat (a Pick of Identity, not exported). */
type ProposalMe = Parameters<typeof propose>[0];
/** A tail's NDJSON event, the fields read here (lib/tail.ts). */
interface TailEvent { type: string; text?: string; lines?: string[] }

const RETRY_MS = 4000; // the daemon's first retry after the server is killed: the window the OFFLINE checks run in
const LINK_ENV = { SUB_HUMAN_LINK_RETRY_MS: String(RETRY_MS), SUB_HUMAN_LINK_RETRY_MAX_MS: String(RETRY_MS), SUB_HUMAN_LINK_IDLE_MS: '1500' };

const texts = (log: string): string[] => log.split('\n').filter(Boolean).map(l => (JSON.parse(l) as { text: string }).text);
/** The text of a tail's NDJSON events of these types (lib/tail.ts). */
const events = (out: string, types: string[]) => out.split('\n').filter(Boolean).map(l => JSON.parse(l) as TailEvent)
  .filter(ev => types.includes(ev.type)).map(ev => ev.text || (ev.lines || []).join('\n')).join('\n');

test('remote e2e: host, join by invite over pipe, @room, signoff → decision, addressed post, presence, OFFLINE, resume, leave', async t => {
  const host = new Machine(t, 'host'), remote = new Machine(t, 'remote', LINK_ENV);
  const alice = host.seat('alice'), carol = host.seat('carol'), bob = remote.seat('bob');

  // the host's room, and an invite to it
  assert.equal(must(host.join(alice, 'alice').json).decision, undefined);
  const code = must(host.lib(() => store.listRooms()[0]), 'the room');
  host.join(carol, `carol ${code}`);
  // bob links from the other home with the line (a hidden step: the join hook starts his link daemon, which checks
  // the host's key against the line and shows the host the SECRET: with no PIN it knocks), then the PIN while the
  // host's card waits (hidden too), which lets him in (no card), and a bare /sub-human takes his seat
  const via = await remote.joinVia(host, alice, bob);
  assert.equal(must(must(via.shown).json).decision, 'block', 'shown to the person, never to the model');
  assert.match(must(must(via.typed.json).reason), /Asked the host to let you in to room \S+ \(their card shows check [0-9a-f]{4}-[0-9a-f]{4}\)\. If they gave you a PIN: \/sub-human join PIN\./, via.typed.stderr);
  assert.match(must(must(via.gave.json).reason), new RegExp(`the host let you in to room ${code}: type /sub-human to join it as bob`), via.gave.stderr); // classic: no module takes it
  const joined = via.seated;
  assert.equal(must(joined.json).systemMessage, undefined, joined.stderr);
  assert.match(must(must(must(joined.json).hookSpecificOutput).additionalContext), /SUB-HUMAN: you are bob's Claude/);
  const daemon = remote.lib(() => linkSocket.status(code));
  t.after(() => { kill(childOf(daemon.pid)); kill(daemon.pid); fs.rmSync(path.dirname(linkSocket.socketPath(path.join(remote.home, 'rooms', code))), { recursive: true, force: true }); });
  assert.deepEqual([daemon.running, daemon.state], [true, 'online']);
  // a task request from bob's Claude goes over his link and is applied on the host at once (lib/tasks.ts apply)
  const taskTool = taskPlugin.create();
  const added = remote.lib(() => taskTool.call('task', { code, name: sn('bob'), role: 'member' }, { op: 'add', subject: 'parser tests' }));
  assert.match(must(added.content[0]).text, /^added #\d+ "parser tests"$/, JSON.stringify(added));
  assert.ok(host.lib(() => store.open(code).readAll()).some(e => e.kind === 'task' && e.from === 'room' && e.subject === 'parser tests'), 'on the host\'s log');
  const taken = remote.lib(() => taskTool.call('task', { code, name: sn('bob'), role: 'member' }, { op: 'done', id: '99', evidence: 'x' }));
  assert.deepEqual([taken.isError, must(taken.content[0]).text], [true, 'refused: no task #99 in this room']);
  // a plan edit from bob's machine is stored on the host (compare-and-swap there: lib/plans.ts put); its text reaches
  // the mirror's blob store with the line, and a stale base comes back as a conflict with the current text
  const v1 = remote.lib(() => plans.request(code, { plan: 'paging', base: 0, text: '# Paging\n\n1. cursor\n', summary: 'first draft' }, 'bob'));
  assert.ok(v1.ok, JSON.stringify(v1));
  await h.until(() => fs.existsSync(path.join(remote.home, 'rooms', code, 'plans', `${v1.version.hash}.md`)), 5000, 50);
  const stale = remote.lib(() => plans.request(code, { plan: 'paging', base: 0, text: '# Paging\n\n1. offset\n' }, 'bob'));
  assert.ok(!stale.ok && stale.conflict && stale.conflict.text === '# Paging\n\n1. cursor\n', JSON.stringify(stale));
  const linkFile = JSON.parse(fs.readFileSync(path.join(remote.home, 'links', `${code}.json`), 'utf8')) as Link;
  assert.deepEqual([typeof linkFile.token, linkFile.invite], ['string', undefined], 'the invite became the token');
  assert.equal(fs.statSync(path.join(remote.home, 'links', `${code}.json`)).mode & 0o777, 0o600);
  const hostJoin = must(host.lib(() => store.open(code).readAll()).find(e => e.kind === 'member_joined' && e.from === 'bob'));
  // the host derived bob's machine id from his home's machine key, and his home keeps it for this room
  assert.equal(hostJoin.machine, remote.lib(() => identity.machineIn(code)));
  assert.match(must(hostJoin.machine), /^k[0-9a-f]{15}$/);
  assert.notEqual(hostJoin.machine, remote.lib(() => identity.machineId()), 'not the id bob\'s home reported');

  // bob's @room: placed on the host, verified there, back in his mirror byte for byte
  assert.equal(must(remote.say(bob, 'hello from afar').json).continue, false);
  const said = must(host.lib(() => store.open(code).readAll()).at(-1));
  assert.deepEqual([said.from, said.text, host.lib(() => store.open(code).trust(said))], ['bob', 'hello from afar', 'verified']);
  assert.equal(remote.log(code), host.log(code), 'read-your-writes: the mirror held it when the hook returned');

  // a prompt that only reads starts no worker (no op crosses the link); a post starts one
  assert.equal(remote.workers('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'what changed?', sub_human_origin: 'composer', sub_human_nonce: bob.nonce }, bob), 0);
  assert.equal(remote.workers('prompt', { hook_event_name: 'UserPromptSubmit', prompt: '@room one more', sub_human_origin: 'composer', sub_human_nonce: bob.nonce }, bob), 1);

  // a proposal naming bob: its plan is prefetched, his card answer is signed there and decided here
  const aliceMe: ProposalMe = { code, name: sn('alice') };
  const p = host.lib(() => propose(aliceMe, { text: '# Ship the parser\n\n1. merge\n', approvers: ['bob'] }));
  await h.until(() => fs.existsSync(path.join(remote.home, 'rooms', code, 'plans', `${p.hash}.md`)), 5000, 50);
  const card = remote.lib(() => proposal.card({ hash: p.hash, approvers: ['bob'] } as Proposal, code));
  assert.match(JSON.stringify(card), /Ship the parser/, 'the card shows the prefetched plan');
  const q = `Agree to proposal ${p.hash}?`;
  remote.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: {}, tool_response: { ...card, answers: { [q]: 'Agree' } } }, bob);
  const decision = must(host.lib(() => store.open(code).readAll()).find(e => e.kind === 'decision'));
  assert.equal(decision.text, `agreed: bob (proposal ${p.hash})`);
  assert.equal(host.lib(() => (s => s.trust(s.readAll().find(e => e.kind === 'signoff')))(store.open(code))), 'verified');

  // a post alice's Claude addresses to bob wakes his Claude (from the mirror), not carol's (addressed is not private:
  // hers reads it with her next turn); bob's own words reach her chat
  host.lib(() => store.open(code).append({ kind: 'say', text: 'for bob only', to: 'bob' }, { via: 'agent', from: 'alice' }));
  const [bobSees, carolSees] = await Promise.all([remote.tail(bob, 2), host.tail(carol, 2)]);
  assert.match(events(bobSees, ['wake']), /for bob only/);
  assert.doesNotMatch(events(carolSees, ['wake', 'chat']), /for bob only/);
  assert.match(events(carolSees, ['chat']), /bob: hello from afar/);

  // bob's presence rides on beat: the host's rows show it
  remote.hook('presence', { hook_event_name: 'Notification', notification_type: 'idle_prompt' }, bob);
  assert.equal(must(host.lib(() => store.open(code).kv.get<{ state: string }>('presence/bob'))).state, 'idle');
  assert.match(host.lib(() => rows.rowText(code, { member: sn('bob'), viewer: 'alice' })), /idle/);

  // a second proposal for bob, prefetched before the link goes down
  const p2 = host.lib(() => propose(aliceMe, { text: '# Ship the lexer\n', approvers: ['bob'] }));
  await h.until(() => fs.existsSync(path.join(remote.home, 'rooms', code, 'plans', `${p2.hash}.md`)), 5000, 50);

  // the host's server dies: bob's @room posts are queued, nothing written anywhere yet; his tail says so once
  // bob's tail, from before the outage to back online: started first, so a slow runner (a node process per hook
  // below) cannot let the link come back before the tail has seen it down
  const across = remote.tail(bob, RETRY_MS / 1000 + 10);
  const server = childOf(daemon.pid);
  kill(server);
  await h.until(() => remote.lib(() => linkSocket.status(code)).state === 'offline', 5000, 20);
  const before = { host: host.log(code), mirror: remote.log(code) };
  assert.equal(must(host.say(alice, 'while you were away').json).continue, false);
  for (const [i, text] of ['is anyone there', 'second', 'third'].entries()) {
    const queued = remote.say(bob, text);
    assert.equal(must(queued.json).continue, false, queued.stderr);
    assert.equal(must(queued.json).stopReason, `⧗ queued: room ${code} is offline; this post goes out when the connection is back (${i + 1} waiting)`);
  }
  assert.equal((JSON.parse(fs.readFileSync(path.join(remote.home, 'links', `${code}.state.json`), 'utf8')) as LinkState).queued, 3);
  assert.equal(fs.statSync(path.join(remote.home, 'rooms', code, 'outbox.json')).mode & 0o777, 0o600);
  // his card answer cannot reach the host either: he is told (systemMessage), the model hears nothing was recorded
  const q2 = `Agree to proposal ${p2.hash}?`;
  const card2 = remote.lib(() => proposal.card({ hash: p2.hash, approvers: ['bob'] } as Proposal, code));
  const unsent = remote.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: {}, tool_response: { ...card2, answers: { [q2]: 'Agree' } } }, bob);
  assert.match(must(must(unsent.json).systemMessage), new RegExp(`✗ your agreement to proposal ${p2.hash} was not recorded: .*offline`), unsent.stderr);
  assert.match(must(must(must(unsent.json).hookSpecificOutput).additionalContext), new RegExp(`proposal ${p2.hash}: NOT recorded`));
  assert.doesNotMatch(must(must(must(unsent.json).hookSpecificOutput).additionalContext), /Recorded\./);
  assert.equal(remote.log(code), before.mirror);
  assert.doesNotMatch(host.log(code), /is anyone there/);

  // the daemon reconnects with {after, hash}: no gap, no duplicate, the queued posts in order, and bob posts again
  await h.until(() => remote.lib(() => linkSocket.status(code)).state === 'online', RETRY_MS + 5000, 50);
  await h.until(() => remote.log(code) === host.log(code), 3000, 20);
  assert.deepEqual(texts(host.log(code)).slice(-4), ['while you were away', 'is anyone there', 'second', 'third']);
  assert.deepEqual(host.lib(() => (s => s.readAll().slice(-3).map(e => s.trust(e)))(store.open(code))), ['verified', 'verified', 'verified']);
  assert.equal(fs.existsSync(path.join(remote.home, 'rooms', code, 'outbox.json')), false, 'the outbox is empty');
  const notice = events(await across, ['health']);
  assert.equal(must(notice.match(/is down \(/g)).length, 1, notice);
  assert.match(notice, /the connection to room \S+ is down \(.*\); @room posts wait and go out when it's back/);
  assert.equal(must(notice.match(/connection to the room is back/g)).length, 1, notice);
  assert.match(notice, /the connection to the room is back; @room posts go through again; 3 waiting @room post\(s\) sent/, 'one quiet line');
  assert.doesNotMatch(texts(host.log(code)).join('\n'), /bob (left|rejoined)/, 'no left/joined noise');
  assert.equal(must(remote.say(bob, 'back again').json).continue, false);
  assert.equal(remote.log(code), host.log(code));
  for (const m of [host, remote]) assert.equal(m.lib(() => store.open(code).verifyChain()).ok, true);

  // nothing session-local of bob's is on the host
  const hostFiles = fs.readdirSync(path.join(host.home, 'rooms', code), { recursive: true, encoding: 'utf8' });
  assert.deepEqual(hostFiles.filter(f => /bob/.test(f) && !/^presence/.test(f)), []);
  assert.ok((fs.readdirSync(path.join(remote.home, 'rooms', code), { recursive: true, encoding: 'utf8' })).some(f => /^members[/\\]bob[/\\]session\.json$/.test(f)), 'his session document (his delivery cursor) is on his machine');

  // bob's session ends: the host logs it; his daemon (and the server it spawned) exit on their own
  remote.hook('session-end', { hook_event_name: 'SessionEnd', reason: 'logout' }, bob);
  assert.equal(texts(host.log(code)).at(-1), 'bob left (session ended)', 'Claude Code\'s token, in words');
  assert.equal(host.lib(() => store.open(code).kv.get('presence/bob', null)), null, 'his presence is gone with him');
  assert.doesNotMatch(host.lib(() => rows.rowText(code, { member: sn('bob'), viewer: 'alice' })), /idle|prompt|working/);
  const current = childOf(daemon.pid);
  await h.until(() => !isAlive(daemon.pid), 8000, 50);
  assert.equal(isAlive(daemon.pid), false, 'the daemon exits once no seat of its machine is left');
  await h.until(() => !current || !isAlive(current), 3000, 50);
  assert.ok(!current || !isAlive(current), 'its server exits with it');
});

test('remote e2e: an invite used already is refused at join with that reason, not "offline"', async t => {
  const host = new Machine(t, 'host'), first = new Machine(t, 'first', LINK_ENV), third = new Machine(t, 'third', LINK_ENV);
  const alice = host.seat('alice'), bob = first.seat('bob'), carol = third.seat('carol');
  host.join(alice, 'alice');
  const code = must(host.lib(() => store.listRooms()[0]), 'the room');
  const cleanup = (m: Machine) => () => {
    const st = m.lib(() => linkSocket.status(code));
    if (st.pid) { kill(childOf(st.pid)); kill(st.pid); }
    fs.rmSync(path.dirname(linkSocket.socketPath(path.join(m.home, 'rooms', code))), { recursive: true, force: true });
  };
  t.after(cleanup(first));
  t.after(cleanup(third));
  const via = await first.joinVia(host, alice, bob);
  assert.equal(must(via.seated.json).decision, undefined, 'the first machine uses it');

  const refused = third.join(carol, `${via.line} --as carol`);
  assert.equal(must(refused.json).decision, 'block', refused.stderr);
  assert.match(must(must(refused.json).reason), /this invite was used already \(each invite works once\)/);
  assert.doesNotMatch(must(must(refused.json).reason), /offline|hung up/);
  assert.equal(must(must(refused.json).hookSpecificOutput).suppressOriginalPrompt, true, 'the SECRET stays out of the conversation');
  assert.doesNotMatch(host.log(code), /carol/);
});

test('remote e2e: a SendMessage round trip between Claudes on two machines, through the room (mod/send.ts)', async t => {
  const host = new Machine(t, 'host'), remote = new Machine(t, 'remote', LINK_ENV);
  const alice = host.seat('alice'), carol = host.seat('carol'), bob = remote.seat('bob');
  host.join(alice, 'alice');
  const code = must(host.lib(() => store.listRooms()[0]), 'the room');
  host.join(carol, `carol ${code}`);
  stopDaemon(t, remote, code);
  host.linkFor(code, remote);
  const seated = remote.join(bob, `bob ${code}`);
  assert.match(must(must(must(seated.json).hookSpecificOutput).additionalContext), /SUB-HUMAN: you are bob's Claude/, seated.stderr);
  await h.until(() => remote.lib(() => identity.readMembers(code)).bob, 5000, 50);

  // alice's Claude asks bob's: bob is on another machine, so the module posts it to the room addressed to him
  assert.equal(await host.send(carol, code, `alice.${code}`, 'native'), 'engine', 'a seat on this machine: the native send');
  assert.deepEqual(await host.send(alice, code, `bob.${code}`, 'what are you working on?'), { isDelivered: true });
  const asked = must(host.lib(() => store.open(code).readAll()).at(-1));
  assert.deepEqual([asked.kind, asked.via, asked.from, asked.to], ['say', 'agent', 'alice', 'bob']);
  // it wakes bob's Claude on his machine, with the address to answer at
  const bobSees = events(await remote.tail(bob, 2), ['wake']);
  assert.match(bobSees, /alice's Claude \(to you\): what are you working on\?/);
  assert.match(bobSees, new RegExp(`\\(for Claude\\) to answer alice's Claude: SendMessage alice\\.${code}`));

  // bob's Claude answers at that address: from his machine it goes through the room the same way, back to alice's
  assert.deepEqual(await remote.send(bob, code, `alice.${code}`, 'the parser tests'), { isDelivered: true });
  await h.until(() => host.lib(() => store.open(code).readAll()).some(e => e.from === 'bob' && e.to === 'alice'), 5000, 50);
  const [aliceSees, carolSees] = await Promise.all([host.tail(alice, 2), host.tail(carol, 2)]);
  assert.match(events(aliceSees, ['wake']), /bob's Claude \(to you\): the parser tests/);
  assert.match(events(aliceSees, ['wake']), new RegExp(`\\(for Claude\\) to answer bob's Claude: SendMessage bob\\.${code}`));
  assert.doesNotMatch(events(carolSees, ['wake']), /the parser tests/, 'addressed: no wake for anyone else');
  assert.equal(remote.log(code), host.log(code), 'the mirror holds both');

  // live 2026-10-17: bob's room server was held back (a failed start, cached 15 minutes) and his reply fell through to
  // the engine's "not reachable". Without the server the module relays through node (hooks/handlers/send.ts): the same post
  assert.deepEqual(await remote.send(bob, code, `alice.${code}`, 'sent without the room server', { server: false }), { isDelivered: true });
  await h.until(() => host.lib(() => store.open(code).readAll()).some(e => e.text === 'sent without the room server'), 5000, 50);
  const relayed = must(host.lib(() => store.open(code).readAll()).find(e => e.text === 'sent without the room server'));
  assert.deepEqual([relayed.kind, relayed.via, relayed.from, relayed.to], ['say', 'agent', 'bob', 'alice']);
  assert.match(events(await host.tail(alice, 2), ['wake']), /bob's Claude \(to you\): sent without the room server/);
  // and its refusals are the post tool's, said as the reason, never passed on to the engine
  const refused = await remote.send(bob, code, `alice.${code}`, '', { server: false });
  if (refused === 'engine' || refused.isDelivered) return assert.fail(JSON.stringify(refused));
  assert.match(refused.reason, /^Not sent to alice \(on another machine, reached through the room\): refused: /);
});
