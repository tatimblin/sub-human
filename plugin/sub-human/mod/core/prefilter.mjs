/**
 * plugin/sub-human/mod/core/prefilter.mjs: when the mod may skip a node start for consent and the task hooks, as
 * pure functions. A node start is only time, a wrongly skipped one loses a nudge, a task mirror entry or a gate,
 * so the rule is: skip only when sure. A hello that is not this session's (none yet, a /clear not refreshed, a failed
 * refresh) and an unset flag both mean "unsure": run node.
 */

/** The hello is this session's. */
export const sure = (hello, sid) => !!hello && typeof sid === 'string' && hello.sid === sid;

/** classic.Stop: false when the session surely has no seat (a review needs one) or the reviewMaybeOpen flag is false
 * (consent said no review is open, and no EnterPlanMode / ExitPlanMode ran since). Unset counts as true. */
export function consentNeeded(hello, sid, reviewFlag) {
  if (sure(hello, sid) && !hello.seat) return false;
  return reviewFlag !== false;
}

/** classic.PostToolUse TaskCreate|TaskUpdate and classic.TaskCompleted: hooks/tasks.js acts only for the room's Claude, so
 * false when the seat is surely a member, or surely none and SUB_HUMAN_ROOM is unset (a room Claude launched before its
 * join has it: tasks.js roomClaudeRoom). */
export function tasksNeeded(hello, sid, roomEnv) {
  if (!sure(hello, sid)) return true;
  if (hello.seat) return hello.seat.role === 'claude';
  return typeof roomEnv === 'string' && roomEnv !== '';
}

/** Consent's report under SUB_HUMAN_SHIM=1 when it made one, else undefined. */
export function reviewOpenOf(subHuman) {
  return subHuman && typeof subHuman.reviewOpen === 'boolean' ? subHuman.reviewOpen : undefined;
}
