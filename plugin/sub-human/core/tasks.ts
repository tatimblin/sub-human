// tasks: the room task rules (R24, R25, R26) and the bridge into a member's native task list (R24a), pure. Each rule
// takes the RoomState and one request and returns the entries the host appends, or a refusal written as what didn't
// happen. A task entry is the whole task after the change; the host writes it as system, `from` the member who acted.
import type { Draft, RoomState, Task } from './entries.js';
import { LIMITS } from './entries.js';
import { err, ok, type Result } from './result.js';
import { markLabel, oneLine } from './text.js';

export interface Add { readonly title: string; readonly from: string; readonly blockedBy?: readonly number[] }
/** A claim, release or done; always by `from` for themselves. */
export interface Op { readonly n: number; readonly from: string }

export function add(s: RoomState, a: Add): Result<Draft[]> {
  const title = a.title.trim();
  if (!title) return err('No task was added: it needs a title.');
  if (title.length > LIMITS.short) return err(`No task was added: its title is over ${LIMITS.short} characters.`);
  const blockedBy = [...new Set(a.blockedBy ?? [])];
  if (blockedBy.length > LIMITS.names) return err(`No task was added: it can wait on at most ${LIMITS.names} tasks.`);
  const unknown = blockedBy.filter(n => !s.tasks.some(t => t.n === n));
  if (unknown.length) return err(`No task was added: there is no task ${unknown.map(n => `#${n}`).join(', ')}.`);
  return ok([entry(a.from, { n: nextN(s.tasks), title, status: 'open', addedBy: a.from, blockedBy })]);
}

/** Claim for oneself; claiming one's own task again changes nothing. */
export function claim(s: RoomState, c: Op): Result<Draft[]> {
  const t = find(s, c.n, 'claimed');
  if (!t.ok) return t;
  const task = t.value;
  if (task.status === 'done') return err(`Task #${task.n} was not claimed: it is done.`);
  if (task.owner === c.from) return ok([]);
  if (task.owner) return err(`Task #${task.n} was not claimed: ${task.owner} has it; they can release it.`);
  return ok([entry(c.from, { ...task, status: 'claimed', owner: c.from })]);
}

/** The owner releases; anyone may release a kicked member's task, which would otherwise be held for good. */
export function release(s: RoomState, r: Op): Result<Draft[]> {
  const t = owned(s, r, 'released', true);
  return t.ok ? ok([entry(r.from, unclaimed(t.value))]) : t;
}

/** Done takes an optional note, not evidence (R26). */
export function done(s: RoomState, d: Op & { readonly note?: string }): Result<Draft[]> {
  if (d.note && d.note.length > LIMITS.text) return err(`Task #${d.n} was not marked done: the note is over ${LIMITS.text} characters.`);
  const t = owned(s, d, 'marked done', false);
  if (!t.ok) return t;
  const { note: _n, ...task } = t.value;
  const note = d.note?.trim() ? d.note : undefined;
  return ok([entry(d.from, { ...task, status: 'done', ...(note !== undefined && { note }) })]);
}

export function nextN(tasks: readonly Task[]): number {
  return tasks.reduce((n, t) => Math.max(n, t.n), 0) + 1;
}

export function entry(from: string, task: Task): Draft {
  return { kind: 'task', from, by: 'system', task };
}

export function unclaimed({ owner: _o, ...task }: Task): Task {
  return { ...task, status: 'open' };
}

function find(s: RoomState, n: number, verb: string): Result<Task> {
  const task = s.tasks.find(t => t.n === n);
  return task ? ok(task) : err(`Task #${n} was not ${verb}: there is no such task.`);
}

/** The task when `o.from` holds it (or, with `kicked`, when a kicked member does), else why not. */
function owned(s: RoomState, o: Op, verb: string, kicked: boolean): Result<Task> {
  const t = find(s, o.n, verb);
  if (!t.ok) return t;
  const { owner, status } = t.value;
  const mine = owner === o.from || (kicked && s.members.some(m => m.name === owner && m.kicked));
  if (mine && status === 'claimed') return t;
  const why = status === 'done' ? 'it is done' : owner ? `${owner} has it` : 'nobody has claimed it';
  return err(`Task #${o.n} was not ${verb}: ${why}.`);
}

// The bridge. A room task on a native list carries `[room CODE#N]` in its subject; the native tool's status change on
// it maps to a room op. Only completed and deleted count: a reopen (pending ↔ in_progress) never releases owned work.

export interface Tag { readonly code: string; readonly n: number }

export function tag(code: string, n: number): string {
  return `[room ${code}#${n}]`;
}

const TAG = /\[room ([^\s#\]]+)#(\d+)\]/g;

/** The subject's tag for room `code`, or with no code its first tag; a subject may carry several rooms' tags. */
export function parseTag(subject: string, code?: string): Tag | null {
  for (const m of subject.matchAll(TAG)) {
    if (m[1] && m[2] && (code === undefined || m[1] === code)) return { code: m[1], n: Number(m[2]) };
  }
  return null;
}

export interface StatusChange { readonly from: string; readonly to: string }
/** A room op on the tagged task, an activity for an untagged one, or nothing. */
export type BridgeOp =
  | { readonly kind: 'done' | 'release'; readonly code: string; readonly n: number }
  | { readonly kind: 'activity' }
  | { readonly kind: 'none' };

export function bridgeOp(change: StatusChange | undefined, t: Tag | null): BridgeOp {
  if (!change || change.from === change.to) return { kind: 'none' };
  if (!t) return { kind: 'activity' };
  if (change.to === 'completed') return { kind: 'done', ...t };
  if (change.to === 'deleted') return { kind: 'release', ...t };
  return { kind: 'none' };
}

/**
 * Room `code`'s open tasks with their owners and blockers, and how many are done: `/sub-human tasks` and `task list`.
 * A title and owner are colleagues' text, so each line is one line, with no escape or label in it.
 */
export function taskLines(code: string, all: readonly Task[]): string[] {
  if (all.length === 0) return [`${code} has no tasks yet.`];
  const open = all.filter(t => t.status !== 'done');
  const done = all.length - open.length;
  const line = (t: Task): string => `#${t.n} ${t.owner ? `${markLabel(t.owner, 64)}'s` : 'open'} · ${oneLine(t.title, 200)}${t.blockedBy.length ? ` · after #${t.blockedBy.join(', #')}` : ''}`;
  return [`${code} · ${open.length} open`, ...open.map(line), ...(done ? [`${done} done`] : [])];
}
