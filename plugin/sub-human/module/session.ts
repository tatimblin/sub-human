// What this session's module knows of its room: one object every part reads and writes as plain data (a `$` never
// leaves the hook that holds it, so the parts share this instead). follow.ts fills it; nothing here does I/O.
import type { Input, Item, Me, Wait } from '../core/deliver.js';
import type { ActivityDoc, RoomState } from '../core/entries.js';
import type { Gated } from '../config.js';
import type { LinkStatus, Pointer } from '../core/api.js';

/** The /room command's name in a prompt.submit, as Claude Code gives it. */
export const COMMAND: RegExp = /^(?:sub-human:)?room$/;

export interface InRoom {
  readonly home: string; readonly code: string; readonly name: string; readonly title: string;
  readonly dir: string;
  /** Where my work is: the repo's root (else the session's cwd), its name, branch and ignore text, read at the join. */
  readonly root: string; readonly repo?: string; readonly branch?: string; readonly ignore?: string;
  /** The session's plans folder, once an approved plan showed it: plan files there are no edits. */
  readonly plans?: string;
}
/** What this session's module knows of its room, shared by every part as plain data. */
export interface Session {
  room: InRoom | null;
  state: RoomState | null;
  queue: readonly Item[];
  touched: Me['touched'];
  mine: ActivityDoc | null;
  /** Messages held for the person (a command or URL) since they last opened news. */
  held: number;
  /** What reached the room, the newest FEED_MAX; `fed` counts all ever added, so a reader's place is a count. */
  feed: readonly Input[];
  fed: number;
  /** Where news (the person) and `read since` (my Claude) last read the feed to. */
  read: { news: number; since: number };
  shown: string;
  /** The plan versions this session's person asked people to agree on (R21a): plans.ts adds, deliver ends them. */
  waiting: readonly Wait[];
  /** Wake prompts deliver decided on, waiting for wake.ts to submit once the session is idle (R10). */
  wakes: readonly string[];
  /**
   * The main loop's turns started and ended (capture.ts), and when the last started: a turn is running while more
   * started than ended.
   */
  turns: { started: number; ended: number; at: number };
  /** Lines drawn since the last prompt (follow-lines.ts toDraw). */
  drawn: number;
  /** Read the pointer again on the next poll. */
  recheck: boolean;
  /** The mechanics went with this conversation's first prompt. */
  told: boolean;
  /** The NAME.CODE title this session was last given ('' for none): set again only when it changes (retitle). */
  titled: string;
  /** The problems already said this session: each is one line (C3). */
  said: readonly string[];
  /** The features SUB_HUMAN_CC_OFF turns off. */
  off: readonly Gated[];
  /** The room's host can't be reached (R34): its link is host_away or offline. */
  away: boolean;
  /** The room a /room join is waiting to be let into (R30), until its pointer appears or the link stops. */
  joining: string | null;
  /** My room is hosted on this machine (its link is none): only a host invites. */
  hosted: boolean;
  /** The room this session's /room just made, for the invite row's wording. */
  opened: string | null;
}
export const fresh = (): Session => ({
  room: null, state: null, queue: [], touched: [], mine: null, held: 0, feed: [], fed: 0, read: { news: 0, since: 0 }, shown: '', waiting: [], wakes: [], turns: { started: 0, ended: 0, at: 0 }, drawn: 0, recheck: false, told: false,
  titled: '', said: [], off: [], away: false, joining: null, hosted: false, opened: null,
});
export const session: Session = fresh();

/** What news and `read since` keep at most; the oldest go first. */
const FEED_MAX = 500;
export function feed(s: Session, items: readonly Input[]): void {
  s.feed = [...s.feed, ...items].slice(-FEED_MAX);
  s.fed += items.length;
}
/** The feed after `who` last read it. */
export function unread(s: Session, who: keyof Session['read']): readonly Input[] {
  return s.feed.slice(Math.max(0, s.feed.length - (s.fed - s.read[who])));
}

/** Whether the problem `key` is new this session, noting it: each is said in one line (C3). */
export function once(s: Session, key: string): boolean {
  if (s.said.includes(key)) return false;
  s.said = [...s.said, key];
  return true;
}

/** Whether SUB_HUMAN_CC_OFF turns `f` off. */
export function off(s: Session, f: Gated): boolean { return s.off.includes(f); }

/**
 * The one line a /room join under way ends with (R30): in, once the daemon wrote this session's pointer; or why
 * not, once the room's link stopped. Null while it waits, and for a session that joined some other way.
 */
export function joined(s: Session, p: Pointer | null, l: LinkStatus | null): string | null {
  const code = s.joining;
  if (code === null || (!p && l?.phase !== 'stopped')) return null;
  s.joining = null;
  // let in under another name, theirs being in the room from another machine: the link's status says so
  if (p) return p.code !== code ? null : l?.phase !== 'stopped' && l?.why ? `sub-human: ${l.why}.` : `You're in ${p.code} as ${p.name}.`;
  return `You did not join ${code}: ${l?.why ?? 'the host did not let you in'}.`;
}

/**
 * The title a prompt sets, from the one it arrived with (R6): NAME.CODE once it isn't the title this session was last
 * given (a join here), and '' once after a leave; only ever over no title or one of ours (the last we gave, or another
 * NAME.CODE), never over one the person chose, before the join or since. Messages don't need it: a send is resolved
 * by member name (messages.ts).
 */
export function retitle(s: Session, current: string | undefined): string | undefined {
  const want = s.room?.title ?? '';
  const last = s.titled;
  if (want === last) return undefined;
  s.titled = want;
  const ours = !current || current === last || OUR_TITLE.test(current);
  return ours ? want : undefined;
}
/** A title a join gives: NAME.CODE. */
const OUR_TITLE = /^\S+\.[a-z]+-\d{4}$/;

/** What the session knew of a room it is no longer in. */
export function forget(s: Session): void {
  Object.assign(s, { state: null, queue: [], mine: null, held: 0, feed: [], fed: 0, read: { news: 0, since: 0 }, shown: '', waiting: [], wakes: [], away: false, hosted: false });
}
