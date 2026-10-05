'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, fixture, identity, ctx, hso, roomPlan } = require('./helpers.js');

const NEW_SID = '8cea5671-97a8-49c2-bcdb-4a62d51b6a18';
const hasRows = () => { try { require('../../lib/rows.js'); return true; } catch { return false; } };

test('session-restore: after /clear, rebinds the new session id by CLAUDE_PID and re-injects role + digest', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  w.append({ kind: 'say', text: 'hello room' }, { via: 'human', from: 'alice' });
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), session_id: NEW_SID }, { as: 'alice', session: false });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(hso(r).hookEventName, 'SessionStart');
  const c = ctx(r);
  assert.ok(c.startsWith(`SUB-HUMAN role=member name=alice room=${w.code} (restored after clear)`), c.slice(0, 100));
  const memberMd = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'sub-human', 'member.md'), 'utf8').trim();
  assert.ok(c.includes(memberMd.slice(0, 200)));
  assert.match(c, /ROOM DIGEST/);
  assert.match(c, /hello room/);
  assert.ok(c.length <= 9500);
  assert.equal(w.members().alice.session_id, NEW_SID);
  assert.deepEqual(w.lib(() => identity.resolveBySession(NEW_SID)), { code: w.code, name: 'alice', role: 'member', session_id: NEW_SID, pid: process.pid });
  assert.equal(w.lib(() => identity.resolveBySession(w.sid.alice)), null, 'old session id dropped');
});

test('session-restore: the digest is capped; ROWS asks to re-create rows only if missing after clear/compact', () => {
  const w = new World({ orch: 'sleep', alice: 'act', bob: 'sleep' });
  for (let i = 0; i < 40; i++) w.append({ kind: 'say', text: 'y'.repeat(400) + i }, { via: 'human', from: 'alice' });
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), session_id: NEW_SID }, { as: 'alice', session: false });
  const c = ctx(r);
  assert.ok(c.length <= 9500);
  assert.match(c, /ROSTER\n/);
  if (hasRows()) assert.match(c, /ROWS\nYour rows are not running[^]*subagent_type: "sub-human:room"/, 'no live hold: the room row is listed');
  assert.equal(hso(r).sessionTitle, `⬡ ${w.code} · alice`);
  const r2 = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'compact' }, { as: 'alice' });
  assert.match(ctx(r2), /restored after compact/);
});

test('session-restore: --resume after the session ended rejoins the seat with a new pid and asks to re-create rows', () => {
  const w = new World({ orch: 'sleep', alice: 'sleep', bob: 'sleep' });
  const oldSid = w.sid.alice;
  // exit: session-end marks alice left
  w.hook('session-end', fixture('session-end'), { as: 'alice' });
  assert.ok(w.members().alice.left_at);
  // claude --resume: a new process (this test process), the old session id
  w.pid.alice = process.pid;
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'resume', session_id: oldSid }, { as: 'alice', session: false });
  assert.equal(r.code, 0, r.stderr);
  const c = ctx(r);
  assert.ok(c.startsWith(`SUB-HUMAN role=member name=alice room=${w.code} (restored after resume)`), c.slice(0, 100));
  if (hasRows()) assert.match(c, /ROWS\nYour rows are not running \(they do not survive --resume\)\. Create them now/);
  const m = w.members().alice;
  assert.equal(m.left_at, undefined);
  assert.equal(m.pid, process.pid);
  assert.equal(m.session_id, oldSid);
  const e = w.entries().at(-1);
  assert.deepEqual([e.kind, e.from, e.via, e.text], ['member_joined', 'alice', 'system', 'alice rejoined (resumed)']);
  assert.equal(w.lib(() => identity.resolveByPid(process.pid)).name, 'alice');
});

test('session-restore: --resume into a closed room (orch gone) does nothing', () => {
  const w = new World({ orch: 'sleep', alice: 'sleep' });
  const oldSid = w.sid.alice;
  w.hook('session-end', fixture('session-end'), { as: 'alice' });
  w.lib(() => identity.leave(w.code, 'orch'));
  w.pid.alice = process.pid;
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'resume', session_id: oldSid }, { as: 'alice', session: false });
  assert.equal(r.stdout, '');
  assert.ok(w.members().alice.left_at);
});

test('session-restore: --resume after a crash (seat still registered, old pid dead) moves it to the new pid', async () => {
  const w = new World({ orch: 'sleep', alice: 'sleep' });
  process.kill(w.pid.alice, 'SIGKILL');
  for (let i = 0; i < 100 && identity.isAlive(w.pid.alice); i++) await new Promise(r => setTimeout(r, 20));
  w.pid.alice = process.pid; // new process, same session id; no session-end ran
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'resume', session_id: w.sid.alice }, { as: 'alice', session: false });
  assert.match(ctx(r), /restored after resume/);
  assert.equal(w.members().alice.pid, process.pid);
});

test('session-restore: not joined -> nothing', () => {
  const w = new World({ orch: 'sleep' });
  assert.equal(w.hook('session-restore', fixture('session-start-clear')).stdout, '');
});
