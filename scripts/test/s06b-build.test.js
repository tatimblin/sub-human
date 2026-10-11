'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runChecks, SCENES } = require('../checks.js');
const mod = require('../checks/s06b-build.js');

const SHA = c => c.repeat(40);
const gitLog = `commit ${SHA('b')} bob\nAdd paging tests\n\ntest/paging.test.js\ncommit ${SHA('a')} alice\nCursor paging for GET /tasks\n\nsrc/server.js\nsrc/store.js\ncommit ${SHA('0')} tasks-api\ntasks-api\n\npackage.json\n`;
const TAP = '✔ GET /health (15ms)\nℹ tests 6\nℹ suites 0\nℹ pass 6\nℹ fail 0\nℹ cancelled 0\nexit 0\n';
// the people's own run, scrolled: the typed line is gone, the summary under it stays (a Claude's earlier failing run above)
const SUMMARY = (pass, fail, ms) => `     ℹ tests ${pass + fail}\n     ℹ suites 0\n     ℹ pass ${pass}\n     ℹ fail ${fail}\n     ℹ cancelled 0\n     ℹ skipped 0\n     ℹ todo 0\n     ℹ duration_ms ${ms}\n`;
const PANE = `  ⎿  ℹ tests 6\n${SUMMARY(5, 1, 80.1)}\n⏺ one fails\n     ✔ GET /tasks pages (3ms)\n${SUMMARY(6, 0, 181.4)}\n⏺ All 6 pass.\n\n──────\n❯ \n`;
// a person's pane with the room row opened (Enter on it): the other member inside it
const ROOM = (other, code = 'husky-7354') => `─── ${code} ─\n❯ Message @sub-human:room…\n────\n  ↑/↓ to select · ctrl+x ctrl+k to stop all agents\n\n  ◯ main\n❯ ⏺ ${code}  +bob joined · 2 here\n  └ ◯ ${other}  working\n`;
const SUB = '❯ \n────\n  ⏵⏵ auto mode on · ← 2 agents · ↓ to manage\n\n  ⏺ main\n  ◯ husky-7354  2 here\n  ◯ Explore  Read server and store for tests          4s · ↓ 19.3k tokens\n';

function world({ gitLogAlice = gitLog, tapBob = TAP, paneBob = PANE, doneFrom = 'bob', roomBob = ROOM('alice'), subBob = SUB } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-s6b-'));
  const st = path.join(d, 'screens', 'state', 'S6b');
  fs.mkdirSync(st, { recursive: true });
  fs.mkdirSync(path.join(d, 'screens', 'state', 'S2'));
  fs.writeFileSync(path.join(d, 'screens', 'state', 'S2', 'panel-alice.txt'), ROOM('bob'));
  fs.writeFileSync(path.join(d, 'screens', 'state', 'S2', 'panel-bob.txt'), roomBob);
  const w = (f, s) => fs.writeFileSync(path.join(st, f), s);
  w('panel-subagent-bob.txt', subBob);
  w('tasks.txt', '2 3\n');
  w('git-log-alice.txt', gitLogAlice); w('git-log-bob.txt', gitLog);
  for (const n of ['alice', 'bob', 'origin']) w(`head-${n}.txt`, SHA('b') + '\n');
  w('npm-test-alice.txt', TAP); w('npm-test-bob.txt', tapBob);
  w('pane-alice.txt', PANE); w('pane-bob.txt', paneBob);
  const roomDir = path.join(d, 'room');
  fs.mkdirSync(roomDir);
  fs.writeFileSync(path.join(roomDir, 'tasks.json'), JSON.stringify([
    { id: '2', subject: 'paging handler: src/server.js + src/store.js', status: 'completed', owner: 'alice' },
    { id: '3', subject: 'paging tests: test/paging.test.js', status: 'completed', owner: 'bob' },
  ]));
  const e = (id, from, kind, f) => ({ id, from, kind, via: from === 'claude' ? 'system' : 'agent', at: `2026-01-01T00:00:${String(id).padStart(2, '0')}Z`, text: '', ...f });
  const log = [
    e(10, 'alice', 'task_req', { op: 'claim', task_id: '2' }), e(11, 'bob', 'task_req', { op: 'claim', task_id: '3' }),
    e(12, 'alice', 'task_req', { op: 'done', task_id: '2', evidence: 'npm test 6/6' }), e(13, 'claude', 'task', { op: 'update', task_id: '2', status: 'completed' }),
    e(14, doneFrom, 'task_req', { op: 'done', task_id: '3', evidence: 'npm test 6/6' }), e(15, 'claude', 'task', { op: 'update', task_id: '3', status: 'completed' }),
  ];
  return { log, roomDir, code: 'husky-7354', fmt: x => (x ? `#${x.id} ${x.from} ${x.kind}` : 'none'), stateFile: (...p) => path.join(d, 'screens', 'state', ...p) };
}
const run = ctx => runChecks(ctx, { scenes: [mod] }).S6b;

