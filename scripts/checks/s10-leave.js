'use strict';
// S10: leave: both exit, the reaper completes task 1 and stops the room's Claude; plus run-wide notice and id checks
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const paths = require('../lib/paths.js');
const { MAIN_ROW } = require('../lib/panes.js');
const { readJson, readText, clip, esc } = require('../lib/io.js');

module.exports = {
  scene: 'S10',
  run(x, { det }) {
    const { code, log, members, job, roomClaudeSid, roomDir, index, screens, A, B } = x;
    const s = x.span('S10');
    const la = x.logIn(s).find(e => e.kind === 'member_left' && e.from === A), lb = x.logIn(s).find(e => e.kind === 'member_left' && e.from === B);
    det(`Both leave: member_left ${A} and ${B}`, la && lb, `${x.fmt(la)}; ${x.fmt(lb)}`);
    const cl = log.find(e => e.kind === 'status' && e.to === 'claude' && e.via === 'system' && /room closed/.test(e.text));
    det('The reaper marks the room closing and tells the room\'s Claude "room closed: complete task 1"', cl && members.claude && members.claude.closing, `${x.fmt(cl)}; members.json claude.closing ${members.claude && members.claude.closing}`);
    const t1 = x.nativeTasks('S10', 'last').find(t => t.id === '1');
    const t1live = readJson(path.join(paths.tasksDir(code), '1.json'), null);
    const done1 = (t1 && t1.status === 'completed') || (t1live && t1live.status === 'completed');
    det('The room\'s Claude completes task 1 (the gate allows it while closing)', done1, `task 1: ${t1 ? t1.status : t1live ? t1live.status : 'no file'} (S10 copy) ${t1live ? `/ ${t1live.status} (live)` : ''}`);
    const ag = x.st('S10', 'last', 'agents.json', null);
    const running = ag && ag.find(y => y.id === job || y.sessionId === roomClaudeSid);
    det('The room\'s Claude is stopped: claude agents no longer lists it', members.claude && members.claude.stopped_at && ag && !running,
      `members.json claude.stopped_at ${members.claude && members.claude.stopped_at}; claude agents --json at the last S10 snap ${ag ? (running ? `still lists ${running.id} (${running.state})` : `has no ${job}`) : 'not saved'}`);
    // the mirror is written by the first task entry (S6): a run without one has no tasks.json to keep, so no check
    const taskEntries = log.filter(e => e.kind === 'task').length;
    const tj = readJson(path.join(roomDir, 'tasks.json'), null);
    if (taskEntries) det('<room>/tasks.json stays', Array.isArray(tj), tj ? `${tj.length} task(s) kept (${taskEntries} task entries in the log)` : `missing (${taskEntries} task entries in the log)`);
    const ln = new RegExp(`^\\s*(⏺ )?(sub-human: )?${esc(A)} left\\s*$`, 'm').exec(readText(x.stateFile('S10', `notice-${B}.txt`)) || '');
    const via = la && x.shownVia(B, la.id);
    const early = la && lb && Date.parse(lb.at) - Date.parse(la.at) < 8000;
    det(`${B} sees the chat line "${A} left" once the leave settled (8 s)`, ln && via === 'mod' && !early,
      `${ln ? `"${ln[0]}" in ${B}'s pane (state/S10/notice-${B}.txt)` : `not seen in ${B}'s pane`}; rows/notices-${B}.json: #${la ? la.id : '?'} shown via ${via || 'nothing'}; ${B} left ${la && lb ? ((Date.parse(lb.at) - Date.parse(la.at)) / 1000).toFixed(1) : '?'} s after ${A}`);

    // every human saw a join/leave notice
    const moves = log.filter(e => (e.kind === 'member_joined' || e.kind === 'member_left') && e.via === 'system' && e.from !== 'claude');
    const per = [A, B].map(n => {
      const rec = readJson(path.join(x.rowsDir(n), `notices-${n}.json`), {});
      const lg = Array.isArray(rec.log) ? rec.log : [];
      const items = lg.map(y => { const e = log.find(z => z.id === y.id); return `#${y.id} ${e ? `${e.from} ${e.kind === 'member_left' ? 'left' : 'joined'}` : '?'} via ${y.via}`; });
      return { n, lg, items };
    });
    det('Each human saw a join/leave notice (rows/notices-NAME.json: what was shown, and how)', per.every(p => p.lg.length > 0),
      per.map(p => `${p.n}: ${p.items.join(', ') || 'none'}`).join('; ') + `; ${moves.length} joins/leaves of members in the log`);

    // no entry ids in what people see: the members' panes outside the agent panel. A room task's number (#3) is no
    // entry id: a line that names only task numbers is fine, whatever its wording ("#3, which she's now working on")
    const hits = [];
    const taskIds = new Set([...(Array.isArray(tj) ? tj.map(t => String(t.id)) : []), ...log.filter(e => e.kind === 'task' && e.task_id != null).map(e => String(e.task_id))]);
    const memberCaps = index.filter(r => r.session === `sh-${A}` || r.session === `sh-${B}`);
    for (const r of memberCaps) {
      const lines = (readText(path.join(screens, r.txt)) || '').split('\n');
      const end = lines.findIndex(l => MAIN_ROW.test(l));
      for (const l of end < 0 ? lines : lines.slice(0, end)) {
        const ns = [...l.matchAll(/(?:^|[\s(])#(\d+)\b/g)].map(m => m[1]);
        if (ns.length && !ns.every(n => taskIds.has(n)) && !/\btasks?\b|◼|\b(claim(ed|s)?|done|complete[sd]?)\b/i.test(l)) hits.push(`${r.txt}: ${clip(l, 90)}`);
      }
    }
    det('No room entry ids (#N) in the members\' panes (task numbers aside)', hits.length === 0, hits.length ? `${hits.length} line(s): ${hits.slice(0, 4).join(' | ')}` : `none in ${memberCaps.length} captures`);

    // --film: B's machine reached the room over ssh to a private sshd (scripts/devbox.sh): it stops after S10
    if (x.remote && x.remote[B]) {
      const devbox = path.join(path.dirname(path.dirname(x.remote[B])), 'devbox');
      const cfg = path.join(devbox, 'sshd_config');
      const ps = spawnSync('pgrep', ['-f', `sshd -D -e -f ${cfg}`], { encoding: 'utf8' });
      const pids = (ps.stdout || '').trim().split('\n').filter(Boolean);
      const pidFile = readText(path.join(devbox, 'sshd.pid'));
      det('The private sshd (devbox) stopped after the room closed: no process serves its config', pids.length === 0 && !pidFile,
        `${pids.length ? `still running: pid ${pids.join(', ')}` : 'no sshd for ' + cfg}; sshd.pid ${pidFile ? `still there (${pidFile.trim()})` : 'gone'}`);
    }
  },
};
