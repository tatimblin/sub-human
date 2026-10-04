'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, fixture, identity, ctx, hso, roomPlan } = require('./helpers.js');

const NEW_SID = '8cea5671-97a8-49c2-bcdb-4a62d51b6a18';

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
  assert.deepEqual(w.lib(() => identity.resolveBySession(NEW_SID)), { code: w.code, name: 'alice', role: 'member' });
  assert.equal(w.lib(() => identity.resolveBySession(w.sid.alice)), null, 'old session id dropped');
});

test('session-restore: a clear with a pending review warns not to implement; the digest is capped', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  for (let i = 0; i < 40; i++) w.append({ kind: 'say', text: 'y'.repeat(400) + i }, { via: 'human', from: 'alice' });
  fs.mkdirSync(w.memberDir('alice'), { recursive: true });
  fs.writeFileSync(path.join(w.memberDir('alice'), 'pending_review.json'), '{"hash":"abcdefabcdef"}');
  const r = w.hook('session-restore', { ...fixture('session-start-clear'), session_id: NEW_SID }, { as: 'alice', session: false });
  assert.match(ctx(r), /^The previous plan approval was a ROOM REVIEW/);
  assert.ok(ctx(r).length <= 9500);
  assert.equal(fs.existsSync(path.join(w.memberDir('alice'), 'pending_review.json')), false);
});

test('session-restore: not joined -> nothing', () => {
  const w = new World({ orch: 'sleep' });
  assert.equal(w.hook('session-restore', fixture('session-start-clear')).stdout, '');
});
