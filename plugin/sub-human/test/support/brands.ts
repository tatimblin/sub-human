/**
 * plugin/sub-human/test/support/brands.ts: a test's branded literals (lib/brand.ts), through the real constructors:
 * each throws on a value its validator refuses, so a test cannot hold a brand the code would not make.
 *
 *   rc('otter-4821') -> RoomCode;  sn('alice') -> SeatName;  sid('s1') -> SessionId;  mid('far0machine') -> MachineId;  eid(3) -> EntryId;  tid('2') -> TaskId
 */
import { roomCode, seatName, sessionId } from '../../mod/core/seat.ts';
import { isMachineId } from '../../lib/text.ts';
import { entryId, taskId } from '../../lib/room/validate.ts';
import type { EntryId, MachineId, TaskId, RoomCode, SeatName, SessionId } from '../../lib/brand.ts';

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
