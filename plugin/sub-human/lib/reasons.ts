/**
 * plugin/sub-human/lib/reasons.ts: the typed reason beside an error's code. A RoomError's code (INVALID, AUTH, OFFLINE,
 * FORK, ...: lib/remote/protocol.ts CODES) says what kind of failure it is; its reason, when it has one, says exactly
 * which, so code that decides (the link daemon's outbox, the mirror's "outcome unknown", doctor's fix lines, the join's
 * answer) keys on a constant, never on the message's words. The message stays for people. Zero dependencies.
 *
 * On the wire an error frame is {id, error: {code, message, reason?}} (additive: a peer from before reasons sends and
 * reads none; nothing here depends on a peer sending one). The bridge, the link daemon's socket and its state file
 * (lib/room/links.ts LinkState lastReason) carry it unchanged.
 *
 *   REASONS              every reason, by name (a frozen object: REASONS.PLACED_ALREADY === 'PLACED_ALREADY')
 *   isReason(x) -> bool  one of them
 *   reasonOf(err) -> Reason | null   the error's reason, when it is one of REASONS
 *   withReason(err, reason) -> err   sets it (returns the same error)
 *
 *   REASON_CODE          each reason's code (the source of Reason: a reason is added with the code it comes with);
 *                        null: a reason a link stops with, carried beside whatever code the stop had (OFFLINE by
 *                        default: lib/remote/link-socket.ts stopReason)
 *   ReasonFor<C>         the reasons that may ride with code C (its own, and the null ones)
 */
import type { WireCode } from './remote/types-core.ts';

export const REASON_CODE = {
  // AUTH
  PLACED_ALREADY: 'AUTH', // a signed entry's nonce is in the log: an earlier try landed
  INVITE_UNKNOWN: 'AUTH', INVITE_USED: 'AUTH', INVITE_BURNT: 'AUTH', INVITE_EXPIRED: 'AUTH', INVITE_OTHER_MACHINE: 'AUTH',
  INVITE_OTHER_LINK: 'AUTH',
  PIN_NEEDED: 'AUTH', // an invite line's host asks for its PIN: the joiner is asked
  PIN_WRONG: 'AUTH',
  PIN_LAST: 'AUTH', // a wrong PIN burnt it
  PIN_THROTTLED: 'AUTH', // a PIN too soon after a wrong one: nothing charged
  HOST_KEY_MISMATCH: 'AUTH', // the host that answered does not hold the key the invite line's tag names: nothing was sent
  KEY_MISMATCH: 'AUTH', // a web link, or its join, bound to another Noise key than the connection proved
  ADMIT_REFUSED: 'AUTH', ADMIT_LAPSED: 'AUTH', ADMIT_REVOKED: 'AUTH',
  ADMIT_LATE: 'AUTH', // let in, but not redeemed in time
  TOKEN_UNKNOWN: 'AUTH',
  LINK_REVOKED: 'AUTH', // the host revoked the link
  KEY_REVOKED: 'AUTH', // ssh refused a link's own key that once got in
  NOT_BOUND: 'AUTH', // a link let in as one name joins as another
  NOT_JOINED: 'AUTH', // a write as a seat that did not join over the link
  LOGIN_ONLY: 'AUTH', // a login hello that did not come over an ssh login
  MACHINE_TAKEN: 'AUTH', // a link reports a machine id the room knows as another's
  // an ssh login link that cannot work until the person acts (SSH_HOST_UNKNOWN: ssh cannot resolve the host's name,
  // on a login link's first connection)
  SSH_HOST_KEY: 'AUTH', SSH_DENIED: 'AUTH', SSH_NO_SHIM: 'AUTH', SSH_NO_ROOM: 'AUTH', SSH_OLD_HOST: 'AUTH', SSH_HOST_UNKNOWN: 'AUTH',
  // OFFLINE
  UNKNOWN_OUTCOME: 'OFFLINE', // the op went out and got no answer in time: it may still land, retrying is safe
  NOT_SENT: 'OFFLINE', // nothing went out
  DAEMON_DOWN: 'OFFLINE', // no link daemon answers on this machine
  ADMIT_WAITING: 'OFFLINE', // the host person has not answered the card yet
  QUEUE_FULL: 'OFFLINE',
  // RATE
  QUOTA: 'RATE', // a link's per-op quota, lib/config.ts LINK_QUOTAS
  // PROTOCOL
  SKEW: 'PROTOCOL', // the two ends speak no common protocol version: protocol.skewMessage says who updates
  // STALE
  MOVED_AWAY: 'STALE', // the room moved to a newer host
  BEHIND: 'STALE', // this copy has not caught up with a host change
  // FORK
  LOG_RESET: 'FORK', // the host's log was reset under a stream
  NOT_CHAINED: 'FORK', // a line, a snapshot or `after` that is not the mirror's
  // a link stopped
  ROOM_CLOSED: null, // the room was closed: a dormant link
  NO_SEAT: null, // no seat of this machine is left in the room
} as const;
// checked apart from the table: an exported `satisfies` is a type an isolated declaration cannot infer
REASON_CODE satisfies Record<string, WireCode | null>;

export type Reason = keyof typeof REASON_CODE;
/** The reasons that may ride with code C. */
export type ReasonFor<C extends WireCode> = { [R in Reason]: (typeof REASON_CODE)[R] extends C | null ? R : never }[Reason];

const NAMES = Object.keys(REASON_CODE) as Reason[]; // the object's own keys: Reason

export const REASONS: Readonly<{ [R in Reason]: R }> = Object.freeze(Object.fromEntries(NAMES.map(n => [n, n])) as { [R in Reason]: R });

const SET: ReadonlySet<string> = new Set(NAMES);

export const isReason = (x: unknown): x is Reason => typeof x === 'string' && SET.has(x);

export const reasonOf = (err: unknown): Reason | null => {
  const r = err && typeof err === 'object' ? (err as { reason?: unknown }).reason : undefined;
  return isReason(r) ? r : null;
};

export function withReason<E extends object>(err: E, reason: Reason | null | undefined): E {
  if (reason) Object.assign(err, { reason });
  return err;
}
