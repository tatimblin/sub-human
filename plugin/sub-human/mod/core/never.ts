/**
 * plugin/sub-human/mod/core/never.ts: the end of every switch over a closed union (pure: no import). Owned here, as
 * mod/core owns what the hooks module and node share: lib/, hooks/ and mod/ import it from here.
 *
 *   assertNever(x, what) -> never   a case no branch took: tsc refuses the call while a member of x's union is
 *                                   unhandled, and at run time it throws (only reachable from a value the types lied about)
 *
 * A switch over open data (a log entry's kind from a newer host, a wire field) keeps a graceful default instead: it
 * narrows first (lib/room/validate.ts parseEntry), handles the unknown, then is exhaustive over what is known.
 */

/** A value of no case: the switch above missed a member of its union. what: the union's name, for the message. */
export function assertNever(x: never, what: string): never {
  let shown: string;
  try { shown = JSON.stringify(x) ?? String(x); } catch { shown = String(x); }
  throw new Error(`sub-human: unhandled ${what}: ${shown.slice(0, 200)}`);
}
