/**
 * plugin/sub-human/mod/core/quiet.ts: which tool calls' rows the module draws as nothing, as pure functions
 * (mod/consent.ts runs the hooks: ui.render ToolUse and ToolResult).
 *
 * Only calls consent named as sub-human's own (hooks/consent.ts subHuman.quiet, by tool_use_id): a review's
 * EnterPlanMode made outside plan mode ("Entered plan mode · Claude is now exploring…" is false: the person only
 * reviews), a review's plan view ("User approved / rejected Claude's plan", a room version under the frame line, never
 * the person's own plan), its closing call, and an edit's save (the store's receipt, drawn by Claude Code as a red
 * "Error:" under a red header: #9). A person's own plan mode, and every other call, draws as Claude Code draws it.
 *
 *   QUIET_MAX                     how many call ids are kept (the oldest go first)
 *   keepQuiet(kept, id) -> ids    kept with id added, at most QUIET_MAX
 *   quietRow(ids, id) -> bool     a row of that call is drawn as nothing
 *   quietOn(hello) -> bool        not while the version's verdict turns quiet-plan off (mod/core/cc.ts GATED)
 */
import type { Hello } from './types.ts';

export const QUIET_MAX = 64;

export function keepQuiet(kept: readonly string[], id: string): string[] {
  const next = [...kept.filter(k => k !== id), id];
  return next.length > QUIET_MAX ? next.slice(next.length - QUIET_MAX) : next;
}

export const quietRow = (ids: readonly string[], id: unknown): boolean => typeof id === 'string' && id !== '' && ids.includes(id);

export const quietOn = (hello: Hello | null | undefined): boolean => !(hello && hello.cc && hello.cc.off.includes('quiet-plan'));
