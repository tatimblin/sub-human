// brief: RoomState → the catch-up text (R16), for `read brief`. Deterministic and bounded: each line is clipped, and
// sections come in order of use (who is doing what, plans, tasks, then recent updates, newest first), so a cut drops
// the oldest updates first. The text is content about the room; framing it as data is the caller's job.
import type { Member, Plan, PlanVersion, RoomState, SentPlan, Task, Update } from './entries.js';

export const BRIEF_MAX = 4000;
const LINE_MAX = 240;

export interface BriefOptions { readonly code: string; readonly maxChars?: number }

export function brief(state: RoomState, { code, maxChars = BRIEF_MAX }: BriefOptions): string {
  const here = state.members.filter(m => m.machines.length > 0);
  const plans = state.plans.map(planLine);
  const sent = state.sent.map(sentLine);
  const tasks = state.tasks.filter(t => t.status !== 'done').map(taskLine);
  const recent = state.recent.toReversed().map(updateLine);
  const lines = [
    `Room ${code}, at update ${state.seq}.`,
    ...section('Members here', here.map(memberLine), 'nobody'),
    ...section('Plans', [...plans, ...sent], 'none'),
    ...section('Open tasks', tasks, 'none'),
    ...section('Recent updates, newest first', recent, 'none'),
  ].map(clip);
  return fit(lines, maxChars);
}

function section(title: string, lines: readonly string[], empty: string): string[] {
  return lines.length ? [`${title}:`, ...lines.map(l => `- ${l}`)] : [`${title}: ${empty}.`];
}

function memberLine(m: Member): string {
  const state = m.presence ? ` (${m.presence.state}${m.presence.waiting ? ', waiting on a permission prompt' : ''})` : '';
  const repo = m.focus?.repo ?? m.repo;
  const branch = m.focus?.branch ?? m.branch;
  const where = repo ? ` in ${repo}${branch ? ` on ${branch}` : ''}` : '';
  const focus = m.focus ? `: ${m.focus.text}` : '';
  const files = m.activity?.files.length ? `. Edited ${list(m.activity.files, 5)}` : '';
  return `${m.name}${state}${where}${focus}${files}`;
}

function planLine(p: Plan): string {
  const v = p.versions.at(-1);
  return v ? `${p.name} version ${v.version} by ${v.from}${p.scope === 'personal' ? ' (personal)' : ''}: ${standing(v)}` : p.name;
}

function standing(v: PlanVersion): string {
  if (v.decision) {
    const { agreed, changes } = v.decision;
    return changes.length ? `changes asked by ${list(changes)}${agreed.length ? `; agreed by ${list(agreed)}` : ''}` : `agreed by ${list(agreed)}`;
  }
  if (!v.asked.length) return 'no agreement asked';
  const answered = v.answers.map(a => (a.answer === 'agree' ? `${a.name} agreed` : `${a.name} asked for changes`));
  const waiting = v.asked.filter(n => !v.answers.some(a => a.name === n));
  return [...answered, ...(waiting.length ? [`waiting on ${list(waiting)}`] : [])].join('; ');
}

function sentLine(p: SentPlan): string {
  const answers = p.answers.map(a => `${a.name} ${a.answer === 'accept' ? 'accepted' : a.answer === 'dismiss' ? 'dismissed' : 'asked for changes'}`);
  return `${p.name} version ${p.version} sent by ${p.from} to ${p.to ?? 'the room'}${answers.length ? `: ${answers.join('; ')}` : ''}`;
}

function taskLine(t: Task): string {
  const who = t.owner ? `claimed by ${t.owner}` : 'open';
  const blocked = t.blockedBy.length ? `, blocked by ${t.blockedBy.map(n => `#${n}`).join(', ')}` : '';
  return `#${t.n} ${t.title}: ${who}${blocked}`;
}

function updateLine(u: Update): string {
  const author = u.by === 'claude' ? `${u.from}'s Claude` : u.from;
  switch (u.kind) {
    case 'finding': return `${author}: ${u.text}`;
    case 'post': return `${author}${u.to ? ` (to ${u.to})` : ''}: ${u.text}`;
    case 'activity': return `${author}: ${u.text}${u.ok === undefined ? '' : u.ok ? ' (passed)' : ' (failed)'}`;
  }
}

function list(xs: readonly string[], max = 8): string {
  return xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', ');
}

function clip(line: string): string {
  const one = line.replace(/\s+/g, ' ');
  return one.length > LINE_MAX ? `${one.slice(0, LINE_MAX - 1)}…` : one;
}

/** Whole lines up to the bound, then `… N more lines` if that fits too; never longer than `max`. */
function fit(lines: readonly string[], max: number): string {
  if (lines.join('\n').length <= max) return lines.join('\n');
  for (let n = lines.length - 1; n >= 0; n--) {
    const text = [...lines.slice(0, n), `… ${lines.length - n} more lines`].join('\n');
    if (text.length <= max) return text;
  }
  return '';
}
