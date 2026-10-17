// S6: shared tasks, applied by the host at once: add, claim, a refused non-owner done (the tool's own reply), the
// owner's done; the room session's native task list follows the log
import { panelRows } from '../lib/panes.ts';
import { clip } from '../lib/io.ts';
import type { Ctx, Det } from './context.ts';
import type { TaskRec } from './captures.ts';
import type { Thresholds } from '../metrics.ts';

export const scene = 'S6';

/** A transcript content block, as far as a tool_result's is read. */
const isBlock = (c: unknown): c is { type?: string; content?: unknown } => typeof c === 'object' && c !== null;
/** The text of every tool_result in a seat's transcript entries (what a tool answered its Claude). */
const results = (es: { message?: { content?: unknown } }[]): string[] => es.flatMap(e => {
  const content = e.message ? e.message.content : undefined;
  const blocks = Array.isArray(content) ? content.filter(isBlock) : [];
  return blocks.filter(c => c && c.type === 'tool_result').map(c => (typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '')));
});

export function run(x: Ctx, { det }: { det: Det }, _T: Thresholds): void {
  const { code, log } = x;
  const s = x.span('S6');
  const inS6 = log.filter(e => !s || e.at > s.from);
  const reqA = inS6.find(e => e.kind === 'task_req' && e.from === 'alice' && e.op === 'add');
  det('alice\'s Claude calls task (add): a task_req via=agent', reqA && reqA.via === 'agent', x.fmt(reqA));
  // every request the host took is answered by its task entry (via system, from room) at once, under the same lock
  const late = inS6.filter(e => e.kind === 'task_req').filter(r => {
    const t = log.find(e => e.kind === 'task' && e.req === r.id);
    return !t || t.from !== 'room' || t.via !== 'system' || Date.parse(t.at) - Date.parse(r.at) > 2000;
  });
  det('Every task request is followed by its task entry (via system, from room) within 2 s: applied by the host, no model', inS6.some(e => e.kind === 'task_req') && !late.length,
    late.length ? `unanswered or late: ${late.map(r => x.fmt(r)).join('; ')}` : `${inS6.filter(e => e.kind === 'task_req').length} request(s), each answered at once`);
  const l1 = x.st<TaskRec[]>('S6', 1, 'tasks.json', []);
  const t = l1.find(y => y.owner === 'alice' && y.status === 'in_progress');
  det('alice\'s claim: tasks.json has it, owner alice, in_progress', !!t, t ? `#${t.id} "${t.subject}" ${t.status} ${t.owner} (state/S6/1/tasks.json)` : `tasks.json at S6 step 1: ${JSON.stringify(l1)}`);
  const native = x.nativeTasks('S6', 1).filter(n => n.owner !== 'room');
  const same = native.length === l1.length && l1.every(y => native.some(n => String(n.id) === String(y.id) && n.status === y.status && (n.owner ?? null) === (y.owner ?? null)));
  det('The room session\'s native task list equals the fold (the plugin projects the log)', same,
    `native ${native.map(n => `#${n.id} ${n.status} ${n.owner ?? '-'}`).join(', ') || 'none'}; tasks.json ${l1.map(y => `#${y.id} ${y.status} ${y.owner ?? '-'}`).join(', ') || 'none'}`);
  const tid = t && t.id;
  const ar = panelRows(x.cap('S6', 'alice', 1)).find(r => r.label === code);
  det('alice\'s room row shows the task summary', !!(ar && /tasks? \d+ open|#\d+ you/.test(ar.text)), ar ? ar.line : 'no room row');
  const cli = x.stText('S6', 1, 'sub-human-tasks.txt') || '';
  det('`sub-human tasks` lists it', !!tid && new RegExp(`#${tid}\\b.*in progress.*alice`).test(cli), clip(cli, 200) || 'no output saved');
  // bob's done on alice's task: the tool refuses it at once, logs nothing, and the task stays in progress
  const said = results(x.inSpan(x.entries('bob'), s)).find(r => /refused: only alice may complete/.test(r));
  const logged = inS6.some(e => e.kind === 'task_req' && e.from === 'bob' && e.op === 'done');
  const t2 = x.st<TaskRec[]>('S6', 2, 'tasks.json', []).find(y => String(y.id) === String(tid));
  det('A non-owner done (bob on alice\'s task) is refused by the tool itself: "only alice may complete"; nothing logged; the task stays in progress',
    !!said && !logged && t2 && t2.status === 'in_progress', `${said ? `bob's tool result: "${clip(said, 120)}"` : 'no refusal in bob\'s transcript'}; a task_req from bob: ${logged}; #${tid} ${t2 ? t2.status : '?'} (state/S6/2)`);
  const reqA2 = inS6.find(e => e.kind === 'task_req' && e.from === 'alice' && e.op === 'done');
  const done = reqA2 && log.find(e => e.kind === 'task' && e.op === 'done' && String(e.task_id) === String(tid) && e.req === reqA2.id);
  const l3 = x.st<TaskRec[]>('S6', 3, 'tasks.json', []);
  det('The owner\'s done with evidence completes it; the task entry cites her request', done && l3.find(y => String(y.id) === String(tid))?.status === 'completed',
    `${x.fmt(reqA2)} evidence "${reqA2 ? reqA2.evidence : ''}"; ${x.fmt(done)}`);
}
