'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runChecks, SCENES } = require('../checks.js');
const mod = require('../checks/s06b-build.js');

const SHA = c => c.repeat(40);
// the origin's history: B's handler on top of A's store
const GITLOG = (A, B) => `commit ${SHA('b')} ${B}\nGET /tasks: cursor paging\n\nsrc/server.js\ntest/server-paging.test.js\n`
  + `commit ${SHA('a')} ${A}\nlistTasks: newest first, opaque cursor\n\nsrc/store.js\ntest/store-paging.test.js\ncommit ${SHA('0')} tasks-api\ntasks-api\n\npackage.json\n`;
// B's checkout: cloned, A's store pulled at 00:00:30, B's commit after it
const REFLOG = '2026-01-01T00:00:40Z commit: GET /tasks: cursor paging\n2026-01-01T00:00:30Z pull: Fast-forward\n2026-01-01T00:00:01Z clone: from /tmp/sh-demo/origin.git';
const reflog = s => s.split('\n').map(l => { const [at, ...m] = l.split(' '); return `HEAD@{${at}} ${m.join(' ')}`; }).join('\n') + '\n';
const TAP = '✔ GET /health (15ms)\nℹ tests 9\nℹ suites 0\nℹ pass 9\nℹ fail 0\nℹ cancelled 0\nexit 0\n';
// the people's own run, scrolled: the typed line is gone, the summary under it stays (a Claude's earlier failing run above)
const SUMMARY = (pass, fail, ms) => `     ℹ tests ${pass + fail}\n     ℹ suites 0\n     ℹ pass ${pass}\n     ℹ fail ${fail}\n     ℹ cancelled 0\n     ℹ skipped 0\n     ℹ todo 0\n     ℹ duration_ms ${ms}\n`;
const PANE = `  ⎿  ℹ tests 9\n${SUMMARY(8, 1, 80.1)}\n⏺ one fails\n     ✔ GET /tasks pages (3ms)\n${SUMMARY(9, 0, 181.4)}\n⏺ All 9 pass.\n\n──────\n❯ \n`;
// a person's pane with the room row opened (Enter on it): the other member inside it
const ROOM = (other, code = 'husky-7354') => `─── ${code} ─\n❯ Message @sub-human:room…\n────\n  ↑/↓ to select · ctrl+x ctrl+k to stop all agents\n\n  ◯ main\n❯ ⏺ ${code}  +${other} joined · 2 here\n  └ ◯ ${other}  working\n`;
const SUB = '❯ \n────\n  ⏵⏵ auto mode on · ← 2 agents · ↓ to manage\n\n  ⏺ main\n  ◯ husky-7354  2 here\n  ◯ Explore  Read src/store.js listTasks          4s · ↓ 19.3k tokens\n';
const at = s => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;

