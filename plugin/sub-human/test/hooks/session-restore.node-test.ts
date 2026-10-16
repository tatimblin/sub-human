import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { World, fixture, identity, ctx, hso } from './helpers.ts';
import * as rowsLib from '../../lib/rows.ts';
import * as proposal from '../../lib/proposal.ts';

const NEW_SID = '8cea5671-97a8-49c2-bcdb-4a62d51b6a18';
const hasRows = () => typeof rowsLib.rowText === 'function';

test('session-restore: after /clear, rebinds the new session id by CLAUDE_PID and re-injects the mechanics block', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  w.append({ kind: 'say', text: 'hello room' }, { via: 'human', from: 'alice' });
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), session_id: NEW_SID }, { as: 'alice', session: false });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(hso(r).hookEventName, 'SessionStart');
  const c = ctx(r)!;
  assert.ok(c.startsWith(`SUB-HUMAN: you are alice's Claude in room ${w.code}`), c.slice(0, 100));
  assert.doesNotMatch(c, /\{(NAME|CODE|OTHERS|ADDR_EXAMPLE|PLUGIN)\}/);
  assert.match(c, /\(restored after clear\)$/);
  assert.ok(c.length <= 1200, `block ${c.length}`);
  assert.equal(hso(r).sessionTitle, `alice.${w.code}`, 'the native address');
  assert.equal(w.members().alice.session_id, NEW_SID);
  assert.deepEqual(w.lib(() => identity.resolveBySession(NEW_SID)), { code: w.code, name: 'alice', role: 'member', session_id: NEW_SID, pid: process.pid, address: `alice.${w.code}` });
  assert.equal(w.lib(() => identity.resolveBySession(w.sid.alice)), null, 'old session id dropped');
});

test('session-restore: ROWS asks to re-create rows only if missing after clear/compact; the room\'s Claude gets its block', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), session_id: NEW_SID }, { as: 'alice', session: false });
  const c = ctx(r)!;
  if (hasRows()) assert.match(c, /ROWS\n[^]*subagent_type: "sub-human:room"/, 'no live hold: the room row is listed');
  const r2 = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'compact' }, { as: 'alice' });
  assert.match(ctx(r2)!, /restored after compact/);
  const ro = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'compact' }, { as: 'claude' });
  assert.ok(ctx(ro)!.startsWith(`SUB-HUMAN: you are claude, the room's Claude of room ${w.code}`), ctx(ro)!.slice(0, 80));
  assert.equal(hso(ro).sessionTitle, `claude.${w.code}`);
});

test('session-restore: --resume after the session ended rejoins the seat with a new pid and asks to re-create rows', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep', bob: 'sleep' });
  const oldSid = w.sid.alice;
  // exit: session-end marks alice left
  w.hook('session-end', fixture('session-end'), { as: 'alice' });
  assert.ok(w.members().alice.left_at);
  // claude --resume: a new process (this test process), the old session id
  w.pid.alice = process.pid;
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'resume', session_id: oldSid }, { as: 'alice', session: false });
  assert.equal(r.code, 0, r.stderr);
  const c = ctx(r)!;
  assert.ok(c.startsWith(`SUB-HUMAN: you are alice's Claude in room ${w.code}`) && c.endsWith('(restored after resume)'), c.slice(0, 100));
  if (hasRows()) assert.match(c, /ROWS\n[^]*subagent_type: "sub-human:room"/);
  const m = w.members().alice;
  assert.equal(m.left_at, undefined);
  assert.equal(m.pid, process.pid);
  assert.equal(m.session_id, oldSid);
  const e = w.entries().at(-1)!;
  assert.deepEqual([e.kind, e.from, e.via, e.text], ['member_joined', 'alice', 'system', 'alice rejoined (resumed)']);
  assert.equal(w.lib(() => identity.resolveByPid(process.pid))!.name, 'alice');
});

test('session-restore: --resume rejoins when this machine\'s id cannot be read (member_joined carries no machine)', () => {
  const w = new World({});
  fs.writeFileSync(path.join(w.home, 'machine.json'), '{}\n'); // unreadable id: home.machineId() is null, from the start
  w.join('claude', 'sleep');
  w.join('alice', 'sleep');
  w.join('bob', 'sleep');
  const oldSid = w.sid.alice;
  w.hook('session-end', fixture('session-end'), { as: 'alice' });
  w.pid.alice = process.pid;
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'resume', session_id: oldSid }, { as: 'alice', session: false });
  assert.equal(r.code, 0, r.stderr);
  assert.match(ctx(r)!, /restored after resume/);
  const e = w.entries().at(-1)!;
  assert.deepEqual([e.kind, e.from, 'machine' in e], ['member_joined', 'alice', false]);
});

