// S6b (--film): the agreed plan built, real code on both sides. Two room tasks: A (tristan) the store side (listTasks in
// src/store.js + test/store-paging.test.js), B (jess) the HTTP side (GET /tasks in src/server.js +
// test/server-paging.test.js). Each Claude builds its half in its own checkout of one repo; A's Claude pushes and tells
// B's, and only then does B's Claude pull, run npm test and push; then both people pull and run npm test. Evidence: the
// room log, tasks.json, B's transcript (the handoff message) and what demo.sh saved in state/S6b (task ids, each
// checkout's git log, reflog and HEAD, the origin's HEAD, the driver's own npm test run per checkout, both panes after the
// people's own run, and B's pane when B's Claude's subagent showed).
// The film's agent-panel beats are checked here too (S6b runs only in --film): state/S2/panel-NAME.txt, each person's
// pane with the room row opened.
import path from 'node:path';
import { readJson, readText, clip } from '../lib/io.ts';
import { roomRowMembers, subagentRows } from '../lib/panes.ts';
import type { Ctx, Det } from './context.ts';
import type { TaskRec } from './captures.ts';

/** Each person's half: the files their commits may change, all of which they must change (code and its own tests). */
export const LANES: { seat: 'A' | 'B', what: string, files: string[] }[] = [
  { seat: 'A', what: 'the store side', files: ['src/store.js', 'test/store-paging.test.js'] },
  { seat: 'B', what: 'the HTTP side', files: ['src/server.js', 'test/server-paging.test.js'] },
];

/** `git log --format='commit %H %an%n%s' --name-only` -> [{sha, author, subject, files}] */
/** A commit of `git log --name-only`. */
export interface Commit { sha: string, author: string, subject: string | null, files: string[] }

export function parseGitLog(text: string | null | undefined): Commit[] {
  const out: Commit[] = [];
  for (const l of String(text || '').split('\n')) {
    const m = /^commit ([0-9a-f]{7,40}) (.*)$/.exec(l);
    if (m) { out.push({ sha: m[1], author: m[2], subject: null, files: [] }); continue; }
    const c = out.at(-1);
    if (!c || !l.trim()) continue;
    if (c.subject == null) c.subject = l; else c.files.push(l.trim());
  }
  return out;
}

/** `git log -g --date=iso-strict --format='%gd %gs'` (newest first) -> [{at, msg}] oldest first. */
export function parseReflog(text: string | null | undefined): { at: string, msg: string }[] {
  return String(text || '').split('\n').map(l => /^\S+@\{([^}]+)\} (.*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m)
    .map(m => ({ at: m[1], msg: m[2] })).reverse();
}

/** The first time a checkout took commits from the origin (a pull, or a fetch's merge or rebase), or null. */
export const firstPull = (reflog: string | null | undefined): { at: string, msg: string } | null => parseReflog(reflog).find(r => /^(pull|merge|rebase)\b/.test(r.msg)) || null;

/** The summary of a node --test run (spec: ℹ tests 6, or tap: # tests 6): {tests, pass, fail, exit} (null fields when missing). */
export function tapSummary(text: string | null | undefined): { tests: number | null, pass: number | null, fail: number | null, exit: number | null } {
  const n = (k: string): number | null => { const m = new RegExp(`^[ℹ#] ${k} (\\d+)`, 'm').exec(text || ''); return m ? +m[1] : null; };
  const e = /^exit (\d+)/m.exec(text || '');
  return { tests: n('tests'), pass: n('pass'), fail: n('fail'), exit: e ? +e[1] : null };
}

/**
 * The last node --test summary shown in a pane (the people's own run is the last one: the pane is saved right after
 * it), as demo.sh's PASS6b reads it: {pass, fail, text} from "ℹ pass N / ℹ fail M / … / ℹ duration_ms D", or null.
 */
