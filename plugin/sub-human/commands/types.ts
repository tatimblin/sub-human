// What every /sub-human verb is handed and answers. The verbs write nothing themselves: each write is one call to the
// daemon (Daemon), and reads go through Rooms and Sessions, so a test hands them in over memory stores.
import type { Config } from '../config.js';
import type { Answers, Pointer, Request, Via } from '../core/api.js';
import type { DocKinds, Draft, RoomState } from '../core/entries.js';
import type { Result } from '../core/result.js';
import type { Membership } from './membership.js';

/** One line, or a few for help, who and doctor. A refusal says what didn't happen and one thing to do (R43). */
export type Answer = { readonly kind: 'say' | 'refused'; readonly text: string };
export const say = (text: string): Answer => ({ kind: 'say', text });
export const refused = (text: string): Answer => ({ kind: 'refused', text });

/** The documents a member writes about itself. */
export type MemberDoc = { [K in 'presence' | 'focus']: { readonly kind: K; readonly doc: DocKinds[K] } }['presence' | 'focus'];

/** The daemon's ops the commands use (core/api.ts), one function each. */
export interface Daemon {
  /** The host stamps the rest of the envelope; `id` is ours, so a retry with it is stored once. */
  append(code: string, draft: Draft, id: string): Promise<Result<unknown>>;
  putDoc(code: string, doc: MemberDoc): Promise<Result<unknown>>;
  /** The host's: `by` removes `name` for good, or the daemon says why not. */
  kick(code: string, name: string, by: string): Promise<Result<unknown>>;
  /** `join`: a bare /sub-human, the room picked and joined on the daemon's chain (core/api.ts). */
  join(req: Omit<Extract<Request, { op: 'join' }>, 'op'>): Promise<Result<Answers['join']>>;
  /** `leave`: `/sub-human leave`; `left` only when no other pointer or pending handoff holds the name. */
  leave(id: string): Promise<Result<unknown>>;
  /** `retire`: the session ended; its pointer goes and the member is away. Never a `left`. */
  retire(id: string): Promise<Result<unknown>>;
  /** `handoff`: for /clear and /resume, moves the pointer aside for the next session in `cwd`. */
  handoff(id: string, cwd: string): Promise<Result<unknown>>;
  /** `claim`: that next session takes a fresh handoff as its own pointer, or there is none. */
  claim(id: string, cwd: string): Promise<Result<Pointer | null>>;
  /** `invite`: a line for `name`, by `via`; the daemon starts the listener and its forward. */
  invite(code: string, from: string, name: string, via: Via): Promise<Result<Answers['invite']>>;
  /** `dial`: proves an invite line to its host; the host's answer comes later, in `link`. */
  dial(line: string, name: string): Promise<Result<Answers['dial']>>;
  /** `link`: how this machine's link to a room hosted elsewhere is doing, or null. */
  link(code: string): Promise<Result<Answers['link']>>;
  /** How many sessions' modules have pinged it. */
  status(): Promise<Result<{ readonly sessions: number }>>;
}

/** The rooms this home holds, read straight from the store. */
export interface Rooms {
  codes(): Promise<readonly string[]>;
  /** The room folded; an error when its log can't be read. */
  state(code: string): Promise<Result<RoomState>>;
}

/** This machine's session pointers, read straight from the home; the daemon writes them. */
export interface Sessions {
  get(id: string): Promise<Membership | null>;
  all(): Promise<readonly Membership[]>;
}

/** Runs a program (git) and answers its trimmed stdout, or null when it failed or isn't there. */
export type Run = (program: string, args: readonly string[], cwd: string) => Promise<string | null>;

export interface Ctx {
  readonly config: Config;
  readonly session: string;
  readonly cwd: string;
  readonly now: () => number;
  readonly random: () => number;
  /** A fresh UUID, for the ids of entries. */
  readonly uuid: () => string;
  readonly daemon: Daemon;
  readonly rooms: Rooms;
  readonly sessions: Sessions;
  readonly run: Run;
  /** A file of the plugin's own, by its path in the plugin, or null. */
  readonly readFile: (path: string) => Promise<string | null>;
  /** The node version running this, for doctor. */
  readonly nodeVersion: string;
}

export type Verb = (args: readonly string[], ctx: Ctx) => Promise<Answer>;
