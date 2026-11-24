// The kit's daemon's `plan` (seed-room.ts): core/plans.ts applyPlan, the function net/daemon/rooms.ts applies, on a
// MemoryStore's state, so the two can't drift.
import type { PlanAct } from '../../core/api.js';
import type { Draft, RoomState } from '../../core/entries.js';
import { fold } from '../../core/fold.js';
import { sha256 } from '../../core/hash.js';
import { applyPlan } from '../../core/plans.js';
import type { Result } from '../../core/result.js';
import type { MemoryStore } from './memory-store.js';

export async function roomState(store: MemoryStore): Promise<RoomState> {
  const c = await store.catchup();
  if (!c.ok) throw new Error(c.error);
  return fold(c.value.snapshot, c.value.lines, await store.docs());
}

/** The entries a plan act appends, or the stale edit's refusal, or why it was refused. */
export async function planRule(store: MemoryStore, code: string, from: string, act: PlanAct): Promise<Result<{ readonly drafts: Draft[] } | { readonly refused: string }>> {
  return applyPlan(await roomState(store), { ...act, code, from }, act.act === 'edit' ? await sha256(act.text) : '', hash => store.room.blobs.get(hash) ?? '');
}
