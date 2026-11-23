// The host's task rules for the kit's daemon (seed-room.ts): what net/daemon/rooms.ts does with a `task` request, on a
// MemoryStore: the entries to append and the task's number, or why nothing was written.
import type { TaskAct } from '../../core/api.js';
import type { Draft } from '../../core/entries.js';
import { fold } from '../../core/fold.js';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import { add, claim, done, nextN, release } from '../../core/tasks.js';
import type { MemoryStore } from '../../store/memory-store.js';

export async function taskRule(store: MemoryStore, from: string, act: TaskAct): Promise<Result<{ drafts: Draft[]; n: number }>> {
  const c = await store.catchup();
  if (!c.ok) return c;
  const s = fold(c.value.snapshot, c.value.lines, await store.docs());
  if (!s.members.some(m => m.name === from && !m.kicked)) return err(`${from} is not in the room; nothing was written`);
  const drafts = act.act === 'add' ? add(s, { ...act, from }) : act.act === 'done' ? done(s, { ...act, from })
    : act.act === 'claim' ? claim(s, { ...act, from }) : release(s, { ...act, from });
  return drafts.ok ? ok({ drafts: drafts.value, n: act.act === 'add' ? nextN(s.tasks) : act.n }) : drafts;
}
