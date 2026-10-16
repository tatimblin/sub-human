/**
 * plugin/sub-human/test/support/brands.ts: a test's branded literals (lib/brand.ts), through the real constructors:
 * each throws on a value its validator refuses, so a test cannot hold a brand the code would not make.
 *
 *   rc('otter-4821') -> RoomCode
 */
import { roomCode } from '../../mod/core/seat.ts';
import type { RoomCode } from '../../lib/brand.ts';

function must<T>(v: T | null, what: string, raw: unknown): T {
  if (v === null) throw new TypeError(`test/support/brands.ts: ${JSON.stringify(raw)} is not a ${what}`);
  return v;
}

export const rc = (v: string): RoomCode => must(roomCode(v), 'room code', v);
