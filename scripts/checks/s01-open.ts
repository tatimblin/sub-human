// S1: A (alice; --film: tristan) joins, no room open: the room is created and the headless room Claude spawned
import fs from 'node:fs';
import path from 'node:path';
import { panelRows, joinNotices, oneRoomRow } from '../lib/panes.ts';
import { clip } from '../lib/io.ts';
import { isRoomRow, isKeeper, rowHeld, rowStrays } from './transcripts.ts';
import type { Ctx, Det } from './context.ts';
import type { AgentRow } from './captures.ts';
import type { Thresholds } from '../metrics.ts';

export const scene = 'S1';

export function run(x: Ctx, { det }: { det: Det }, T: Thresholds): void {
  const { code, roomDir, members, job, roomClaudeSid, A } = x;
  const ms = x.st('S1', 1, 'members.json', members);
  det(`Room created: log, members.json with ${A} (member) and the room's Claude (job id)`, fs.existsSync(path.join(roomDir, 'log.jsonl')) && ms[A] && ms[A].role === 'member' && ms.claude && ms.claude.job,
    `${roomDir}: ${A} ${ms[A] ? ms[A].role : 'missing'}, claude job ${ms.claude ? ms.claude.job : 'missing'}`);
  const ag = x.st<AgentRow[]>('S1', 1, 'agents.json', []);
  const a = ag.find(r => r.id === job || r.sessionId === roomClaudeSid);
  det(`The room's Claude is a background job titled claude.${code} (claude agents --json), not a tmux seat`, a && a.kind === 'background' && a.name === `claude.${code}`,
    a ? `id ${a.id} kind ${a.kind} name ${a.name} state ${a.state} cwd ${a.cwd}` : `no agent with id ${job} in state/S1/1/agents.json`);
  const oc = x.cap('S1', 'claude') || '';
  det('The room\'s Claude bound itself as claude of the room (agent sub-human:room-claude, pid, session id)', ms.claude && ms.claude.role === 'claude' && ms.claude.pid && ms.claude.session_id && /@sub-human:room-claude/.test(oc),
    `members.json claude role=${ms.claude && ms.claude.role} pid=${ms.claude && ms.claude.pid}; "${(/UserPromptExpansion says: [^\n]*/.exec(oc) || ['no join line'])[0]}" in ${x.capName('S1', 'claude')} (claude logs ${job})`);
  // since 0.5.0-beta.7 a join that works shows one dim notice from the hooks module (command.run), no hook frame
  const jn = joinNotices(x.cap('S1', A));
  const want = new RegExp(`^⏺ sub-human: Opened ${code} as ${A}$`);
  det(`${A}'s join shows one line, "sub-human: Opened CODE as ${A}", and no "blocked by hook" frame`, jn.notices.length === 1 && want.test(jn.notices[0] ?? '') && !jn.frame,
    `${jn.notices.length} join line(s)${jn.notices.length ? `: ${jn.notices.map(l => `"${l}"`).join('; ')}` : ''}; hook frame ${jn.frame ? `"${jn.frame}"` : 'none'} in ${x.capName('S1', A)}`);
  const ar = panelRows(x.cap('S1', A));
  const one = oneRoomRow(ar, code);
  det(`${A}'s panel: one ${code} row, its only nested row its keeper`, one.ok && ar.filter(r => !r.nested).length === 1 && ar[0]?.label === code, `${ar.map(r => r.line).join(' | ') || 'no rows'} (${one.why})`);
  const orr = panelRows(oc);
  det('The room\'s Claude keeps no rows (each member\'s one room row is that member\'s hooks module\'s)', orr.length === 0,
    `claude rows: ${orr.map(r => r.line).join(' | ') || 'none'}`);
  // the row is the hooks module's (agents/room.md, spawned with $.agent.spawn): a room row in A's session holding this
  // room (room-chat on: through its keeper child, agents/keeper.md; off: its own hold), nothing else nested in it, no
  // participant row; the room session spawns no agent at all
  const s1 = x.span('S1');
  const mine = x.seatAgents(A).filter(s => s.session !== roomClaudeSid && !!s1 && s.first > s1.from && s.first <= s1.to);
  const rows = mine.filter(s => isRoomRow(s, code));
  const strays = rowStrays(mine, code);
  det(`${A}'s one room row is the hooks module's: a sub-human:room agent holding ${code} in ${A}'s session (itself, or its keeper), nothing else nested, no participant row`,
    rows.length === 1 && !!rows[0] && rowHeld(mine, rows[0], code) && strays.length === 0 && !mine.some(s => s.agentType === 'sub-human:participant'),
    mine.map(s => `${s.agentType || '?'}${isKeeper(s, code) ? ` (of ${s.parent || '?'})` : ''} "${clip(s.prompt, 30)}" holds ${s.holds.map(h => `${h.room}${h.result === null ? ' (blocking)' : ''}`).join(',') || 'none'}`).join('; ') || 'no subagent in S1');
  const own = x.seatAgents('claude');
  det('The room session spawns no agent (no rows, no participants)', own.length === 0, own.map(s => `${s.agentType || '?'} ${s.file}`).join('; ') || 'none');
  // on disk at S1's snap (state/S1/1/tasks-dir.txt): the reaper deletes the folder when a run's S10 closes the room
  // (lib/room/task-files.ts remove), so the live folder says nothing after a run that closed it
  const dir = ms.claude && ms.claude.tasks_dir;
  const atS1 = x.stText('S1', 1, 'tasks-dir.txt');
  const there = atS1 !== null ? /^exists$/m.test(atS1) : !!dir && fs.existsSync(dir);
  const now = !!dir && fs.existsSync(dir);
  det(`The room session's task list directory is made before it starts and recorded (members.json claude.tasks_dir ends tasks/sh-${code})`, !!dir && dir.endsWith(`/tasks/sh-${code}`) && there,
    `claude.tasks_dir ${dir || 'missing'}${dir ? (atS1 !== null ? ` (at S1: ${there ? `exists, holding ${atS1.split('\n').slice(1).filter(Boolean).join(', ') || 'nothing'}` : 'missing'}; now ${now ? 'exists' : 'gone'})` : (now ? ' (exists)' : ' (missing on disk; no state/S1/1/tasks-dir.txt)')) : ''}`);
  // the room session calls nothing: its one turn ends with "ok" (no rows, no room tool, no plan)
  const calls = x.toolUses(x.inSpan(x.entries('claude'), x.span('S1'))).map(c => c.name);
  det('The room session calls nothing (no rows, no room tool)', calls.length === 0,
    `${calls.length} call(s): ${[...new Set(calls)].join(', ') || 'none'}`);
  // this run's join (S1's span: the seat's folder keeps earlier runs' transcripts too). The row's fallback ask (auto mode
  // refused the module's spawn: mod/core/rows.ts rowAsk, held into the join's expansion) rides in the same block; it is
  // not the mechanics text, so it counts toward the whole block only
  const j = x.inSpan(x.entries(A), s1).filter(e => e.attachment && e.attachment.type === 'hook_additional_context' && e.attachment.hookEvent === 'UserPromptExpansion').map(e => [e.attachment?.content].flat().join('\n'))[0] || '';
  const ASK = /\n*SUB-HUMAN: this session's room row could not start by itself\.[^\n]*/;
  const askLen = (ASK.exec(j)?.[0] ?? '').length;
  const fillLen = (j.replace(ASK, '').split('\n\nROWS\n')[0] ?? '').length;
  det(`Member join block small: text ≤ ${T.joinText} chars, with ROWS ≤ ${T.joinBlock.toLocaleString('en-US')}`, j && fillLen <= T.joinText && j.length <= T.joinBlock,
    `${A}'s join additionalContext ${j.length} chars (mechanics text ${fillLen}, ROWS ${j.length - fillLen - askLen}${askLen ? `, the row's fallback ask ${askLen}` : ''})`);
}
