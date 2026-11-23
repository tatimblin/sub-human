// What this session's module knows of its room: one object every part reads and writes as plain data (a `$` never
// leaves the hook that holds it, so the parts share this instead). follow.ts fills it; nothing here does I/O.
import type { Input, Item, Me } from '../core/deliver.js';
import type { ActivityDoc, RoomState } from '../core/entries.js';

/** The /sub-human command's name in a prompt.submit, as Claude Code gives it. */
export const COMMAND: RegExp = /^(?:sub-human:)?sub-human$/;

export interface InRoom {
  readonly home: string; readonly code: string; readonly name: string; readonly title: string;
  readonly dir: string; readonly root: string;
}
/** What this session's module knows of its room, shared by every part as plain data. */
export interface Session {
  room: InRoom | null;
  state: RoomState | null;
  queue: readonly Item[];
  touched: Me['touched'];
  mine: ActivityDoc | null;
  /** Updates since the person last opened news, and what news will show. */
  count: number;
  unseen: readonly Input[];
  /** What `read since` answers: what reached the room since my Claude last read it. */
  since: readonly Input[];
  shown: string;
  /** Lines drawn since the last prompt (follow-lines.ts toDraw). */
  drawn: number;
  /** Read the pointer again on the next poll. */
  recheck: boolean;
  /** The mechanics went with this conversation's first prompt. */
  told: boolean;
  /** A NAME.CODE title went out, so a leave clears it. */
  titled: boolean;
  /** The problems already said this session: each is one line (C3). */
  said: readonly string[];
}
export const fresh = (): Session => ({
  room: null, state: null, queue: [], touched: [], mine: null, count: 0, unseen: [], since: [], shown: '', drawn: 0, recheck: false, told: false,
  titled: false, said: [],
});
export const session: Session = fresh();

/** Whether the problem `key` is new this session, noting it: each is said in one line (C3). */
export function once(s: Session, key: string): boolean {
  if (s.said.includes(key)) return false;
  s.said = [...s.said, key];
  return true;
}

/** What the session knew of a room it is no longer in. */
export function forget(s: Session): void {
  Object.assign(s, { state: null, queue: [], mine: null, count: 0, unseen: [], since: [], shown: '' });
}
