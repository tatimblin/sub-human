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
 * The reasons, by the code they come with:
 *   AUTH      PLACED_ALREADY (a signed entry's nonce is in the log: an earlier try landed), INVITE_UNKNOWN, INVITE_USED,
 *             INVITE_BURNT, INVITE_EXPIRED, INVITE_OTHER_MACHINE, INVITE_OTHER_LINK, PIN_NEEDED (an invite line's
 *             host asks for its PIN: the joiner is asked), PIN_WRONG, PIN_LAST (a wrong PIN burnt it), PIN_THROTTLED (a
 *             PIN too soon after a wrong one: nothing charged), HOST_KEY_MISMATCH (the host that answered does not
 *             hold the key the invite line's tag names: nothing was sent), KEY_MISMATCH (a web link, or its join,
 *             bound to another Noise key than the connection proved), ADMIT_REFUSED, ADMIT_LAPSED, ADMIT_REVOKED, ADMIT_LATE (let in, but not redeemed in
 *             time), TOKEN_UNKNOWN, LINK_REVOKED (the host revoked the link), KEY_REVOKED (ssh refused a link's own key
 *             that once got in), NOT_BOUND (a link let in as one name joins as another), NOT_JOINED (a write as a seat
 *             that did not join over the link), LOGIN_ONLY (a login hello that did not come over an ssh login),
 *             MACHINE_TAKEN (a link reports a machine id the room knows as another's), SSH_HOST_KEY, SSH_DENIED,
 *             SSH_NO_SHIM, SSH_NO_ROOM, SSH_OLD_HOST, SSH_HOST_UNKNOWN (ssh cannot resolve the host's name, on a login
 *             link's first connection) (an ssh login link that cannot work until the person acts)
 *   OFFLINE   UNKNOWN_OUTCOME (the op went out and got no answer in time: it may still land, retrying is safe),
 *             NOT_SENT (nothing went out), DAEMON_DOWN (no link daemon answers on this machine), ADMIT_WAITING (the
 *             host person has not answered the card yet), QUEUE_FULL
 *   RATE      QUOTA (a link's per-op quota, lib/config.ts LINK_QUOTAS)
 *   PROTOCOL  SKEW (the two ends speak no common protocol version: protocol.skewMessage says who updates)
 *   STALE     MOVED_AWAY (the room moved to a newer host), BEHIND (this copy has not caught up with a host change)
 *   FORK      LOG_RESET (the host's log was reset under a stream), NOT_CHAINED (a line, a snapshot or `after` that is not
 *             the mirror's)
 *   (stopped) ROOM_CLOSED (the room was closed: a dormant link), NO_SEAT (no seat of this machine is left in the room)
 */

const NAMES = [
  'PLACED_ALREADY', 'INVITE_UNKNOWN', 'INVITE_USED', 'INVITE_BURNT', 'INVITE_EXPIRED', 'INVITE_OTHER_MACHINE', 'INVITE_OTHER_LINK',
  'PIN_NEEDED', 'PIN_WRONG', 'PIN_LAST', 'PIN_THROTTLED', 'HOST_KEY_MISMATCH', 'KEY_MISMATCH', 'ADMIT_REFUSED', 'ADMIT_LAPSED', 'ADMIT_REVOKED', 'ADMIT_LATE', 'TOKEN_UNKNOWN',
  'LINK_REVOKED', 'KEY_REVOKED', 'NOT_BOUND', 'NOT_JOINED', 'LOGIN_ONLY', 'MACHINE_TAKEN', 'SSH_HOST_KEY', 'SSH_DENIED',
  'SSH_NO_SHIM', 'SSH_NO_ROOM', 'SSH_OLD_HOST', 'SSH_HOST_UNKNOWN',
  'UNKNOWN_OUTCOME', 'NOT_SENT', 'DAEMON_DOWN', 'ADMIT_WAITING', 'QUEUE_FULL',
  'QUOTA', 'SKEW', 'MOVED_AWAY', 'BEHIND', 'LOG_RESET', 'NOT_CHAINED', 'ROOM_CLOSED', 'NO_SEAT',
] as const;

export type Reason = typeof NAMES[number];

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
