'use strict';
// Two machines on one: two SUB_HUMAN_HOMEs, the host's (alice, carol) and a remote
// member's (bob). The real hooks run as child processes on both sides; bob joins with the invite /sub-human host
// gave, and his link daemon (scripts/sub-human link, started by the join hook) spawns the host's server
// (scripts/sub-human serve --stdio) through the pipe transport. Checked: the mirror's log is byte-identical to the
// host's and both chain; bob's @room verifies on the host; his signoff leads to the host's decision (the plan was
// prefetched for his card); a post addressed to bob reaches his tail and not carol's; his presence shows in the
// host's rows; nothing session-local of his reaches the host; with the host's server killed his @room posts are
// queued (nothing written anywhere yet), his card answer is not recorded and he is told, and his tail says so once;
// the link resumes with no gap and sends the queued posts in order; after his session ends the daemon exits on its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.js'));
const identity = require(path.join(h.LIB, 'identity.js'));
const proposal = require(path.join(h.LIB, 'proposal.js'));
const rows = require(path.join(h.LIB, 'rows.js'));
const link = require(path.join(h.LIB, 'remote', 'link.js'));
const { isAlive } = require(path.join(h.LIB, 'io.js'));
const { Machine } = require('./support/two-homes.js');

const RETRY_MS = 4000; // the daemon's first retry after the server is killed: the window the OFFLINE checks run in
const LINK_ENV = { SUB_HUMAN_LINK_RETRY_MS: String(RETRY_MS), SUB_HUMAN_LINK_RETRY_MAX_MS: String(RETRY_MS), SUB_HUMAN_LINK_IDLE_MS: '1500' };

const childOf = pid => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = pid => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
const texts = log => log.split('\n').filter(Boolean).map(l => JSON.parse(l).text);
/** The text of a tail's NDJSON events of these types (lib/tail.js). */
const events = (out, types) => out.split('\n').filter(Boolean).map(l => JSON.parse(l))
  .filter(ev => types.includes(ev.type)).map(ev => ev.text || (ev.lines || []).join('\n')).join('\n');

