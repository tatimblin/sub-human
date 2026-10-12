import { createContext, useContext } from 'react';
import { COLORS } from './design';

/**
 * Who is who in a take: the person who opens the room (`a`, left or top, blue), the one who joins (`b`, violet)
 * and the room's Claude (clay). Each keeps one name and one colour for the whole cut, and the colour never appears
 * without the name beside it (name plates, message tags, caption names). The keys are the capture's session keys,
 * which are also the names the panes show.
 */
export type Who = { name: string; color: string };
export type Cast = { a: string; b: string };

export const BLUE = '#6cb6ff';
export const VIOLET = '#c39bff';
export const ROOM_CLAUDE: Who = { name: "the room's Claude", color: COLORS.accent };

export const ALICE_BOB: Cast = { a: 'alice', b: 'bob' };
export const TRISTAN_JESS: Cast = { a: 'tristan', b: 'jess' };

/** One name and one colour per key ("claude" is the room's Claude; anyone else is grey). */
export function people(c: Cast): Record<string, Who> {
  return {
    [c.a]: { name: c.a, color: BLUE },
    [c.b]: { name: c.b, color: VIOLET },
    claude: ROOM_CLAUDE,
  };
}

export const whoIn = (c: Cast) => {
  const p = people(c);
  return (key: string): Who => p[key] ?? { name: key, color: COLORS.textSoft };
};

/** The cast of the take being rendered (the Trailer sets it; alice and bob outside one). */
export const CastContext = createContext<Cast>(ALICE_BOB);
export const useCast = () => useContext(CastContext);
export const useWho = () => whoIn(useCast());
