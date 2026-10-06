'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { World, fixture, identity } = require('./helpers.js');

const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

test('session-end: logs member_left and marks the member left; reasons clear and resume are skipped', () => {
  const w = new World({ orch: 'sleep', alice: 'act', bob: 'sleep' });
  let r = w.hook('session-end', { ...fixture('session-end'), reason: 'clear' }, { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  w.hook('session-end', { ...fixture('session-end'), reason: 'resume' }, { as: 'alice' });
  assert.equal(w.entries().length, 0);
  assert.equal(w.members().alice.left_at, undefined);

  r = w.hook('session-end', fixture('session-end'), { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  const e = w.entries().at(-1);
  assert.deepEqual([e.kind, e.from, e.via], ['member_left', 'alice', 'system']);
  assert.match(e.text, /prompt_input_exit/);
  assert.ok(w.members().alice.left_at);
  // a second end (already left) logs nothing
  w.hook('session-end', fixture('session-end'), { as: 'alice' });
  assert.equal(w.entries().length, 1);
  assert.equal(w.lib(() => identity.roomClosing(w.code)), false, 'bob is still here: no reap');
});

test('session-end: the orch\'s own end only marks its seat left (no member_left, no reap)', () => {
  const w = new World({ orch: 'act', alice: 'sleep' });
  const r = w.hook('session-end', { ...fixture('session-end'), reason: 'other' }, { as: 'orch' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.entries().length, 0);
  assert.ok(w.members().orch.left_at);
  assert.equal(w.lib(() => identity.roomClosing(w.code)), false);
});

test('session-end: the last member leaving starts the detached reaper: closing, a to=orch status, claude stop JOB', async () => {
  const w = new World({ alice: 'act' });
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-stub-'));
  const log = path.join(stubDir, 'calls.jsonl');
  const bin = path.join(stubDir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  fs.chmodSync(bin, 0o755);
  w.lib(() => identity.setOrch(w.code, { job: 'feed0042' }));
  w.join('orch', 'sleep');
  const r = w.hook('session-end', fixture('session-end'), { as: 'alice', env: { SUB_HUMAN_CLAUDE: bin } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(await until(() => fs.existsSync(log)), 'claude stop ran');
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8').trim()), ['stop', 'feed0042']);
  const o = w.members().orch;
  assert.ok(o.closing && o.left_at && o.stopped_at);
  const st = w.entries().find(e => e.kind === 'status');
  assert.deepEqual([st.to, st.via, st.text], ['orch', 'system', 'room closed: complete task 1']);
  assert.deepEqual(w.lib(() => identity.openRooms()), []);
});
