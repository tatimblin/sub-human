/**
 * plugin/sub-human/mod/core/seat.ts: what the module knows about its session, from hooks/handlers/mod-hello.ts, as pure
 * functions. The module keeps the parsed hello in $.state (sub-human/hello) so a hot reload keeps it.
 *
 *   parseHello(stdout, sid) -> hello | null
 *       hello = {sid, home, realHome, userHome, pluginRoot, seat: {name, code, role, addr} | null, restorable, pending}. null
 *       when the output is not a hello (then the module "does not know" and every prefilter runs node).
 *   homeOf(subHumanHome, userHome) -> string | null   where the store lives: SUB_HUMAN_HOME, else ~/.sub-human (lib/home.ts
 *       home() is this rule)
 *   sidIndex(home, sid) -> path | null    the session index a seat of this session id has (<home>/sessions/by-sid/<sid>
 *       .json, lib/identity.ts); none means no seat, so the module need not ask node at session start
 *   localHello({sid, home, realHome, userHome, pluginRoot}) -> hello   what the module knows without node: the paths,
 *       no seat, nothing to restore
 *   seated(hello) -> bool          a seat is known for this session
 *   parseAddr("bob.otter-4821") -> {name, code} | null     a seat's address (the session title), or null
 *   NAME_RE, CODE_RE, SID_SAFE     a seat name, a room code, a session id safe in a file name: owned here, lib/text.ts
 *                                  re-exports them
 *   isSeatName(v), isRoomCode(v), isSessionId(v)   the guards that make the brands (lib/brand.ts) SeatName, RoomCode,
 *                                  SessionId: the only constructors of them; seatName(v), roomCode(v), sessionId(v) ->
 *                                  the brand | null
 */
import type { Hello, HelloSeat } from './types.ts';
import type { RoomCode, SeatName, SessionId } from '../../lib/brand.ts';

/** A seat name: letters, digits, . _ -, 1-32. */
export const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
/** A room code: "otter-4821". */
export const CODE_RE = /^[a-z]+-\d{4}$/;
/** A session id safe to use in a file name. */
export const SID_SAFE = /^[A-Za-z0-9_-]{1,128}$/;
export const isSeatName = (v: unknown): v is SeatName => typeof v === 'string' && NAME_RE.test(v);
export const isRoomCode = (v: unknown): v is RoomCode => typeof v === 'string' && CODE_RE.test(v);
export const isSessionId = (v: unknown): v is SessionId => typeof v === 'string' && SID_SAFE.test(v);
export const seatName = (v: unknown): SeatName | null => (isSeatName(v) ? v : null);
export const roomCode = (v: unknown): RoomCode | null => (isRoomCode(v) ? v : null);
export const sessionId = (v: unknown): SessionId | null => (isSessionId(v) ? v : null);
const ABS = (v: unknown): string | null => typeof v === 'string' && v.startsWith('/') ? v : null;

export function parseAddr(addr: unknown): { name: string; code: string } | null {
  if (typeof addr !== 'string') return null;
  const m = /^(.+)\.([a-z]+-\d{4})$/.exec(addr.trim());
  if (!m || !NAME_RE.test(m[1]) || !CODE_RE.test(m[2])) return null;
  return { name: m[1], code: m[2] };
}

function parseSeat(x: unknown): HelloSeat | null {
  if (!x || typeof x !== 'object') return null;
  const s = x as { name?: unknown; code?: unknown; role?: unknown };
  if (!NAME_RE.test(String(s.name)) || !CODE_RE.test(String(s.code))) return null;
  return { name: String(s.name), code: String(s.code), role: s.role === 'claude' ? 'claude' : 'member', addr: `${s.name}.${s.code}` };
}

export function parseHello(stdout: unknown, sid: unknown): Hello | null {
  let v: unknown;
  try { v = JSON.parse(String(stdout || '').trim()); } catch { return null; }
  // every field read is checked below
  const o: { home?: unknown; realHome?: unknown; userHome?: unknown; pluginRoot?: unknown; seat?: unknown; restorable?: unknown; pending?: unknown } | null = v && typeof v === 'object' ? v : null;
  const home = o && typeof o === 'object' ? ABS(o.home) : null;
  if (!o || !home) return null;
  return {
    sid: typeof sid === 'string' ? sid : null,
    home,
    realHome: ABS(o.realHome) || home,
    userHome: ABS(o.userHome),
    pluginRoot: ABS(o.pluginRoot),
    seat: parseSeat(o.seat),
    restorable: o.restorable === true,
    pending: o.pending === true,
  };
}

export function homeOf(subHumanHome: unknown, userHome: unknown): string | null {
  if (typeof subHumanHome === 'string' && subHumanHome) return subHumanHome;
  return typeof userHome === 'string' && userHome ? `${userHome.replace(/\/+$/, '')}/.sub-human` : null;
}

export const sidIndex = (home: unknown, sid: unknown): string | null => (ABS(home) && typeof sid === 'string' && SID_SAFE.test(sid)
  ? `${String(home).replace(/\/+$/, '')}/sessions/by-sid/${sid}.json` : null);

export function localHello({ sid, home, realHome, userHome, pluginRoot }: { sid: string; home: string; realHome?: string | null; userHome?: string | null; pluginRoot?: string | null }): Hello {
  return { sid, home, realHome: ABS(realHome) || home, userHome: ABS(userHome), pluginRoot: ABS(pluginRoot), seat: null, restorable: false, pending: false };
}

export const seated = (hello: Hello | { seat?: unknown } | null | undefined): boolean => !!(hello && hello.seat);
