'use strict';
// hooks/notice.js (SessionStart watchPaths, FileChanged systemMessage, SessionEnd cleanup) and at-room.js's
// next-prompt systemMessage for join / leave notices no notification showed yet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, fixture, ctx, PLUGIN } = require('./helpers.js');
const notices = require(path.join(PLUGIN, 'lib', 'notices.js'));
const rows = require(path.join(PLUGIN, 'lib', 'rows.js'));

const submit = prompt => ({ ...fixture('user-prompt-submit'), prompt });
const moved = (w, kind, name, text) => w.append({ kind, text: text || `${name} ${kind}` }, { via: 'system', from: name, system: true });

test('notice: SessionStart watches this session\'s notice file; SessionEnd removes it', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const r = w.hook('notice', { hook_event_name: 'SessionStart', source: 'startup' }, { as: 'alice' });
  const f = path.join(w.home, 'notices', `${w.sid.alice}.json`);
  assert.deepEqual(r.json, { hookSpecificOutput: { hookEventName: 'SessionStart', watchPaths: [f] } });
  assert.ok(fs.existsSync(f), 'created, so the watcher has a file');
  assert.equal(w.hook('notice', { hook_event_name: 'SessionEnd', reason: 'clear' }, { as: 'alice' }).stdout, '');
  assert.equal(fs.existsSync(f), false);
});

test('notice: FileChanged shows unseen notices as systemMessage (no context for the model), once', () => {
  const w = new World({ orch: 'sleep', alice: 'act', bob: 'sleep' });
  const j = moved(w, 'member_joined', 'bob', 'bob joined');
  const f = w.lib(() => notices.write(w.sid.alice, [{ id: j.id, code: w.code, name: 'alice', text: `⬡ bob joined ${w.code} (alice, bob here)`, at: new Date().toISOString() }]));
  const ev = { hook_event_name: 'FileChanged', file_path: f, event: 'change' };
  const r = w.hook('notice', ev, { as: 'alice' });
  assert.deepEqual(r.json, { systemMessage: `⬡ bob joined ${w.code} (alice, bob here)` });
  assert.deepEqual(w.lib(() => [...notices.shown(w.code, 'alice')]), [j.id]);
  const rec = JSON.parse(fs.readFileSync(path.join(w.home, 'rooms', w.code, 'rows', 'notices-alice.json'), 'utf8'));
  assert.deepEqual(rec.log.map(x => [x.id, x.via]), [[j.id, 'notification']]);
  assert.equal(w.hook('notice', ev, { as: 'alice' }).stdout, '', 'already shown');
  assert.equal(w.hook('notice', { ...ev, event: 'unlink' }, { as: 'alice' }).stdout, '');
  assert.equal(w.hook('notice', { ...ev, file_path: '/etc/hosts' }, { as: 'alice' }).stdout, '', 'not a notice file');
});

test('at-room: a join / settled leave no notification showed goes out as systemMessage on the next prompt; the model gets the pull digest', () => {
  const w = new World({ orch: 'sleep', alice: 'act', bob: 'sleep' }, {});
  moved(w, 'member_joined', 'alice', 'alice joined');
  w.lib(() => rows.writeHolds(w.code, 'alice', { room: true, members: ['bob'] }));
  const j = moved(w, 'member_joined', 'bob', 'bob joined');
  const env = { SUB_HUMAN_LEAVE_MS: '400' };
  let r = w.hook('at-room', submit('what is next?'), { as: 'alice', env });
  assert.equal(r.json.systemMessage, `⬡ bob joined ${w.code} (alice, bob here)`);
  assert.match(ctx(r), new RegExp(`^#${j.id} bob\\[system\\] member_joined `, 'm'), 'the model sees it only in the pull digest');
  assert.equal(w.hook('at-room', submit('and now?'), { as: 'alice', env }).stdout, '', 'shown once');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.home, 'rooms', w.code, 'rows', 'notices-alice.json'), 'utf8')).log[0].via, 'prompt');
  // a leave is held until it settles
  const l = moved(w, 'member_left', 'bob', 'bob left');
  r = w.hook('at-room', submit('hm'), { as: 'alice', env });
  assert.equal(r.json && r.json.systemMessage, undefined, 'not yet: still inside the settle window');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 450);
  r = w.hook('at-room', submit('ok'), { as: 'alice', env });
  assert.equal(r.json.systemMessage, `⬡ bob left ${w.code}`);
  // one the notification already showed is not repeated
  const j2 = moved(w, 'member_joined', 'bob', 'bob rejoined');
  w.lib(() => notices.markShown(w.code, 'alice', [j2.id]));
  r = w.hook('at-room', submit('back?'), { as: 'alice', env });
  assert.equal(r.json && r.json.systemMessage, undefined);
  void l;
});

test('at-room: the orch never gets a notice systemMessage', () => {
  const w = new World({ orch: 'act', alice: 'sleep' });
  moved(w, 'member_joined', 'alice', 'alice joined');
  const r = w.hook('at-room', submit('<task-notification>\n<event>x</event>\n</task-notification>'), { as: 'orch' });
  assert.equal(r.json && r.json.systemMessage, undefined);
});
