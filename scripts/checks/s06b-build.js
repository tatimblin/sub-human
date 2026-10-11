'use strict';
// S6b (--film): the agreed plan built: two room tasks (alice: the handler, bob: the tests), each Claude builds its half in
// its own checkout of one repo and pushes, then alice and bob pull and run npm test. Evidence: the room log, tasks.json
// and what demo.sh saved in state/S6b (task ids, each checkout's git log and HEAD, the origin's HEAD, the driver's own
// npm test run per checkout, and both panes after the people's own run).
const path = require('node:path');
const { readJson, readText, clip } = require('../lib/io.js');

/** `git log --format='commit %H %an%n%s' --name-only` -> [{sha, author, subject, files}] */
function parseGitLog(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) {
    const m = /^commit ([0-9a-f]{7,40}) (.*)$/.exec(l);
    if (m) { out.push({ sha: m[1], author: m[2], subject: null, files: [] }); continue; }
    const c = out.at(-1);
    if (!c || !l.trim()) continue;
    if (c.subject == null) c.subject = l; else c.files.push(l.trim());
  }
  return out;
}

/** The summary of a node --test run (spec: ℹ tests 6, or tap: # tests 6): {tests, pass, fail, exit} (null fields when missing). */
function tapSummary(text) {
  const n = k => { const m = new RegExp(`^[ℹ#] ${k} (\\d+)`, 'm').exec(text || ''); return m ? +m[1] : null; };
  const e = /^exit (\d+)/m.exec(text || '');
  return { tests: n('tests'), pass: n('pass'), fail: n('fail'), exit: e ? +e[1] : null };
}

/** The pane text under the people's own run (the ! bash-mode line), as demo-lib's wait-pane --below reads it. */
function belowRun(pane) {
  const ls = String(pane || '').split('\n');
  let i = -1;
  ls.forEach((l, n) => { if (/npm test --silent/.test(l)) i = n; });
  return i < 0 ? '' : ls.slice(i + 1).join('\n');
}

module.exports = {
  scene: 'S6b',
  parseGitLog, tapSummary,
  run(x, { det }) {
    const { log, roomDir } = x;
    const f = (...p) => x.stateFile('S6b', ...p);
    const [h, t] = (readText(f('tasks.txt')) || '').trim().split(/\s+/);
    const tasks = readJson(path.join(roomDir, 'tasks.json'), []) || [];
    const th = tasks.find(y => String(y.id) === h), tt = tasks.find(y => String(y.id) === t);
    det('The plan is split in two room tasks: the handler for alice, the tests for bob', th && tt && th.owner === 'alice' && tt.owner === 'bob',
      h ? `#${h} ${th ? `"${th.subject}" ${th.owner} ${th.status}` : 'not in tasks.json'}; #${t} ${tt ? `"${tt.subject}" ${tt.owner} ${tt.status}` : 'not in tasks.json'}` : 'no state/S6b/tasks.txt');
    for (const [id, who] of [[h, 'alice'], [t, 'bob']]) {
      const claim = log.find(e => e.kind === 'task_req' && e.op === 'claim' && e.from === who && String(e.task_id) === id);
      const done = log.filter(e => e.kind === 'task_req' && e.op === 'done' && e.from === who && String(e.task_id) === id).at(-1);
      const applied = done && log.find(e => e.kind === 'task' && e.status === 'completed' && String(e.task_id) === id && e.id > done.id);
      det(`${who}'s Claude claims #${id || '?'} and completes it on its own done request, with evidence`, claim && done && done.via === 'agent' && String(done.evidence || '').trim() && applied,
        `claim ${x.fmt(claim)}; done ${x.fmt(done)} evidence "${clip(done && done.evidence, 80)}"; applied ${x.fmt(applied)}`);
    }
    const logs = { alice: parseGitLog(readText(f('git-log-alice.txt'))), bob: parseGitLog(readText(f('git-log-bob.txt'))) };
    const lane = { alice: /^src\//, bob: /^test\// };
    for (const who of ['alice', 'bob']) {
      const mine = logs.alice.filter(c => c.author === who);
      const out = mine.flatMap(c => c.files.filter(p => !lane[who].test(p)));
      det(`${who}'s commits change only ${who === 'alice' ? 'src/' : 'test/'}`, mine.length > 0 && out.length === 0,
        `${mine.length} commit(s) by ${who}: ${mine.map(c => `${c.sha.slice(0, 7)} "${clip(c.subject, 50)}" [${c.files.join(' ')}]`).join('; ') || 'none'}${out.length ? `; outside the lane: ${out.join(' ')}` : ''}`);
    }
    const heads = ['alice', 'bob', 'origin'].map(n => (readText(f(`head-${n}.txt`)) || '').trim());
    det('Both checkouts end at the origin\'s commit (each pulled the other\'s half)', heads.every(s => /^[0-9a-f]{40}$/.test(s)) && new Set(heads).size === 1,
      `alice ${heads[0].slice(0, 7) || '?'}, bob ${heads[1].slice(0, 7) || '?'}, origin ${heads[2].slice(0, 7) || '?'}`);
    for (const who of ['alice', 'bob']) {
      const s = tapSummary(readText(f(`npm-test-${who}.txt`)));
      det(`npm test passes in ${who}'s checkout, with the paging tests (the driver's own run)`, s.exit === 0 && s.fail === 0 && s.pass === s.tests && s.tests > 1,
        `state/S6b/npm-test-${who}.txt: tests ${s.tests}, pass ${s.pass}, fail ${s.fail}, exit ${s.exit}`);
      const below = belowRun(readText(f(`pane-${who}.txt`)));
      det(`${who}'s pane shows ${who === 'alice' ? 'her' : 'his'} own npm test passing`, /[ℹ#] pass [1-9]\d*\s*\n\s*(⎿\s*)?[ℹ#] fail 0\s*$/m.test(below),
        clip(below.split('\n').filter(l => /[ℹ#]\s*(tests|pass|fail) \d/.test(l)).join(' / '), 160) || `no run in state/S6b/pane-${who}.txt`);
    }
  },
};
