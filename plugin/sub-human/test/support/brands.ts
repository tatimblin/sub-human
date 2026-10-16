/**
 * plugin/sub-human/test/support/brands.ts: a test's branded literals (lib/brand.ts), through the real constructors:
 * each throws on a value its validator refuses, so a test cannot hold a brand the code would not make.
 *
 *   rc('otter-4821') -> RoomCode    sn('alice') -> SeatName    sid('s1') -> SessionId    mid('far0machine') -> MachineId
 *   eid(3) -> EntryId               tid('2') -> TaskId
 *   tok(v) -> LinkToken             inv(v) -> InviteSecret     pin('4829') -> Pin
 *   tokenOf(seed) -> LinkToken      a token made from seed (a test's stand-in for one host-links.ts create() gave)
 *   wordOf(seed) -> InviteSecret    an invite line's word made from seed (invite-secret.ts encode)
 */
import crypto from 'node:crypto';
import { roomCode, seatName, sessionId } from '../../mod/core/seat.ts';
import { isMachineId } from '../../lib/text.ts';
import { entryId, taskId } from '../../lib/room/validate.ts';
import { isLinkToken } from '../../lib/remote/host-links.ts';
import { isPin } from '../../lib/remote/invites.ts';
import { isInviteSecret, encode, SECRET_BYTES, TAG_BYTES } from '../../lib/remote/invite-secret.ts';
import type { EntryId, InviteSecret, LinkToken, MachineId, Pin, TaskId, RoomCode, SeatName, SessionId } from '../../lib/brand.ts';

function must<T>(v: T | null, what: string, raw: unknown): T {
  if (v === null) throw new TypeError(`test/support/brands.ts: ${JSON.stringify(raw)} is not a ${what}`);
  return v;
}

export const rc = (v: string): RoomCode => must(roomCode(v), 'room code', v);
export const sn = (v: string): SeatName => must(seatName(v), 'seat name', v);
export const sid = (v: string): SessionId => must(sessionId(v), 'session id', v);
export const mid = (v: string): MachineId => must(isMachineId(v) ? v : null, 'machine id', v);
export const eid = (v: number): EntryId => must(entryId(v), 'entry id', v);
export const tid = (v: string): TaskId => must(taskId(v), 'task id', v);
export const tok = (v: string): LinkToken => must(isLinkToken(v) ? v : null, 'link token', v);
export const inv = (v: string): InviteSecret => must(isInviteSecret(v) ? v : null, 'invite secret', v);
export const pin = (v: string): Pin => must(isPin(v) ? v : null, 'PIN', v);
export const tokenOf = (seed: string): LinkToken => tok(seed.replace(/[^A-Za-z0-9_-]/g, '_').padEnd(32, '0').slice(0, 32));
export function wordOf(seed: string): InviteSecret {
  const bytes = crypto.createHash('sha256').update(seed).digest();
  return encode(bytes.subarray(0, SECRET_BYTES), bytes.subarray(SECRET_BYTES, SECRET_BYTES + TAG_BYTES));
}