test('remote e2e: host, join by invite over pipe, @room, signoff → decision, addressed post, presence, OFFLINE, resume, leave', async t => {
  const host = new Machine(t, 'host'), remote = new Machine(t, 'remote', LINK_ENV);
  const alice = host.seat('alice'), carol = host.seat('carol'), bob = remote.seat('bob');

  // the host's room, and an invite to it
  assert.equal(host.join(alice, 'alice').json.decision, undefined);
  const code = host.lib(() => store.listRooms()[0]);
  host.join(carol, `carol ${code}`);
  const shown = host.join(alice, 'host').json;
  assert.equal(shown.decision, 'block', 'shown to the person, never to the model');
  const invite = /sh1\.\S+/.exec(shown.reason)[0];

  // bob joins from the other home: the join hook starts his link daemon, which redeems the invite
  const joined = remote.join(bob, `join bob ${invite}`);
  assert.equal(joined.json.systemMessage, undefined, joined.stderr);
  assert.match(joined.json.hookSpecificOutput.additionalContext, /SUB-HUMAN: you are bob's Claude/);
  const daemon = remote.lib(() => link.status(code));
  t.after(() => { kill(childOf(daemon.pid)); kill(daemon.pid); fs.rmSync(path.dirname(link.socketPath(path.join(remote.home, 'rooms', code))), { recursive: true, force: true }); });
  assert.deepEqual([daemon.running, daemon.state], [true, 'online']);
  const linkFile = JSON.parse(fs.readFileSync(path.join(remote.home, 'links', `${code}.json`), 'utf8'));
  assert.deepEqual([typeof linkFile.token, linkFile.invite], ['string', undefined], 'the invite became the token');
  assert.equal(fs.statSync(path.join(remote.home, 'links', `${code}.json`)).mode & 0o777, 0o600);
  const hostJoin = host.lib(() => store.open(code).readAll()).find(e => e.kind === 'member_joined' && e.from === 'bob');
  assert.equal(hostJoin.machine, remote.lib(() => identity.machineId()));

  // bob's @room: placed on the host, verified there, back in his mirror byte for byte
  assert.equal(remote.say(bob, 'hello from afar').json.continue, false);
  const said = host.lib(() => store.open(code).readAll()).at(-1);
  assert.deepEqual([said.from, said.text, host.lib(() => store.humanTrust(said))], ['bob', 'hello from afar', 'verified']);
  assert.equal(remote.log(code), host.log(code), 'read-your-writes: the mirror held it when the hook returned');

  // a prompt that only reads starts no worker (no op crosses the link); a post starts one
  assert.equal(remote.workers('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'what changed?', sub_human_origin: 'composer', sub_human_nonce: bob.nonce }, bob), 0);
  assert.equal(remote.workers('prompt', { hook_event_name: 'UserPromptSubmit', prompt: '@room one more', sub_human_origin: 'composer', sub_human_nonce: bob.nonce }, bob), 1);

  // a proposal naming bob: its plan is prefetched, his card answer is signed there and decided here
  const p = host.lib(() => proposal.create({ code, name: 'alice', role: 'member' }, { text: '# Ship the parser\n\n1. merge\n', approvers: ['bob'] }));
  await h.until(() => fs.existsSync(path.join(remote.home, 'rooms', code, 'plans', `${p.hash}.md`)), 5000, 50);
  const card = remote.lib(() => proposal.card({ hash: p.hash, approvers: ['bob'] }, code));
  assert.match(JSON.stringify(card), /Ship the parser/, 'the card shows the prefetched plan');
  const q = `Agree to proposal ${p.hash}?`;
  remote.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: {}, tool_response: { ...card, answers: { [q]: 'Agree' } } }, bob);
  const decision = host.lib(() => store.open(code).readAll()).find(e => e.kind === 'decision');
  assert.equal(decision.text, `agreed: bob (proposal ${p.hash})`);
  assert.equal(host.lib(() => store.humanTrust(store.open(code).readAll().find(e => e.kind === 'signoff'))), 'verified');

  // a post alice's Claude addresses to bob wakes his Claude (from the mirror), not carol's (addressed is not private:
  // hers reads it with her next turn); bob's own words reach her chat
  host.lib(() => store.open(code).append({ kind: 'say', text: 'for bob only', to: 'bob' }, { via: 'agent', from: 'alice' }));
  const [bobSees, carolSees] = await Promise.all([remote.tail(bob, 2), host.tail(carol, 2)]);
  assert.match(events(bobSees, ['wake']), /for bob only/);
  assert.doesNotMatch(events(carolSees, ['wake', 'chat']), /for bob only/);
  assert.match(events(carolSees, ['chat']), /bob: hello from afar/);

  // bob's presence rides on beat: the host's rows show it
  remote.hook('presence', { hook_event_name: 'Notification', notification_type: 'idle_prompt' }, bob);
  assert.equal(host.lib(() => store.open(code).kv.get('presence/bob')).state, 'idle');
  assert.match(host.lib(() => rows.rowText(code, 'bob', 'alice')), /idle/);

  // a second proposal for bob, prefetched before the link goes down
  const p2 = host.lib(() => proposal.create({ code, name: 'alice', role: 'member' }, { text: '# Ship the lexer\n', approvers: ['bob'] }));
  await h.until(() => fs.existsSync(path.join(remote.home, 'rooms', code, 'plans', `${p2.hash}.md`)), 5000, 50);

  // the host's server dies: bob's @room posts are queued, nothing written anywhere yet; his tail says so once
  const server = childOf(daemon.pid);
  kill(server);
  await h.until(() => remote.lib(() => link.status(code)).state === 'offline', 5000, 20);
  const before = { host: host.log(code), mirror: remote.log(code) };
  assert.equal(host.say(alice, 'while you were away').json.continue, false);
  for (const [i, text] of ['is anyone there', 'second', 'third'].entries()) {
    const queued = remote.say(bob, text);
    assert.equal(queued.json.continue, false, queued.stderr);
    assert.equal(queued.json.stopReason, `⧗ queued: room ${code} is offline; this post is sent when the link is back (${i + 1} waiting)`);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(remote.home, 'links', `${code}.state.json`), 'utf8')).queued, 3);
  assert.equal(fs.statSync(path.join(remote.home, 'rooms', code, 'outbox.json')).mode & 0o777, 0o600);
  // his card answer cannot reach the host either: he is told (systemMessage), the model hears nothing was recorded
  const q2 = `Agree to proposal ${p2.hash}?`;
  const card2 = remote.lib(() => proposal.card({ hash: p2.hash, approvers: ['bob'] }, code));
  const unsent = remote.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: {}, tool_response: { ...card2, answers: { [q2]: 'Agree' } } }, bob);
  assert.match(unsent.json.systemMessage, new RegExp(`✗ your agreement to proposal ${p2.hash} was not recorded: .*offline`), unsent.stderr);
  assert.match(unsent.json.hookSpecificOutput.additionalContext, new RegExp(`proposal ${p2.hash}: NOT recorded`));
  assert.doesNotMatch(unsent.json.hookSpecificOutput.additionalContext, /Recorded\./);
  assert.equal(remote.log(code), before.mirror);
  assert.doesNotMatch(host.log(code), /is anyone there/);
  const across = remote.tail(bob, RETRY_MS / 1000 + 3); // bob's tail, from offline to back online

  // the daemon reconnects with {after, hash}: no gap, no duplicate, the queued posts in order, and bob posts again
  await h.until(() => remote.lib(() => link.status(code)).state === 'online', RETRY_MS + 5000, 50);
  await h.until(() => remote.log(code) === host.log(code), 3000, 20);
  assert.deepEqual(texts(host.log(code)).slice(-4), ['while you were away', 'is anyone there', 'second', 'third']);
  assert.deepEqual(host.lib(() => store.open(code).readAll().slice(-3).map(e => store.humanTrust(e))), ['verified', 'verified', 'verified']);
  assert.equal(fs.existsSync(path.join(remote.home, 'rooms', code, 'outbox.json')), false, 'the outbox is empty');
  const notice = events(await across, ['health']);
  assert.equal(notice.match(/room link: OFFLINE/g).length, 1, notice);
  assert.match(notice, /room link: OFFLINE \(.*\); @room posts are queued and sent when it is back, answers are refused/);
  assert.equal(notice.match(/back online/g).length, 1, notice);
  assert.match(notice, /back online; @room posts go through again; 3 queued @room post\(s\) sent/, 'one quiet line');
  assert.doesNotMatch(texts(host.log(code)).join('\n'), /bob (left|rejoined)/, 'no left/joined noise');
  assert.equal(remote.say(bob, 'back again').json.continue, false);
  assert.equal(remote.log(code), host.log(code));
  for (const m of [host, remote]) assert.equal(m.lib(() => store.open(code).verifyChain()).ok, true);

  // nothing session-local of bob's is on the host
  const hostFiles = fs.readdirSync(path.join(host.home, 'rooms', code), { recursive: true });
  assert.deepEqual(hostFiles.filter(f => /bob/.test(f) && !/^presence/.test(f)), []);
  assert.ok(fs.readdirSync(path.join(remote.home, 'rooms', code)).some(f => /bob\.cursor$/.test(f)), 'his cursors are on his machine');

  // bob's session ends: the host logs it; his daemon (and the server it spawned) exit on their own
  remote.hook('session-end', { hook_event_name: 'SessionEnd', reason: 'logout' }, bob);
  assert.equal(texts(host.log(code)).at(-1), 'bob left (logout)');
  assert.equal(host.lib(() => store.open(code).kv.get('presence/bob', null)), null, 'his presence is gone with him');
  assert.doesNotMatch(host.lib(() => rows.rowText(code, 'bob', 'alice')), /idle|prompt|working/);
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
  const code = host.lib(() => store.listRooms()[0]);
  const invite = /sh1\.\S+/.exec(host.join(alice, 'host').json.reason)[0];
  const cleanup = m => () => {
    const st = m.lib(() => link.status(code));
    if (st.pid) { kill(childOf(st.pid)); kill(st.pid); }
    fs.rmSync(path.dirname(link.socketPath(path.join(m.home, 'rooms', code))), { recursive: true, force: true });
  };
  t.after(cleanup(first));
  t.after(cleanup(third));
  assert.equal(first.join(bob, `join bob ${invite}`).json.systemMessage, undefined, 'the first machine redeems it');

  const refused = third.join(carol, `join carol ${invite}`);
  assert.equal(refused.json.decision, 'block', refused.stderr);
  assert.match(refused.json.reason, /this invite is unknown or was used already/);
  assert.doesNotMatch(refused.json.reason, /offline|hung up/);
  assert.equal(refused.json.systemMessage, refused.json.reason, 'Remote Control shows the refusal too');
  assert.equal(third.lib(() => link.status(code)).code, 'AUTH');
  assert.doesNotMatch(host.log(code), /carol/);
});
