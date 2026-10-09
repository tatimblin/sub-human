'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, fixture, identity, ctx, hso, roomPlan } = require('./helpers.js');

const NEW_SID = '8cea5671-97a8-49c2-bcdb-4a62d51b6a18';
const hasRows = () => { try { require('../../lib/rows.js'); return true; } catch { return false; } };

test('session-restore: after /clear, rebinds the new session id by CLAUDE_PID and re-injects the mechanics block', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  w.append({ kind: 'say', text: 'hello room' }, { via: 'human', from: 'alice' });
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), session_id: NEW_SID }, { as: 'alice', session: false });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(hso(r).hookEventName, 'SessionStart');
  const c = ctx(r);
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
  const c = ctx(r);
  if (hasRows()) assert.match(c, /ROWS\n[^]*subagent_type: "sub-human:room"/, 'no live hold: the room row is listed');
  const r2 = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'compact' }, { as: 'alice' });
  assert.match(ctx(r2), /restored after compact/);
  const ro = w.hook('session-restore', { ...fixture('session-start-clear'), source: 'compact' }, { as: 'claude' });
  assert.ok(ctx(ro).startsWith(`SUB-HUMAN: you are claude, the room's Claude of room ${w.code}`), ctx(ro).slice(0, 80));
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
  const c = ctx(r);
  assert.ok(c.startsWith(`SUB-HUMAN: you are alice's Claude in room ${w.code}`) && c.endsWith('(restored after resume)'), c.slice(0, 100));
  if (hasRows()) assert.match(c, /ROWS\n[^]*subagent_type: "sub-human:room"/);
  const m = w.members().alice;
  assert.equal(m.left_at, undefined);
  assert.equal(m.pid, process.pid);
  assert.equal(m.session_id, oldSid);
  const e = w.entries().at(-1);
  assert.deepEqual([e.kind, e.from, e.via, e.text], ['member_joined', 'alice', 'system', 'alice rejoined (resumed)']);
  assert.equal(w.lib(() => identity.resolveByPid(process.pid)).name, 'alice');
});

test('session-restore: --resume into a closing or closed room does nothing', () => {
  const w = new World({ claude: 'sleep', alice: 'sleep' });
  const oldSid = w.sid.alice;
  w.hook('session-end', fixture('session-end'), { as: 'alice' }); // the last member: the reaper starts (grace 0 here)
  w.lib(() => identity.setRoomClaude(w.code, { closing: new Date().toISOString() }));
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
  assert.match(ctx(r), /restored after resume/);
  assert.equal(w.members().alice.pid, process.pid);
});

test('session-restore: not joined -> nothing', () => {
  const w = new World({ claude: 'sleep' });
  assert.equal(w.hook('session-restore', fixture('session-start-clear')).stdout, '');
});

test('session-restore: a review left open (plan file still the proposal) is restored and cleared after clear; a fresh one survives compact', () => {
  const proposal = require('../../lib/proposal.js');
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const text = '# Cursor paging\n\n1. after=\n';
  const hash = w.lib(() => proposal.create({ code: w.code, name: 'bob', role: 'member' }, { text, approvers: ['alice'] })).hash;
  const file = path.join(w.userHome, '.claude', 'plans', 'stuck.md');
  const st = path.join(w.memberDir('alice'), 'review.json');
  const leave = (extra = {}) => {
    fs.writeFileSync(file, text);
    fs.mkdirSync(path.dirname(st), { recursive: true });
    fs.writeFileSync(st, JSON.stringify({ phase: 'shown', mode: 'default', at: Date.now(), hash, file, backup: 'alice\'s plan\n', restored: false, ...extra }));
  };
  leave();
  w.hook('session-restore', { ...fixture('session-start-clear'), source: 'compact' }, { as: 'alice' });
  assert.ok(fs.existsSync(st), 'a fresh review survives compaction');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  leave({ at: Date.now() - 2 * 60 * 60 * 1000 });
  w.hook('session-restore', { ...fixture('session-start-clear'), source: 'compact' }, { as: 'alice' });
  assert.equal(fs.existsSync(st), false, 'a stale one is cleared');
  assert.equal(fs.readFileSync(file, 'utf8'), 'alice\'s plan\n', 'and the person\'s plan is back');
  // After /clear: always; a plan file the person rewrote since is left alone.
  leave();
  fs.writeFileSync(file, 'alice wrote this since\n');
  w.hook('session-restore', { ...fixture('session-start-clear'), session_id: NEW_SID }, { as: 'alice', session: false });
  assert.equal(fs.existsSync(st), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'alice wrote this since\n');
  // No backup (the file did not exist before): the proposal's copy is removed.
  leave({ backup: null });
  w.hook('session-restore', { ...fixture('session-start-clear'), source: 'compact', session_id: NEW_SID }, { as: 'alice', session: false });
  assert.ok(fs.existsSync(st), 'compact, fresh: kept');
  w.hook('session-restore', { ...fixture('session-start-clear'), source: 'clear', session_id: NEW_SID }, { as: 'alice', session: false });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(st), false);
});
