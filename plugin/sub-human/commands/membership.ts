// Member names: the rules a join follows. Which room a session is in is its pointer file (core/api.ts
// sessionFile), which the daemon writes with the title it gives once, at the join. Pure, so the module loads it.
import type { Pointer } from '../core/api.js';

/** A session in a room: its id (the pointer file's name) and what the pointer holds. */
export interface Membership extends Pointer { readonly id: string }

/** A member name: one lowercase word, so `NAME.CODE` reads one way. */
export const NAME: RegExp = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Names that would read as a verb or as the room itself. */
export const RESERVED: ReadonlySet<string> = new Set([
  'room', 'all', 'claude', 'system', 'host', 'who', 'tasks', 'leave', 'kick', 'help', 'doctor', 'news', 'invite', 'join',
]);

/**
 * A person's own name as a member name: the first word, lowercased, accents and other marks dropped. A name ending in
 * `-<digits>` is none: that is how a second session's title reads (net/daemon/pointers.ts titleFor).
 */
export function nameFrom(text: string): string | null {
  const first = text.trim().split(/\s+/)[0] ?? '';
  const n = first.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[_-]+/, '').slice(0, 32);
  return NAME.test(n) && !RESERVED.has(n) && !/-\d+$/.test(n) ? n : null;
}
