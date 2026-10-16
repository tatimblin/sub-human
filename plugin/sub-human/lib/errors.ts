/**
 * plugin/sub-human/lib/errors.ts: reading what a catch caught. A catch variable is `unknown` (anything can be thrown),
 * so every catch reads it through these, never through a cast. Zero runtime imports: a hook loads it for free (the
 * error classes are imported by type only).
 *
 *   msgOf(e) -> string                 its message: an Error's (or any object's string message), else String(e)
 *   stackOf(e) -> string               its stack when it has one (for a log), else String(e)
 *   errCode(e) -> string | undefined   its string code, whatever threw it: a RoomError's (WireCode), NoiseError's
 *                                      'NOISE', a system error's ('ENOENT', 'EEXIST', ...); undefined when it has none
 *   isErrno(e, code?) -> bool          a system error (an Error with a string code, not a CodedError:
 *                                      NodeJS.ErrnoException), with that code when one is given
 *   CodedError                         the errors this plugin throws with a code: RoomError (lib/room/validate.ts, its
 *                                      code a protocol CODES WireCode) | NoiseError (lib/remote/noise.ts, 'NOISE')
 *   isCoded(e) -> e is CodedError      one of them (their prototypes carry CODED; a structural check, so a copy of the
 *                                      module loaded twice still answers)
 *   CODED                              the brand (Symbol.for: one symbol however many copies load)
 *   Result<T, E = RoomError>           {ok: true, value} | {ok: false, error}: lib/decode.ts's, and new code's
 */
import type { RoomError } from './room/validate.ts';
import type { NoiseError } from './remote/noise.ts';

/** A value or an error. */
export type Result<T, E = RoomError> = { ok: true; value: T } | { ok: false; error: E };

/** The errors thrown with a code of ours. */
export type CodedError = RoomError | NoiseError;

/** On the prototype of each CodedError class (a getter that answers true). */
export const CODED: unique symbol = Symbol.for('sub-human.coded-error');

/** Any object's field, own or inherited (a thrown value may be anything). */
const field = (e: unknown, k: PropertyKey): unknown => (typeof e === 'object' && e !== null ? (e as Record<PropertyKey, unknown>)[k] : undefined);

export const msgOf = (e: unknown): string => {
  const m = field(e, 'message');
  return typeof m === 'string' ? m : String(e);
};

export const stackOf = (e: unknown): string => {
  const s = field(e, 'stack');
  return typeof s === 'string' && s ? s : String(e);
};

export const errCode = (e: unknown): string | undefined => {
  const c = field(e, 'code');
  return typeof c === 'string' ? c : undefined;
};

export const isCoded = (e: unknown): e is CodedError => e instanceof Error && field(e, CODED) === true;

export const isErrno = (e: unknown, code?: string): e is NodeJS.ErrnoException =>
  e instanceof Error && !isCoded(e) && typeof field(e, 'code') === 'string' && (code === undefined || field(e, 'code') === code);
