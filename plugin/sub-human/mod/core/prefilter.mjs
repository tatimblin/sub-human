/**
 * plugin/sub-human/mod/core/prefilter.mjs: when the mod may skip a node start for consent and the task hooks, as
 * pure functions (docs/next/MODS-PLAN.md Part 1). The rule: skip only when sure. A hello that is not this
 * session's (none yet, a /clear not refreshed, a failed refresh) and an unset flag both mean "unsure": run node.
 *
 *   sure(hello, sid) -> bool                     the hello is this session's
 *   consentNeeded(hello, sid, reviewFlag) -> bool
 *       classic.Stop, and the room tools' consent hook: false when the session surely has no seat (a review
 *       needs one) or the reviewMaybeOpen flag is false (consent said no review is open, and no EnterPlanMode /
 *       ExitPlanMode ran since). undefined (unset) counts as true.
 *   tasksNeeded(hello, sid, roomEnv) -> bool
 *       classic.PostToolUse TaskCreate|TaskUpdate and classic.TaskCompleted: hooks/tasks.js acts only for the
 *       orch. false when the seat is surely a member, or surely none and SUB_HUMAN_ROOM is unset (an orch
 *       launched before its join has it: tasks.js orchRoom).
 *   reviewOpenOf(subHuman) -> bool | undefined   consent's report under SUB_HUMAN_SHIM=1, when it made one
 */

export const sure = (hello, sid) => !!hello && typeof sid === 'string' && hello.sid === sid;

export function consentNeeded(hello, sid, reviewFlag) {
  if (sure(hello, sid) && !hello.seat) return false;
  return reviewFlag !== false;
}

export function tasksNeeded(hello, sid, roomEnv) {
  if (!sure(hello, sid)) return true;
  if (hello.seat) return hello.seat.role === 'orch';
  return typeof roomEnv === 'string' && roomEnv !== '';
}

export function reviewOpenOf(subHuman) {
  return subHuman && typeof subHuman.reviewOpen === 'boolean' ? subHuman.reviewOpen : undefined;
}
