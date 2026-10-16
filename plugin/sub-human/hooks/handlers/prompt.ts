// plugin/sub-human/hooks/handlers/prompt.ts: UserPromptSubmit: one process for both prompt handlers (one node start
// per prompt instead of two):
//   1. hooks/handlers/at-room.ts handle(): an @room post (continue:false + "✓ sent"), a refusal (decision:block), and
//      "working" presence;
//   2. hooks/handlers/consent.ts onPrompt(): a plan-view review left open by Esc is resolved (the person's note recorded)
//      and, still in plan mode, the model is told to exit it first (additionalContext).
// Both run on the same input, in that order, each guarded: a throw in one is logged and the other still runs.
// Merging (what Claude Code did with the two hooks' outputs): when at-room stops the prompt (decision "block":
// the prompt is erased; continue:false: no model turn runs) consent does not run for it (its step would move the
// review while what it says reaches no model: the next prompt that starts a turn takes it) and at-room's output goes
// out alone. Otherwise one output: at-room's fields, with both additionalContext texts and both systemMessages
// joined (at-room's first). No output at all when
// neither had any. Exit 1 (Claude Code shows stderr to the person) only when a handler threw and nothing is output.
// It runs only through mod/prompt.ts (the classic.UserPromptSubmit shim; no hooks.json entry), which adds
// sub_human_origin to its stdin. Its output also carries consent's subHuman {reviewOpen} for the mod.
import { capture, logError, out } from '../reply.ts';
import * as atRoom from './at-room.ts';
import * as consent from './consent.ts';
import type { HookOutput, HookSpecificOutput, Reply } from '../types.ts';

const EVENT = 'UserPromptSubmit';
const stops = (o: HookOutput | null | undefined) => !!o && (o.decision === 'block' || o.continue === false);

/** Merge the handlers' outputs (in order) into the one this hook writes, or null. */
function merge(outputs: (HookOutput | null | undefined)[]): HookOutput | null {
  const list = outputs.filter(o => !!o);
  const said = list.map(o => o.systemMessage).filter(Boolean);
  const notes = said.length ? { systemMessage: said.join('\n') } : {};
  const stop = list.find(stops);
  if (stop) return { ...stop, ...notes };
  if (!list.length) return null;
  // the first value of each top-level field wins, whatever field it is
  const merged: HookOutput & Record<string, unknown> = { ...notes };
  const contexts: string[] = [];
  for (const o of list) {
    const { hookSpecificOutput: hso, ...top } = o;
    for (const [k, v] of Object.entries(top)) if (merged[k] === undefined) merged[k] = v;
    if (!hso) continue;
    const { additionalContext, hookEventName, ...rest } = hso;
    if (additionalContext) contexts.push(additionalContext);
    merged.hookSpecificOutput = { ...rest, ...(merged.hookSpecificOutput || {}), hookEventName: EVENT } satisfies HookSpecificOutput;
  }
  if (contexts.length) {
    merged.hookSpecificOutput = { ...(merged.hookSpecificOutput || { hookEventName: EVENT }), additionalContext: contexts.join('\n\n') };
  }
  return merged;
}

export function handle(input: Parameters<typeof atRoom.handle>[0]): Reply | null {
  const outputs: HookOutput[] = [];
  let failed = false;
  const handlers: [string, () => void][] = [['at-room', () => atRoom.handle(input)], ['consent', () => consent.onPrompt(input)]];
  for (const [where, fn] of handlers) {
    // a prompt at-room stopped starts no turn: consent's step for it would move the review (Esc on the view, then
    // "exit plan mode first") while what it says reaches no model, so the next prompt would find it moved on and
    // plan mode not put back (stage 8e I.4); the next prompt that starts a turn takes the step
    if (where === 'consent' && outputs.some(stops)) continue;
    const r = capture(fn);
    if (r.threw) { logError(r.error, where); failed = true; }
    outputs.push(...r.outputs);
  }
  let o = merge(outputs);
  // Tell the mod whether a room review is still on record (mod/consent.ts flag); after a failure it stays unsure.
  if (!failed) {
    let open: boolean | undefined;
    try { open = consent.reviewOpen(input); } catch (err) { logError(err, 'consent'); }
    if (open !== undefined) o = { ...(o || {}), subHuman: { reviewOpen: open } };
  }
  if (o) out(o);
  return !o && failed ? { kind: 'classic', exit: 1 } : null;
}

export { merge };
