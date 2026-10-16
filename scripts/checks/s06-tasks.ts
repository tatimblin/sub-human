// S6: shared tasks: add, claim, a refused non-owner done, the owner's done
import { panelRows } from '../lib/panes.ts';
import { readJson, clip } from '../lib/io.ts';
import type { Ctx, Det, Beh } from './context.ts';
import type { TaskRec } from './captures.ts';
import type { Thresholds } from '../metrics.ts';

export const scene = 'S6';

export function run(x: Ctx, { det, beh }: { det: Det, beh: Beh }, T: Thresholds): void {
  const { code, log } = x;
  const s = x.span('S6');
  const reqA = log.find(e => e.kind === 'task_req' && e.from === 'alice' && (e.op === 'add' || e.op === 'claim') && e.at > (s ? s.from : ''));
  det('alice\'s Claude calls task (add/claim): a task_req via=agent', reqA && reqA.via === 'agent', x.fmt(reqA));
  const l1 = x.st<TaskRec[]>('S6', 1, 'tasks.json', []);
  const t = l1.find(y => y.owner === 'alice' && y.status === 'in_progress');
  det('The room\'s Claude applies it natively: tasks.json has it, owner alice, in_progress', !!t, t ? `#${t.id} "${t.subject}" ${t.status} ${t.owner} (state/S6/1/tasks.json)` : `tasks.json at S6 step 1: ${JSON.stringify(l1)}`);
  const tc = x.toolUses(x.inSpan(x.entries('claude'), s), '^Task(Create|Update)$');
  det('The room\'s Claude used native TaskCreate/TaskUpdate', tc.some(c => c.name === 'TaskCreate') && tc.some(c => c.name === 'TaskUpdate'), tc.map(c => `${c.name}(${clip(JSON.stringify(c.input), 70)})`).slice(0, 4).join('; ') || 'none');
  const tid = t && t.id;
  const ar = panelRows(x.cap('S6', 'alice', 1)).find(r => r.label === code);
  det('alice\'s room row shows the task summary', !!(ar && /tasks? \d+ open|#\d+ you/.test(ar.text)), ar ? ar.line : 'no room row');
  const cli = x.stText('S6', 1, 'sub-human-tasks.txt') || '';
  det('`sub-human tasks` lists it', !!tid && new RegExp(`#${tid}\\b.*in_progress.*alice`).test(cli), clip(cli, 200) || 'no output saved');
  const reqB = log.find(e => e.kind === 'task_req' && e.from === 'bob' && e.op === 'done' && String(e.task_id || e.id_) === String(tid));
  const reqB2 = reqB || log.find(e => e.kind === 'task_req' && e.from === 'bob' && e.op === 'done');
  const l2 = x.st<TaskRec[]>('S6', 2, 'tasks.json', []);
  const t2 = l2.find(y => String(y.id) === String(tid));
  const gate = readJson<{ status?: number, stderr?: string } | null>(x.stateFile('S6', 'gate-bob.json'), null);
  const liveGate = (() => {
    const es = x.inSpan(x.entries('claude'), s).filter(e => reqB2 && e.timestamp !== undefined && e.timestamp > reqB2.at);
    const hit = es.find(e => /TaskCompleted hook|only alice may complete/.test(JSON.stringify(e.message || e.attachment || '')));
    return hit ? 'the live gate refused the room\'s Claude\'s TaskUpdate' : 'the room\'s Claude did not attempt it (no completing TaskUpdate after bob\'s request)';
  })();
  const synthetic = !/live gate/.test(liveGate);
  det(`A non-owner done (bob on alice's task) is refused: the gate says only alice may complete it; the task stays in progress${synthetic ? ' [gate: SYNTHETIC — run by demo-lib over the real log; the room\'s Claude itself declined before reaching it]' : ' [gate: live]'}`,
    reqB2 && t2 && t2.status === 'in_progress' && gate && gate.status === 2 && /only alice may complete/.test(String(gate.stderr)),
    `${x.fmt(reqB2)}; after it: #${tid} ${t2 ? t2.status : '?'} (state/S6/2); gate over the real log: exit ${gate ? gate.status : '?'} "${gate ? gate.stderr : ''}"; ${liveGate}`);
  const reqA2 = log.find(e => e.kind === 'task_req' && e.from === 'alice' && e.op === 'done');
  const done = reqA2 && log.find(e => e.kind === 'task' && e.op === 'done' && String(e.task_id) === String(tid) && e.req === reqA2.id);
  const l3 = x.st<TaskRec[]>('S6', 3, 'tasks.json', []);
  det('The owner\'s done with evidence completes it; the task entry cites her request', done && l3.find(y => String(y.id) === String(tid))?.status === 'completed',
    `${x.fmt(reqA2)} evidence "${reqA2 ? reqA2.evidence : ''}"; ${x.fmt(done)}`);
  const n = x.assistantIds(x.inSpan(x.entries('claude'), s)).size;
  beh(`The room Claude's task work stayed small (≤ ${T.roomClaudeTaskCalls} model calls for the four requests)`, n, T.roomClaudeTaskCalls, `${n} claude assistant messages in S6`);
}
