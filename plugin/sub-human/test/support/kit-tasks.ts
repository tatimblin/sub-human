// The host's task rules for the kit's daemon (seed-room.ts): core/tasks.ts applyTask, the function net/daemon/rooms.ts
// applies, on a MemoryStore: the entries to append and the task's number, or why nothing was written.
import type { TaskAct } from '../../core/api.js';
import type { Draft } from '../../core/entries.js';
import { fold } from '../../core/fold.js';
import type { Result } from '../../core/result.js';
import { applyTask } from '../../core/tasks.js';
import type { MemoryStore } from './memory-store.js';

export async function taskRule(store: MemoryStore, code: string, from: string, act: TaskAct): Promise<Result<{ readonly drafts: readonly Draft[]; readonly n: number }>> {
  const c = await store.catchup();
  if (!c.ok) return c;
  return applyTask(fold(c.value.snapshot, c.value.lines, await store.docs()), { ...act, code, from });
}
