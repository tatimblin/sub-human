#!/usr/bin/env node
// UserPromptSubmit: one process for both prompt handlers (one node start per prompt instead of two):
//   1. hooks/at-room.ts handle(): an @room post (continue:false + "✓ sent"), a refusal (decision:block), and
//      "working" presence;
//   2. hooks/consent.ts onPrompt(): a plan-view review left open by Esc is resolved (the person's note recorded)
//      and, still in plan mode, the model is told to exit it first (additionalContext).
// Both run on the same input, in that order, each guarded: a throw in one is logged and the other still runs.
// Merging (what Claude Code did with the two hooks' outputs): when at-room stops the prompt (decision "block":
// the prompt is erased; continue:false: no model turn runs) its output goes out alone, since no turn reads any
// context (consent's side effects are already done, and it says the same on the next prompt), but with every
// systemMessage (consent's tells the person an answer was not recorded). Otherwise one output: at-room's fields,
// with both additionalContext texts and both systemMessages joined (at-room's first). No output at all when
// neither had any. Exit 1 (Claude Code shows stderr to the person) only when a handler threw and nothing is output.
// It runs only through mod/prompt.ts (the classic.UserPromptSubmit shim; no hooks.json entry), which adds
// sub_human_origin to its stdin. Its output also carries consent's subHuman {reviewOpen} for the mod.
import * as c from './common.ts';
import * as atRoom from './at-room.ts';
import * as consent from './consent.ts';

const EVENT = 'UserPromptSubmit';
const stops = o => !!o && (o.decision === 'block' || o.continue === false);

/** Merge the handlers' outputs (in order) into the one this hook writes, or null. */
function merge(outputs) {
  const list = outputs.filter(Boolean);
  const said = list.map(o => o.systemMessage).filter(Boolean);
  const notes = said.length ? { systemMessage: said.join('\n') } : {};
  const stop = list.find(stops);
  if (stop) return { ...stop, ...notes };
  if (!list.length) return null;
  const merged = { ...notes };
  const contexts = [];
  for (const o of list) {
    const { hookSpecificOutput: hso, ...top } = o;
    for (const [k, v] of Object.entries(top)) if (merged[k] === undefined) merged[k] = v;
    if (!hso) continue;
    const { additionalContext, hookEventName, ...rest } = hso;
    if (additionalContext) contexts.push(additionalContext);
    merged.hookSpecificOutput = { ...rest, ...(merged.hookSpecificOutput || {}), hookEventName: EVENT };
  }
  if (contexts.length) {
    merged.hookSpecificOutput = { ...(merged.hookSpecificOutput || { hookEventName: EVENT }), additionalContext: contexts.join('\n\n') };
  }
  return merged;
}

function main() {
  let input;
  try { input = c.readInput(); } catch (err) { c.logError(err, 'prompt'); process.exitCode = 1; return; }
  const outputs = [];
  let failed = false;
  for (const [where, fn] of [['at-room', () => atRoom.handle(input)], ['consent', () => consent.onPrompt(input)]]) {
    const r = c.capture(fn);
    if (r.error) { c.logError(r.error, where); failed = true; }
    outputs.push(...r.outputs);
  }
  let o = merge(outputs);
  // Tell the mod whether a room review is still on record (mod/consent.ts flag); after a failure it stays unsure.
  if (!failed) {
    let open;
    try { open = consent.reviewOpen(input); } catch (err) { c.logError(err, 'consent'); }
    if (open !== undefined) o = { ...(o || {}), subHuman: { reviewOpen: open } };
  }
  if (o) c.out(o);
  else if (failed) process.exitCode = 1;
}

export { merge };
if (import.meta.main) main();
