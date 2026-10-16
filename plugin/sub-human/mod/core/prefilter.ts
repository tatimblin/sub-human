/**
 * plugin/sub-human/mod/core/prefilter.ts: when the mod may skip a node start (consent, the task hooks, the row hooks,
 * presence, the SessionStart restore), as pure functions. A node start is only time, a wrongly skipped one loses a nudge, a task mirror entry or a gate,
 * so the rule is: skip only when sure. A hello that is not this session's (none yet, a /clear not refreshed, a failed
 * refresh) and an unset flag both mean "unsure": run node.
 */
import { isRow } from './rows.ts';
import type { Hello, SubHumanReport } from './types.ts';

/** The hello is this session's. */
export const sure = (hello: Hello | null | undefined, sid: unknown): boolean => !!hello && typeof sid === 'string' && hello.sid === sid;

/** classic.Stop: false when the session surely has no seat (a review needs one) or the reviewMaybeOpen flag is false
 * (consent said no review is open, and no EnterPlanMode / ExitPlanMode ran since). Unset counts as true. */
export function consentNeeded(hello: Hello | null | undefined, sid: unknown, reviewFlag: unknown): boolean {
  if (sure(hello, sid) && hello && !hello.seat) return false;
  return reviewFlag !== false;
}

/** classic.PostToolUse TaskCreate|TaskUpdate and classic.TaskCompleted: hooks/handlers/tasks.ts acts only for the room's Claude, so
 * false when the seat is surely a member, or surely none and SUB_HUMAN_ROOM is unset (a room Claude launched before its
 * join has it: tasks.ts roomClaudeRoom). */
export function tasksNeeded(hello: Hello | null | undefined, sid: unknown, roomEnv: unknown): boolean {
  if (!sure(hello, sid) || !hello) return true;
  if (hello.seat) return hello.seat.role === 'claude';
  return typeof roomEnv === 'string' && roomEnv !== '';
}

/** Consent's report under SUB_HUMAN_SHIM=1 when it made one, else undefined. */
export function reviewOpenOf(subHuman: SubHumanReport | null | undefined): boolean | undefined {
  return subHuman && typeof subHuman.reviewOpen === 'boolean' ? subHuman.reviewOpen : undefined;
}

/** A seat is known for this session, or the module is not sure there is none: node may act. */
export const seatedOrUnsure = (hello: Hello | null | undefined, sid: unknown): boolean => !sure(hello, sid) || !!(hello && hello.seat);

/** The row hooks (row-guard, row-map, row-hold): only for a row agent (mod/core/rows.ts isRow), in a seated (or unsure)
 * session. Any other agent costs no node start. */
export const rowsNeeded = (hello: Hello | null | undefined, sid: unknown, agentType: unknown): boolean => isRow(agentType) && seatedOrUnsure(hello, sid);

const RESTORE_SOURCES = new Set(['clear', 'compact', 'resume', 'fork']);

/** classic.SessionStart: session-restore (and on resume row-rewake) runs for clear, compact and resume unless the
 * hello is this session's and says there is no seat and nothing to restore (restorable: the seat this session id last
 * held, or one this claude process holds; unset counts as false only in a hello that is this session's). A fork always
 * runs it: its new session id has no index, and only the old transcript says whose seat it continues (← the agent
 * view; hooks/handlers/session-restore.ts). */
export function restoreNeeded(hello: Hello | null | undefined, sid: unknown, source: unknown): boolean {
  if (!RESTORE_SOURCES.has(String(source))) return false;
  if (source === 'fork') return true;
  if (!sure(hello, sid) || !hello) return true;
  return !!hello.seat || hello.restorable === true;
}

const ROOM_TOOL = /^mcp__plugin_sub-human_room__/;

/** Consent's PreToolUse: on a room tool only while a review may be open (it acts only inside one: consentNeeded); on
 * AskUserQuestion, EnterPlanMode and ExitPlanMode wherever a seat is or may be. */
export function consentPreNeeded(hello: Hello | null | undefined, sid: unknown, tool: unknown, reviewFlag: unknown): boolean {
  if (ROOM_TOOL.test(String(tool))) return seatedOrUnsure(hello, sid) && consentNeeded(hello, sid, reviewFlag);
  return seatedOrUnsure(hello, sid);
}