export function lastSummary(pane: string | null | undefined): { pass: number, fail: number, text: string } | null {
  const re = /[ℹ#] pass (\d+)\s*\n\s*(?:⎿\s*)?[ℹ#] fail (\d+)\s*\n(?:\s*[ℹ#] [a-z]+ \d+\s*\n){0,4}\s*[ℹ#] duration_ms [\d.]+/g;
  const m = [...String(pane || '').matchAll(re)].at(-1);
  return m ? { pass: +m[1], fail: +m[2], text: m[0].split('\n').map(l => l.trim()).join(' / ') } : null;
}

export const scene = 'S6b';

export function run(x: Ctx, { det }: { det: Det }): void {
  const { log, roomDir, code, A, B } = x;
  const name: Record<'A' | 'B', string> = { A, B };
  const f = (...p: string[]): string => x.stateFile('S6b', ...p);
  // S2 (film): each person opens the room row in their agent panel, and the other shows inside it
  for (const [who, other] of [[A, B], [B, A]]) {
    const rm = roomRowMembers(readText(x.stateFile('S2', `panel-${who}.txt`)), code);
    det(`${who} opens the ${code} row in the agent panel: ${other} shows inside it`, rm && rm.members.includes(other),
      rm ? `${rm.room.line} | ${rm.members.map(n => `└ ${n}`).join(' | ') || 'no member rows'} (state/S2/panel-${who}.txt)` : `no ${code} row in state/S2/panel-${who}.txt`);
  }
  const sub = subagentRows(readText(f(`panel-subagent-${B}.txt`)), code);
  det(`${B}'s Claude runs a subagent of its own: its row shows in ${B}'s panel beside the room row`, sub.length > 0,
    sub.length ? `${sub.map(r => r.line).join(' | ')} (state/S6b/panel-subagent-${B}.txt)` : `no subagent row saved (state/S6b/panel-subagent-${B}.txt)`);
  const [h, t] = (readText(f('tasks.txt')) || '').trim().split(/\s+/);
  const tasks = readJson<TaskRec[] | null>(path.join(roomDir, 'tasks.json'), []) || [];
  const th = tasks.find(y => String(y.id) === h), tt = tasks.find(y => String(y.id) === t);
  det(`The plan is split in two room tasks: the store for ${A}, the HTTP handler for ${B}`, th && tt && th.owner === A && tt.owner === B,
    h ? `#${h} ${th ? `"${th.subject}" ${th.owner} ${th.status}` : 'not in tasks.json'}; #${t} ${tt ? `"${tt.subject}" ${tt.owner} ${tt.status}` : 'not in tasks.json'}` : 'no state/S6b/tasks.txt');
  for (const [id, who] of [[h, A], [t, B]]) {
    const claim = log.find(e => e.kind === 'task_req' && e.op === 'claim' && e.from === who && String(e.task_id) === id);
    const done = log.filter(e => e.kind === 'task_req' && e.op === 'done' && e.from === who && String(e.task_id) === id).at(-1);
    const applied = done && log.find(e => e.kind === 'task' && e.status === 'completed' && String(e.task_id) === id && e.id > done.id);
    det(`${who}'s Claude claims #${id || '?'} and completes it on its own done request, with evidence`, claim && done && done.via === 'agent' && String(done.evidence || '').trim() && applied,
      `claim ${x.fmt(claim)}; done ${x.fmt(done)} evidence "${clip(done && done.evidence, 80)}"; applied ${x.fmt(applied)}`);
  }
  // the history both checkouts end at (checked equal below)
  const commits = parseGitLog(readText(f(`git-log-${A}.txt`)));
  for (const lane of LANES) {
    const who = name[lane.seat];
    const mine = commits.filter(c => c.author === who);
    const touched = new Set(mine.flatMap(c => c.files));
    const out = [...touched].filter(p => !lane.files.includes(p));
    const missing = lane.files.filter(p => !touched.has(p));
    det(`${who}'s Claude writes ${lane.what}: its commits change ${lane.files.join(' and ')}, and nothing else`, mine.length > 0 && out.length === 0 && missing.length === 0,
      `${mine.length} commit(s) by ${who}: ${mine.map(c => `${c.sha.slice(0, 7)} "${clip(c.subject, 50)}" [${c.files.join(' ')}]`).join('; ') || 'none'}${out.length ? `; outside the lane: ${out.join(' ')}` : ''}${missing.length ? `; not changed: ${missing.join(' ')}` : ''}`);
  }
  const heads = [A, B, 'origin'].map(n => (readText(f(`head-${n}.txt`)) || '').trim());
  det('Both checkouts end at the origin\'s commit (each pulled the other\'s half)', heads.every(s => /^[0-9a-f]{40}$/.test(s)) && new Set(heads).size === 1,
    `${A} ${heads[0].slice(0, 7) || '?'}, ${B} ${heads[1].slice(0, 7) || '?'}, origin ${heads[2].slice(0, 7) || '?'}`);
  // the handoff: A's Claude tells B's that the store is pushed, and B's checkout pulls only after that
  const pull = firstPull(readText(f(`reflog-${B}.txt`)));
  const said = x.peerIn(x.inSpan(x.entries(B), x.span('S6b')), A)
    .map(e => ({ at: e.timestamp, text: x.textOf(e.message && e.message.content) || String((e.origin && e.origin.body) || '') }))
    .filter(m => /push/i.test(m.text)).sort((a, b) => (a.at < b.at ? -1 : 1))[0];
  det(`The handoff: ${A}'s Claude tells ${B}'s Claude the store is pushed before ${B}'s checkout pulls it`, said && pull && Date.parse(said.at) < Date.parse(pull.at),
    `${said ? `peer message from ${A} at ${said.at.slice(11, 19)}: "${clip(said.text, 70)}"` : `no peer message from ${A} about a push in ${B}'s transcript during S6b`}; ${pull ? `${B}'s first pull ${pull.at} (${pull.msg})` : `no pull in state/S6b/reflog-${B}.txt`}`);
  for (const who of [A, B]) {
    const s = tapSummary(readText(f(`npm-test-${who}.txt`)));
    det(`npm test passes in ${who}'s checkout, with both halves' tests (the driver's own run)`, s.exit === 0 && s.fail === 0 && s.pass === s.tests && (s.tests ?? 0) > 2,
      `state/S6b/npm-test-${who}.txt: tests ${s.tests}, pass ${s.pass}, fail ${s.fail}, exit ${s.exit}`);
    const ls = lastSummary(readText(f(`pane-${who}.txt`)));
    det(`${who}'s pane shows ${who}'s own npm test passing`, ls && ls.pass > 0 && ls.fail === 0,
      ls ? clip(ls.text, 160) : `no npm test summary in state/S6b/pane-${who}.txt`);
  }
}