test('S6b: a clean build passes every check', () => {
  const r = run(world());
  assert.ok(r.length >= 12);
  assert.deepEqual(r.filter(c => !c.pass).map(c => `${c.check}: ${c.evidence}`), []);
  assert.ok(SCENES.includes(mod));
});

test('S6b: alice editing test/, a failing run, a pane with no run, or a done from the wrong seat each fail', () => {
  const failed = ctx => run(ctx).filter(c => !c.pass).map(c => c.check);
  assert.deepEqual(failed(world({ gitLogAlice: gitLog.replace('src/store.js', 'test/health.test.js') })), ["alice's commits change only src/"]);
  assert.deepEqual(failed(world({ tapBob: TAP.replace('ℹ fail 0', 'ℹ fail 1').replace('exit 0', 'exit 1') })), ["npm test passes in bob's checkout, with the paging tests (the driver's own run)"]);
  assert.deepEqual(failed(world({ paneBob: '❯ \n' })), ["bob's pane shows his own npm test passing"]);
  assert.deepEqual(failed(world({ paneBob: PANE.replace('ℹ fail 0', 'ℹ fail 2') })), ["bob's pane shows his own npm test passing"]);
  assert.deepEqual(failed(world({ doneFrom: 'alice' })), ["bob's Claude claims #3 and completes it on its own done request, with evidence"]);
});

test('S6b (film): the opened room row must show the other person; a subagent row must show in bob\'s panel', () => {
  const failed = ctx => run(ctx).filter(c => !c.pass).map(c => c.check);
  // the room row selected but not opened: no member rows under it
  assert.deepEqual(failed(world({ roomBob: '  ⏺ main\n❯ ◯ husky-7354  2 here\n' })), ['bob opens the husky-7354 row in the agent panel: alice shows inside it']);
  assert.deepEqual(failed(world({ subBob: '  ⏺ main\n  ◯ husky-7354  2 here\n  └ ◯ alice  working\n' })), ["bob's Claude runs a subagent of its own: its row shows in his panel beside the room row"]);
  assert.deepEqual(failed(world({ subBob: '' })), ["bob's Claude runs a subagent of its own: its row shows in his panel beside the room row"]);
});

test('S6b: the last npm test summary in a pane', () => {
  assert.deepEqual(mod.lastSummary(PANE), { pass: 6, fail: 0, text: 'ℹ pass 6 / ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 0 / ℹ todo 0 / ℹ duration_ms 181.4' });
  assert.equal(mod.lastSummary('ℹ pass 6\nℹ fail 0\n'), null); // cut off: no duration line
});

test('S6b: git log and tap parsing', () => {
  assert.deepEqual(mod.parseGitLog(gitLog).map(c => [c.author, c.files.length]), [['bob', 1], ['alice', 2], ['tasks-api', 1]]);
  assert.deepEqual(mod.tapSummary(TAP), { tests: 6, pass: 6, fail: 0, exit: 0 });
  assert.deepEqual(mod.tapSummary('# tests 2\n# pass 2\n# fail 0\nexit 0'), { tests: 2, pass: 2, fail: 0, exit: 0 }); // tap too
  assert.deepEqual(mod.tapSummary(''), { tests: null, pass: null, fail: null, exit: null });
});
