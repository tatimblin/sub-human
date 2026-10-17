import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World, fixture, identity } from './helpers.ts';
import { must } from '../support/must.ts';

const until = async (fn: () => unknown, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

test('session-end: logs member_left and marks the member left; reasons clear and resume are skipped', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  let r = w.hook('session-end', { ...fixture('session-end'), reason: 'clear' }, { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  w.hook('session-end', { ...fixture('session-end'), reason: 'resume' }, { as: 'alice' });
  assert.equal(w.entries().length, 0);
  assert.equal(must(w.members().alice).left_at, undefined);

  r = w.hook('session-end', fixture('session-end'), { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  const e = must(w.entries().at(-1));
  assert.deepEqual([e.kind, e.from, e.via], ['member_left', 'alice', 'system']);
  assert.match(must(e.text), /left \(session ended\)/, 'Claude Code\'s token, in words');
  assert.ok(must(w.members().alice).left_at);
  // a second end (already left) logs nothing
  w.hook('session-end', fixture('session-end'), { as: 'alice' });
  assert.equal(w.entries().length, 1);
  assert.equal(w.lib(() => identity.roomClosing(w.code)), false, 'bob is still here: no reap');
});

test('session-end: deletes the session\'s hello lease on every reason, seated or not', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  const lease = (s: string) => path.join(w.home, 'sessions', 'mods', `${s}.json`);
  const alice = must(w.sid.alice, 'alice\'s session id');
  for (const reason of ['clear', 'prompt_input_exit']) {
    w.modLease(alice);
    assert.ok(fs.existsSync(lease(alice)));
    const r = w.hook('session-end', { ...fixture('session-end'), reason }, { as: 'alice' });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!fs.existsSync(lease(alice)), reason);
  }
  const unseated = 'aaaaaaaa-0000-4000-8000-000000000061';
  w.modLease(unseated);
  assert.equal(w.hook('session-end', { ...fixture('session-end'), session_id: unseated }).code, 0);
  assert.ok(!fs.existsSync(lease(unseated)));
});

test('session-end: the room\'s Claude\'s own end only marks its seat left (no member_left, no reap)', () => {
  const w = new World({ claude: 'act', alice: 'sleep' });
  const r = w.hook('session-end', { ...fixture('session-end'), reason: 'other' }, { as: 'claude' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.entries().length, 0);
  assert.ok(must(w.members().claude).left_at);
  assert.equal(w.lib(() => identity.roomClosing(w.code)), false);
});

test('session-end: the last member leaving starts the detached reaper: closing, a to=claude status, claude stop JOB', async () => {
  const w = new World({ alice: 'act' });
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-stub-'));
  const log = path.join(stubDir, 'calls.jsonl');
  const bin = path.join(stubDir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  fs.chmodSync(bin, 0o755);
  w.lib(() => identity.updateRoomClaude(w.code, () => ({ job: 'feed0042' })));
  w.join('claude', 'sleep');
  const r = w.hook('session-end', fixture('session-end'), { as: 'alice', env: { SUB_HUMAN_CLAUDE: bin } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(await until(() => fs.existsSync(log)), 'claude stop ran');
  // the first call; the reaper then lists jobs for strays (stopStrays)
  assert.deepEqual(JSON.parse(must(fs.readFileSync(log, 'utf8').split('\n')[0])), ['stop', 'feed0042']);
  // the reaper marks the room's Claude stopped and left just after `claude stop` returns
  assert.ok(await until(() => { const o = w.members().claude; return o?.closing && o.left_at && o.stopped_at; }), 'claude marked closing, stopped, left');
  assert.ok(!w.entries().some(e => e.kind === 'status' && e.to === 'claude'), 'nothing asked of the room session\'s model');
  assert.deepEqual(w.lib(() => identity.openRooms()), []);
});

test('session-end: fits its budget: the reaper is detached, so a slow `claude stop` does not hold the hook', () => {
  const w = new World({ alice: 'act' });
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-stub-'));
  const bin = path.join(stubDir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);\n`);
  fs.chmodSync(bin, 0o755);
  w.lib(() => identity.updateRoomClaude(w.code, () => ({ job: 'feed0043' })));
  w.join('claude', 'sleep');
  const t0 = Date.now();
  const r = w.hook('session-end', fixture('session-end'), { as: 'alice', env: { SUB_HUMAN_CLAUDE: bin } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  assert.ok(must(w.members().alice).left_at);
  assert.ok(w.entries().some(e => e.kind === 'member_left'));
});
