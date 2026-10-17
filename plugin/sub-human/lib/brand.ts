/**
 * plugin/sub-human/lib/brand.ts: the branded ids and secrets, types only (erased: nothing here runs). A brand is a
 * string or number that a validator accepted, so a room code cannot stand where a seat name goes, nor a PIN where a
 * session id does. A branded value is still its base type (a RoomCode is a string to every reader); only a
 * constructor makes one, each beside the validator it already was, and each is a type guard (`v is RoomCode`), so no
 * cast makes a brand:
 *
 *   RoomCode       "otter-4821"           mod/core/seat.ts isRoomCode / roomCode (CODE_RE)
 *   SeatName       "bob"                  mod/core/seat.ts isSeatName / seatName (NAME_RE); namedSeat("claude")
 *   SessionId      Claude Code's session  mod/core/seat.ts isSessionId / sessionId (SID_SAFE: safe in a file name)
 *   MachineId      16 hex, k + 15 hex     lib/text.ts isMachineId (MACHINE_RE); lib/remote/machine-key.ts idOf
 *   ProposalHash   12 hex                 lib/text.ts isProposalHash / planHash (HASH_RE, hash12)
 *   EntryId        1, 2, …                lib/room/validate.ts isEntryId / entryId / nextEntryId (a positive safe integer)
 *   TaskId         "7", "a1"              lib/room/validate.ts isTaskId / taskId (a short id string)
 *   Pin            4 digits               lib/remote/invites.ts isPin / isShortPin
 *   InviteSecret   an invite line's word  lib/remote/invite-secret.ts isInviteSecret (WORD_RE)
 *   LinkToken      a link's bearer token  lib/remote/host-links.ts isLinkToken (32 base64url)
 *
 * The secrets (Pin, InviteSecret, LinkToken) go into a line a person or a log reads only through lib/cli/doctor/
 * redact.ts redact(), but for the reply that hands one over; test/secrets.node-test.ts checks that after an invite
 * join no file of either home holds one but the joiner's link record (its token).
 */

declare const brand: unique symbol;

/** T, accepted by the validator of B. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RoomCode = Brand<string, 'RoomCode'>;
export type SeatName = Brand<string, 'SeatName'>;
export type SessionId = Brand<string, 'SessionId'>;
export type MachineId = Brand<string, 'MachineId'>;
export type ProposalHash = Brand<string, 'ProposalHash'>;
export type EntryId = Brand<number, 'EntryId'>;
export type TaskId = Brand<string, 'TaskId'>;

export type Pin = Brand<string, 'Pin'>;
export type InviteSecret = Brand<string, 'InviteSecret'>;
export type LinkToken = Brand<string, 'LinkToken'>;
/** What redact() hides. */
export type Secret = Pin | InviteSecret | LinkToken;
