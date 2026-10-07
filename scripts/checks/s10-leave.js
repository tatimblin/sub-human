'use strict';
// S10: leave: both exit, the reaper completes task 1 and stops the orch; plus run-wide notice and id checks
const path = require('node:path');
const paths = require('../lib/paths.js');
const { MAIN_ROW } = require('../lib/panes.js');
const { readJson, readText, clip } = require('../lib/io.js');

module.exports = {
  scene: 'S10',
  run(x, { det }) {
    const { code, log, members, job, orchSid, roomDir, index, screens } = x;
    const s = x.span('S10');
    const la = x.logIn(s).find(e => e.kind === 'member_left' && e.from === 'alice'), lb = x.logIn(s).find(e => e.kind === 'member_left' && e.from === 'bob');
    det('Both leave: member_left alice and bob', la && lb, `${x.fmt(la)}; ${x.fmt(lb)}`);
    const cl = log.find(e => e.kind === 'status' && e.to === 'orch' && e.via === 'system' && /room closed/.test(e.text));
    det('The reaper marks the room closing and tells the orch "room closed: complete task 1"', cl && members.orch && members.orch.closing, `${x.fmt(cl)}; members.json orch.closing ${members.orch && members.orch.closing}`);
    const t1 = x.nativeTasks('S10', 'last').find(t => t.id === '1');
    const t1live = readJson(path.join(paths.tasksDir(code), '1.json'), null);
    const done1 = (t1 && t1.status === 'completed') || (t1live && t1live.status === 'completed');
    det('The orch completes task 1 (the gate allows it while closing)', done1, `task 1: ${t1 ? t1.status : t1live ? t1live.status : 'no file'} (S10 copy) ${t1live ? `/ ${t1live.status} (live)` : ''}`);
    const ag = x.st('S10', 'last', 'agents.json', null);
    const running = ag && ag.find(y => y.id === job || y.sessionId === orchSid);
    det('The orch is stopped: claude agents no longer lists it', members.orch && members.orch.stopped_at && ag && !running,
      `members.json orch.stopped_at ${members.orch && members.orch.stopped_at}; claude agents --json at the last S10 snap ${ag ? (running ? `still lists ${running.id} (${running.state})` : `has no ${job}`) : 'not saved'}`);
    // the mirror is written by the first task entry (S6): a run without one has no tasks.json to keep, so no check
    const taskEntries = log.filter(e => e.kind === 'task').length;
    const tj = readJson(path.join(roomDir, 'tasks.json'), null);
    if (taskEntries) det('<room>/tasks.json stays', Array.isArray(tj), tj ? `${tj.length} task(s) kept (${taskEntries} task entries in the log)` : `missing (${taskEntries} task entries in the log)`);
    const ln = /^\s*(⏺ )?(sub-human: )?alice left\s*$/m.exec(readText(x.stateFile('S10', 'notice-bob.txt')) || '');
    const via = la && x.shownVia('bob', la.id);
    const early = la && lb && Date.parse(lb.at) - Date.parse(la.at) < 8000;
    det('bob sees the chat line "alice left" once the leave settled (8 s)', ln && via === 'mod' && !early,
      `${ln ? `"${ln[0]}" in bob's pane (state/S10/notice-bob.txt)` : 'not seen in bob\'s pane'}; rows/notices-bob.json: #${la ? la.id : '?'} shown via ${via || 'nothing'}; bob left ${la && lb ? ((Date.parse(lb.at) - Date.parse(la.at)) / 1000).toFixed(1) : '?'} s after alice`);

    // every human saw a join/leave notice
    const moves = log.filter(e => (e.kind === 'member_joined' || e.kind === 'member_left') && e.via === 'system' && e.from !== 'orch');
    const per = ['alice', 'bob'].map(n => {
      const rec = readJson(path.join(roomDir, 'rows', `notices-${n}.json`), {});
      const lg = Array.isArray(rec.log) ? rec.log : [];
      const items = lg.map(y => { const e = log.find(z => z.id === y.id); return `#${y.id} ${e ? `${e.from} ${e.kind === 'member_left' ? 'left' : 'joined'}` : '?'} via ${y.via}`; });
      return { n, lg, items };
    });
    det('Each human saw a join/leave notice (rows/notices-NAME.json: what was shown, and how)', per.every(p => p.lg.length > 0),
      per.map(p => `${p.n}: ${p.items.join(', ') || 'none'}`).join('; ') + `; ${moves.length} joins/leaves of members in the log`);

    // no entry ids in what people see: the members' panes outside the agent panel
    const hits = [];
    const memberCaps = index.filter(r => r.session === 'sh-alice' || r.session === 'sh-bob');
    for (const r of memberCaps) {
      const lines = (readText(path.join(screens, r.txt)) || '').split('\n');
      const end = lines.findIndex(l => MAIN_ROW.test(l));
      for (const l of end < 0 ? lines : lines.slice(0, end)) {
        if (/(^|[\s(])#\d+\b/.test(l) && !/\btasks?\b|◼/.test(l)) hits.push(`${r.txt}: ${clip(l, 90)}`);
      }
    }
    det('No room entry ids (#N) in the members\' panes (task numbers aside)', hits.length === 0, hits.length ? `${hits.length} line(s): ${hits.slice(0, 4).join(' | ')}` : `none in ${memberCaps.length} captures`);
  },
};