test('session-restore: --resume into a closing or closed room does nothing', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep' });
  const oldSid = w.sid.alice;
  w.hook('session-end', fixture('session-end'), { as: 'alice' }); // the last member: the reaper starts (grace 0 here)
  w.lib(() => identity.updateRoomClaude(w.code, () => ({ closing: new Date().toISOString() })));
  w.pid.alice = process.pid;
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'resume', session_id: oldSid }, { as: 'alice', session: false });
  assert.equal(r.stdout, '');
  assert.ok(w.members().alice.left_at);
});

test('session-restore: --resume after a crash (seat still registered, old pid dead) moves it to the new pid', async () => {
  const w = new World({ claude: 'sleep', alice: 'sleep' });
  process.kill(w.pid.alice, 'SIGKILL');
  for (let i = 0; i < 100 && identity.isAlive(w.pid.alice); i++) await new Promise(r => setTimeout(r, 20));
  w.pid.alice = process.pid; // new process, same session id; no session-end ran
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'resume', session_id: w.sid.alice }, { as: 'alice', session: false });
  assert.match(ctx(r)!, /restored after resume/);
  assert.equal(w.members().alice.pid, process.pid);
});

test('session-restore: not joined -> nothing', () => {
  const w = new World({ claude: 'sleep' });
  assert.equal(w.hook('session-restore', fixture('session-start-clear')).stdout, '');
});

test('session-restore: a review left open (plan file still the proposal) is restored and cleared after clear; a fresh one survives compact', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const text = '# Cursor paging\n\n1. after=\n';
  const bob = { code: w.code, name: 'bob', role: 'member' };
  const hash = w.lib(() => proposal.create(bob, { text, approvers: ['alice'] })).hash;
  const file = path.join(w.userHome, '.claude', 'plans', 'stuck.md');
  const alice = { code: w.code, name: 'alice', role: 'member' };
  const open = () => !!w.lib(() => proposal.readReview(alice)); // her session document's review
  const leave = (extra = {}) => {
    fs.writeFileSync(file, text);
    w.lib(() => proposal.writeReview(alice, { phase: 'shown', mode: 'default', at: Date.now(), hash, file, backup: 'alice\'s plan\n', restored: false, ...extra }));
  };
  leave();
  w.hook('session-restore', { ...fixture('session-start-clear'), source: 'compact' }, { as: 'alice' });
  assert.ok(open(), 'a fresh review survives compaction');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  leave({ at: Date.now() - 2 * 60 * 60 * 1000 });
  w.hook('session-restore', { ...fixture('session-start-clear'), source: 'compact' }, { as: 'alice' });
  assert.equal(open(), false, 'a stale one is cleared');
  assert.equal(fs.readFileSync(file, 'utf8'), 'alice\'s plan\n', 'and the person\'s plan is back');
  // After /clear: always; a plan file the person rewrote since is left alone.
  leave();
  fs.writeFileSync(file, 'alice wrote this since\n');
  w.hook('session-restore', { ...fixture('session-start-clear'), session_id: NEW_SID }, { as: 'alice', session: false });
  assert.equal(open(), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'alice wrote this since\n');
  // No backup (the file did not exist before): the proposal's copy is removed.
  leave({ backup: null });
  w.hook('session-restore', { ...fixture('session-start-clear'), source: 'compact', session_id: NEW_SID }, { as: 'alice', session: false });
  assert.ok(open(), 'compact, fresh: kept');
  w.hook('session-restore', { ...fixture('session-start-clear'), source: 'clear', session_id: NEW_SID }, { as: 'alice', session: false });
  assert.equal(fs.existsSync(file), false);
  assert.equal(open(), false);
});