function world({ A = 'tristan', B = 'jess', gitLog, reflogB = REFLOG, tapB = TAP, paneB = PANE, doneFrom, roomB, subB = SUB, handoffAt = 20, handoffText = 'listTasks is pushed to origin/main' } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-s6b-'));
  const st = path.join(d, 'screens', 'state', 'S6b');
  fs.mkdirSync(st, { recursive: true });
  fs.mkdirSync(path.join(d, 'screens', 'state', 'S2'));
  fs.writeFileSync(path.join(d, 'screens', 'state', 'S2', `panel-${A}.txt`), ROOM(B));
  fs.writeFileSync(path.join(d, 'screens', 'state', 'S2', `panel-${B}.txt`), roomB ?? ROOM(A));
  const w = (f, s) => fs.writeFileSync(path.join(st, f), s);
  w(`panel-subagent-${B}.txt`, subB);
  w('tasks.txt', '2 3\n');
  const gl = gitLog ?? GITLOG(A, B);
  w(`git-log-${A}.txt`, gl); w(`git-log-${B}.txt`, gl);
  w(`reflog-${B}.txt`, reflog(reflogB));
  for (const n of [A, B, 'origin']) w(`head-${n}.txt`, SHA('b') + '\n');
  w(`npm-test-${A}.txt`, TAP); w(`npm-test-${B}.txt`, tapB);
  w(`pane-${A}.txt`, PANE); w(`pane-${B}.txt`, paneB);
  const roomDir = path.join(d, 'room');
  fs.mkdirSync(roomDir);
  fs.writeFileSync(path.join(roomDir, 'tasks.json'), JSON.stringify([
    { id: '2', subject: 'paging store: listTasks in src/store.js', status: 'completed', owner: A },
    { id: '3', subject: 'paging handler: GET /tasks in src/server.js', status: 'completed', owner: B },
  ]));
  const e = (id, from, kind, f) => ({ id, from, kind, via: from === 'claude' ? 'system' : 'agent', at: at(id), text: '', ...f });
  const log = [
    e(10, A, 'task_req', { op: 'claim', task_id: '2' }), e(11, B, 'task_req', { op: 'claim', task_id: '3' }),
    e(12, A, 'task_req', { op: 'done', task_id: '2', evidence: 'npm test 6/6' }), e(13, 'claude', 'task', { op: 'update', task_id: '2', status: 'completed' }),
    e(44, doneFrom ?? B, 'task_req', { op: 'done', task_id: '3', evidence: 'npm test 9/9' }), e(45, 'claude', 'task', { op: 'update', task_id: '3', status: 'completed' }),
  ];
  // B's transcript: the peer message from A's Claude (Claude Code's origin {kind: peer, name: A.CODE})
  const transcripts = { [B]: handoffAt == null ? [] : [{ type: 'user', timestamp: at(handoffAt), origin: { kind: 'peer', name: `${A}.husky-7354`, body: handoffText }, message: { content: handoffText } }] };
  return {
    A, B, log, roomDir, code: 'husky-7354', fmt: x => (x ? `#${x.id} ${x.from} ${x.kind}` : 'none'), stateFile: (...p) => path.join(d, 'screens', 'state', ...p),
    entries: seat => transcripts[seat] || [], span: () => ({ from: at(0), to: at(59) }),
    inSpan: (es, s) => es.filter(y => y.timestamp > s.from && y.timestamp <= s.to),
    peerIn: (es, from) => es.filter(y => y.origin && y.origin.kind === 'peer' && String(y.origin.name).startsWith(from + '.')),
    textOf: c => (typeof c === 'string' ? c : ''),
  };
}
const run = ctx => runChecks(ctx, { scenes: [mod] }).S6b;
const failed = ctx => run(ctx).filter(c => !c.pass).map(c => c.check);

test('S6b: a clean build passes every check, for tristan and jess or alice and bob', () => {
  for (const pair of [{}, { A: 'alice', B: 'bob' }]) {
    const r = run(world(pair));
    assert.ok(r.length >= 13, `${r.length} checks`);
    assert.deepEqual(r.filter(c => !c.pass).map(c => `${c.check}: ${c.evidence}`), []);
  }
  assert.ok(SCENES.includes(mod));
});

test('S6b: each person\'s Claude writes real code in its own lane, with its own tests', () => {
  const G = GITLOG('tristan', 'jess');
  // tristan's Claude also touching the handler; jess's committing no tests; jess's commits only tests (no code)
  assert.deepEqual(failed(world({ gitLog: G.replace('src/store.js\n', 'src/store.js\nsrc/server.js\n') })), ["tristan's Claude writes the store side: its commits change src/store.js and test/store-paging.test.js, and nothing else"]);
  assert.deepEqual(failed(world({ gitLog: G.replace('src/server.js\ntest/server-paging.test.js\n', 'src/server.js\n') })), ["jess's Claude writes the HTTP side: its commits change src/server.js and test/server-paging.test.js, and nothing else"]);
  assert.deepEqual(failed(world({ gitLog: G.replace('src/server.js\ntest/server-paging.test.js\n', 'test/server-paging.test.js\n') })), ["jess's Claude writes the HTTP side: its commits change src/server.js and test/server-paging.test.js, and nothing else"]);
});

