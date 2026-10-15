/**
 * plugin/sub-human/hooks/seat.ts: who a hook runs for. Loads lib/identity.ts and no seat key: resolving a seat signs
 * nothing (the handlers that sign arm the signer themselves: hooks/seat-key.ts arm).
 *
 * Hooks are trusted code run by Claude Code itself (or by the hooks module), never by a model. Identity is resolved
 * from the payload's session_id first, then from CLAUDE_PID by a direct lookup of the registered pid: /clear changes the
 * session_id but not the claude process. Claude Code sets CLAUDE_PID for every command hook; hooks/run.ts sets it for a
 * handler the hooks module runs (its $.process.run child's parent is the claude process).
 *
 *   resolveSeat(input, {ancestry}?) -> {code, name, role, session_id, pid, address} | null
 *   whoami(input)      resolveSeat (a hook then opens its room explicitly: room.open(me.code))
 */
import * as identity from '../lib/identity.ts';
import type { Identity } from '../lib/identity.ts';

const attempt = <T>(f: () => T): T | null => { try { return f(); } catch { return null; } };

/**
 * Who this hook runs for: {code, name, role, session_id, pid, address} or null. In order: the payload's
 * session_id; then CLAUDE_PID by a direct lookup of the registered pid; then, only with {ancestry: true},
 * identity.resolveSelf() (CLAUDE_CODE_SESSION_ID, CLAUDE_PID, then the nearest registered ancestor pid, which costs a
 * `ps` table). The row hooks ask for the walk (a row hook may run without CLAUDE_PID, e.g. by hand); the others never
 * walk, so an unjoined session stays cheap and a hook never borrows the seat of whatever claude process happens to be
 * an ancestor.
 */
export function resolveSeat(input: { session_id?: unknown } = {}, { ancestry = false } = {}): Identity | null {
  let me: Identity | null = input && input.session_id ? attempt(() => identity.resolveBySession(input.session_id)) : null;
  if (!me) { const pid = identity.claudePid(); if (pid) me = attempt(() => identity.resolveByPid(pid)); }
  if (!me && ancestry) me = attempt(() => identity.resolveSelf());
  return me && me.code && me.name ? me : null;
}

export const whoami = (input: { session_id?: unknown } = {}) => resolveSeat(input);
