// S1: A (alice; --film: tristan) joins, no room open: the room is created and the headless room Claude spawned
import fs from 'node:fs';
import path from 'node:path';
import { panelRows, joinNotices } from '../lib/panes.ts';
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
  const want = new RegExp(`^⏺ sub-human: opened room ${code} as ${A} · on this machine others join with /sub-human`);
  det(`${A}'s join shows one line, "sub-human: opened room CODE as ${A} · …", and no "blocked by hook" frame`, jn.notices.length === 1 && want.test(jn.notices[0] ?? '') && !jn.frame,
    `${jn.notices.length} join line(s)${jn.notices.length ? `: ${jn.notices.map(l => `"${l}"`).join('; ')}` : ''}; hook frame ${jn.frame ? `"${jn.frame}"` : 'none'} in ${x.capName('S1', A)}`);
  const ar = panelRows(x.cap('S1', A));
  det(`${A}'s panel: one ${code} row`, ar.filter(r => !r.nested).length === 1 && ar[0]?.label === code, ar.map(r => r.line).join(' | ') || 'no rows');
  const orr = panelRows(oc);
  const holds = x.holdsAt('S1', 1, 'claude');
  det(`The room's Claude's panel lists ${A}`, orr.some(r => r.label === A) && (holds.members || []).includes(A),
    `claude rows: ${orr.map(r => r.line).join(' | ') || 'none'}; claude's holds (its session document) members ${JSON.stringify(holds.members || [])}`);
  const t1 = x.nativeTasks('S1', 1).find(t => t.id === '1');
  det(`Room task #1 "room ${code} open" on the room Claude's native list (in_progress, owner room)`, t1 && t1.subject === `room ${code} open` && t1.status === 'in_progress' && t1.owner === 'room',
    t1 ? `~/.claude/tasks/sh-${code}/1.json: "${t1.subject}" ${t1.status} owner ${t1.owner}` : 'no 1.json in the S1 copy of the native list');
  const j = x.entries(A).filter(e => e.attachment && e.attachment.type === 'hook_additional_context' && e.attachment.hookEvent === 'UserPromptExpansion').map(e => [e.attachment?.content].flat().join('\n'))[0] || '';
  const fillLen = (j.split('\n\nROWS\n')[0] ?? '').length;
  det(`Member join block small: text ≤ ${T.joinText} chars, with ROWS ≤ ${T.joinBlock.toLocaleString('en-US')}`, j && fillLen <= T.joinText && j.length <= T.joinBlock,
    `${A}'s join additionalContext ${j.length} chars (mechanics text ${fillLen}, ROWS ${j.length - fillLen})`);
}