test('S6b: the handoff message must come before jess\'s checkout pulls', () => {
  const H = "The handoff: tristan's Claude tells jess's Claude the store is pushed before jess's checkout pulls it";
  assert.deepEqual(failed(world({ handoffAt: 35 })), [H]); // pulled at :30, told at :35
  assert.deepEqual(failed(world({ handoffAt: null })), [H]);
  assert.deepEqual(failed(world({ handoffText: 'how do you encode the cursor?' })), [H]);
  assert.deepEqual(failed(world({ reflogB: REFLOG.split('\n').filter(l => !/pull/.test(l)).join('\n') })), [H]);
  // a fetch and a rebase count as the pull
  assert.deepEqual(failed(world({ reflogB: REFLOG.replace('pull: Fast-forward', 'rebase (finish): returning to refs/heads/main') })), []);
});

test('S6b: a failing run, a pane with no run, or a done from the wrong seat each fail', () => {
  assert.deepEqual(failed(world({ tapB: TAP.replace('ℹ fail 0', 'ℹ fail 1').replace('exit 0', 'exit 1') })), ["npm test passes in jess's checkout, with both halves' tests (the driver's own run)"]);
  assert.deepEqual(failed(world({ paneB: '❯ \n' })), ["jess's pane shows jess's own npm test passing"]);
  assert.deepEqual(failed(world({ paneB: PANE.replace('ℹ fail 0', 'ℹ fail 2') })), ["jess's pane shows jess's own npm test passing"]);
  assert.deepEqual(failed(world({ doneFrom: 'tristan' })), ["jess's Claude claims #3 and completes it on its own done request, with evidence"]);
});

test('S6b (film): the opened room row must show the other person; a subagent row must show in jess\'s panel', () => {
  // the room row selected but not opened: no member rows under it
  assert.deepEqual(failed(world({ roomB: '  ⏺ main\n❯ ◯ husky-7354  2 here\n' })), ['jess opens the husky-7354 row in the agent panel: tristan shows inside it']);
  assert.deepEqual(failed(world({ subB: '  ⏺ main\n  ◯ husky-7354  2 here\n  └ ◯ tristan  working\n' })), ["jess's Claude runs a subagent of its own: its row shows in jess's panel beside the room row"]);
  assert.deepEqual(failed(world({ subB: '' })), ["jess's Claude runs a subagent of its own: its row shows in jess's panel beside the room row"]);
});

test('S6b: the last npm test summary in a pane', () => {
  assert.deepEqual(mod.lastSummary(PANE), { pass: 9, fail: 0, text: 'ℹ pass 9 / ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 0 / ℹ todo 0 / ℹ duration_ms 181.4' });
  assert.equal(mod.lastSummary('ℹ pass 6\nℹ fail 0\n'), null); // cut off: no duration line
});

test('S6b: git log, reflog and tap parsing', () => {
  assert.deepEqual(mod.parseGitLog(GITLOG('tristan', 'jess')).map(c => [c.author, c.files.length]), [['jess', 2], ['tristan', 2], ['tasks-api', 1]]);
  // what git log -g --date=iso-strict --format='%gd %gs' prints (a real pull -q in a clone)
  const rl = 'HEAD@{2026-10-11T17:43:32-07:00} pull -q: Fast-forward\nHEAD@{2026-10-11T17:43:30-07:00} clone: from /tmp/rlt/.\n';
  assert.deepEqual(mod.parseReflog(rl).map(r => r.msg), ['clone: from /tmp/rlt/.', 'pull -q: Fast-forward']);
  assert.deepEqual(mod.firstPull(rl), { at: '2026-10-11T17:43:32-07:00', msg: 'pull -q: Fast-forward' });
  assert.equal(mod.firstPull('HEAD@{2026-10-11T17:43:30-07:00} clone: from x\n'), null);
  assert.deepEqual(mod.tapSummary(TAP), { tests: 9, pass: 9, fail: 0, exit: 0 });
  assert.deepEqual(mod.tapSummary('# tests 2\n# pass 2\n# fail 0\nexit 0'), { tests: 2, pass: 2, fail: 0, exit: 0 }); // tap too
  assert.deepEqual(mod.tapSummary(''), { tests: null, pass: null, fail: null, exit: null });
});