// ← (the agent view) moves the conversation into a bg job: a new process, a new session id (source "fork"), and the
// old transcript, beside the new one, ends with {"type":"continued-in","continuedInSessionId":NEW}.
function forkTranscripts(w: World, oldSid: string, newSid: string, { record = true } = {}) {
  const dir = fs.mkdtempSync(path.join(w.home, '..', 'proj-'));
  const lines = [{ type: 'user', sessionId: oldSid, message: { content: 'hi' } }];
  if (record) lines.push({ type: 'continued-in', sessionId: oldSid, continuedInSessionId: newSid } as any);
  fs.writeFileSync(path.join(dir, `${oldSid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path.join(dir, `${newSid}.jsonl`);
}

test('session-restore: a fork (← the agent view) takes the seat its old session holds, with no leave and no log line, and lists every row', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep', bob: 'sleep' });
  const oldSid = w.sid.alice;
  const oldPid = w.pid.alice; // the old process stays up as the agent view: its pid is alive
  const before = w.entries().length;
  const transcript = forkTranscripts(w, oldSid, NEW_SID);
  w.pid.alice = process.pid; // the bg job
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'fork', session_id: NEW_SID, transcript_path: transcript }, { as: 'alice', session: false });
  assert.equal(r.code, 0, r.stderr);
  const c = ctx(r)!;
  assert.ok(c.startsWith(`SUB-HUMAN: you are alice's Claude in room ${w.code}`) && c.endsWith('(restored after the agent view)'), c.slice(-120));
  if (hasRows()) assert.match(c, /ROWS\n[^]*subagent_type: "sub-human:room"/, "every row listed, held or not");
  assert.equal(hso(r).sessionTitle, `alice.${w.code}`);
  const m = w.members().alice;
  assert.deepEqual([m.left_at, m.pid, m.session_id], [undefined, process.pid, NEW_SID]);
  assert.equal(w.entries().length, before, 'no leave, no rejoin line');
  assert.equal(w.lib(() => identity.resolveBySession(NEW_SID))!.name, 'alice');
  assert.equal(w.lib(() => identity.resolveBySession(oldSid)), null, 'the old session no longer holds it');
  assert.equal(w.lib(() => identity.resolveByPid(oldPid)), null, 'nor the agent view\'s process');
  assert.equal(w.lib(() => identity.lastSeat(oldSid)), null, 'a --resume of the old id later takes nothing');
});

test('session-restore: a fork with no continued-in record (claude --resume X --fork-session by hand) takes no seat', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep' });
  const transcript = forkTranscripts(w, w.sid.alice, NEW_SID, { record: false });
  w.pid.alice = process.pid;
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'fork', session_id: NEW_SID, transcript_path: transcript }, { as: 'alice', session: false, env: { SUB_HUMAN_FORK_WAIT_MS: '1' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(ctx(r), undefined);
  assert.equal(w.members().alice.session_id, w.sid.alice);
});

test('session-restore: a fork waits for the continued-in record Claude Code writes just after the job starts', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep' });
  const oldSid = w.sid.alice;
  const transcript = forkTranscripts(w, oldSid, NEW_SID, { record: false });
  w.pid.alice = process.pid;
  // written 0.4 s after the hook starts (the hook runs synchronously here, so another process writes it)
  const line = JSON.stringify({ type: 'continued-in', continuedInSessionId: NEW_SID });
  spawn('sh', ['-c', `sleep 0.4; printf '%s\\n' '${line}' >> '${path.join(path.dirname(transcript), `${oldSid}.jsonl`)}'`], { stdio: 'ignore' });
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'fork', session_id: NEW_SID, transcript_path: transcript }, { as: 'alice', session: false });
  assert.equal(r.code, 0, r.stderr);
  assert.match(ctx(r)!, /restored after the agent view/);
  assert.equal(w.members().alice.session_id, NEW_SID);
});

test('stage 8e E (live verify, locala/01a): a fork whose seat is in a sub-human folder this process does not have (SUB_HUMAN_HOME only in the shell): told why, recorded, and a bare /sub-human there opens no room', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep' });
  const oldSid = w.sid.alice;
  // the bg job's own folder: the default one, which has no record of alice's seat
  const fork = new World({}, { room: false });
  fork.pid.me = process.pid; fork.sid.me = NEW_SID;
  const dir = fs.mkdtempSync(path.join(fork.home, '..', 'proj-'));
  const lines = [{ type: 'user', sessionId: oldSid, message: { content: 'hi' } }, { type: 'custom-title', customTitle: `alice.${w.code}`, sessionId: oldSid },
    { type: 'continued-in', sessionId: oldSid, continuedInSessionId: NEW_SID }];
  fs.writeFileSync(path.join(dir, `${oldSid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const transcript = path.join(dir, `${NEW_SID}.jsonl`);
  const r = fork.hook('session-restore', { ...fixture('session-start-clear'), source: 'fork', session_id: NEW_SID, transcript_path: transcript }, { as: 'me', session: false, env: { SUB_HUMAN_FORK_WAIT_MS: '1' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(ctx(r), undefined, 'no seat taken');
  assert.match(r.json!.systemMessage!, new RegExp(`^sub-human: the agent view moved this conversation here from a session seated as alice\\.${w.code} in another sub-human folder, but this session's folder is ${fork.home}: .* claude stop ${NEW_SID.slice(0, 8)}, then SUB_HUMAN_HOME=<that folder> claude --resume ${NEW_SID}, .*Claude Code settings "env"`));
  assert.deepEqual(fork.lib(() => identity.forkedOf(NEW_SID)), { sid: oldSid, title: `alice.${w.code}` });
  // a bare /sub-human (and /sub-human NAME) there: refused, no room opened in this folder
  const expand = (args: string) => ({ ...fixture('user-prompt-expansion'), session_id: NEW_SID, command_args: args, prompt: `/sub-human:sub-human ${args}`.trim() });
  for (const args of ['', 'alice']) {
    const j = fork.hook('join', expand(args), { as: 'me' });
    assert.equal(j.json!.decision, 'block', `${args}: ${j.stdout}`);
    assert.match(j.json!.reason!, /from a session seated as alice\..* \/sub-human opens or joins no room here/);
  }
  assert.equal(fs.existsSync(path.join(fork.home, 'rooms')) ? fs.readdirSync(path.join(fork.home, 'rooms')).length : 0, 0, 'no second room');
  // a fork of a session that held no seat (its title no address) is no such fork
  const plain = new World({}, { room: false });
  const dir2 = fs.mkdtempSync(path.join(plain.home, '..', 'proj-'));
  fs.writeFileSync(path.join(dir2, `${oldSid}.jsonl`), [{ type: 'custom-title', customTitle: 'alice' }, { type: 'continued-in', continuedInSessionId: NEW_SID }].map(l => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(plain.lib(() => identity.forkedAway(NEW_SID, dir2)), null);
});

test('stage 8f item 1 (live verify, verify10/local/18-23): a fork after /sub-human leave (its title plain "bob") still knows its folder from the hidden home notice: told, and neither a bare /sub-human nor /sub-human NAME ROOM opens or joins a room in this folder', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep' });
  const oldSid = w.sid.alice;
  const fork = new World({}, { room: false });
  fork.pid.me = process.pid; fork.sid.me = NEW_SID;
  const dir = fs.mkdtempSync(path.join(fork.home, '..', 'proj-'));
  // the module's notice at the join (a system row at level info), then the leave's rename
  const notice = (home: string) => ({ type: 'system', subtype: 'informational', content: `sub-human: home ${home}`, isMeta: false, level: 'info', sessionId: oldSid });
  const lines = [notice(w.home), { type: 'custom-title', customTitle: `alice.${w.code}`, sessionId: oldSid }, { type: 'custom-title', customTitle: 'alice', sessionId: oldSid },
    { type: 'continued-in', sessionId: oldSid, continuedInSessionId: NEW_SID }];
  fs.writeFileSync(path.join(dir, `${oldSid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const transcript = path.join(dir, `${NEW_SID}.jsonl`);
  const r = fork.hook('session-restore', { ...fixture('session-start-clear'), source: 'fork', session_id: NEW_SID, transcript_path: transcript }, { as: 'me', session: false, env: { SUB_HUMAN_FORK_WAIT_MS: '1' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(ctx(r), undefined, 'no seat taken');
  const said = r.json!.systemMessage!;
  assert.ok(said.startsWith(`sub-human: the agent view moved this conversation here from a session in sub-human folder ${w.home}, but this session's folder is ${fork.home}`), said);
  assert.ok(said.includes(`claude stop ${NEW_SID.slice(0, 8)}, then SUB_HUMAN_HOME=${w.home} claude --resume ${NEW_SID}`), said);
  assert.deepEqual(fork.lib(() => identity.forkedOf(NEW_SID)), { sid: oldSid, title: 'alice', home: w.home });
  const expand = (args: string) => ({ ...fixture('user-prompt-expansion'), session_id: NEW_SID, command_args: args, prompt: `/sub-human:sub-human ${args}`.trim() });
  for (const args of ['', 'alice', `alice ${w.code}`]) {
    const j = fork.hook('join', expand(args), { as: 'me' });
    assert.equal(j.json!.decision, 'block', `${args}: ${j.stdout}`);
    assert.match(j.json!.reason!, /\/sub-human opens or joins no room here/, args);
    assert.doesNotMatch(j.json!.reason!, /open a new room/, args);
  }
  assert.equal(fs.existsSync(path.join(fork.home, 'rooms')) ? fs.readdirSync(path.join(fork.home, 'rooms')).length : 0, 0, 'no room in this folder');
  // the notice names this very folder: no such fork (the seat, if any, is found here)
  const same = new World({}, { room: false });
  const dir2 = fs.mkdtempSync(path.join(same.home, '..', 'proj-'));
  fs.writeFileSync(path.join(dir2, `${oldSid}.jsonl`), [notice(same.home), { type: 'custom-title', customTitle: `alice.${w.code}` }, { type: 'continued-in', continuedInSessionId: NEW_SID }].map(l => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(same.lib(() => identity.forkedAway(NEW_SID, dir2)), null);
  // the last notice wins: a session that sat elsewhere before and here after is no such fork either
  fs.writeFileSync(path.join(dir2, `${oldSid}.jsonl`), [notice(w.home), notice(same.home), { type: 'continued-in', continuedInSessionId: NEW_SID }].map(l => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(same.lib(() => identity.forkedAway(NEW_SID, dir2)), null);
});
