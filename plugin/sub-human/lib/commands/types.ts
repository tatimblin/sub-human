/**
 * plugin/sub-human/lib/commands/types.ts: the shapes of the /sub-human command table (lib/commands/index.ts). Types
 * only (import type).
 */
import type { Identity } from '../identity.ts';
import type { RoomCode, SeatName } from '../brand.ts';

/**
 * What a verb answers. The join hook (hooks/handlers/join.ts) turns it into the hook's one Reply (hooks/types.ts):
 *   say      what the person asked for (help, who is here, done)
 *   refused  a refusal ("✗ " before it)
 *   secret   only the person may read it (an invite with its PIN): the typed prompt is kept out of the conversation;
 *            refused (default false) puts "✗ " before it; pinned: the line and the PIN apart, for the module (Pinned)
 *   joined   a seat taken: me, lead (the mechanics block's last line) and say (the person's one line)
 * The router (index.ts run) makes every say and refused of a prompt that may hold a PIN a secret, before any verb ran.
 */
export type Answer =
  | { kind: 'say'; text: string }
  | { kind: 'refused'; text: string }
  | { kind: 'secret'; text: string; refused?: boolean; pinned?: Pinned }
  | { kind: 'joined'; me: Identity; lead: string; say: string };

/** An invite's secret part, for the hooks module to draw where Claude Code saves nothing ($.ui.status, under the prompt):
 * status, the one line "PIN 4090 · <the invite line>"; text, what the notices say instead (no secret in it); ms, how
 * long the status stays (the invite's life). When status is wider than the terminal (the module knows its width),
 * short ("PIN 4090 · SECRET <word>") is pinned instead and cut is the notice text: the line with SECRET in place of
 * the word. ref: the invite's, so the module takes it off once the invite is used, burnt or cancelled. The classic
 * hook still shows the whole text (Answer secret's text). */
export interface Pinned { status: string; text: string; ms: number; short?: string; cut?: string; ref?: string }

/** What every verb is handed. pid and cur are known only once the hooks module's lease checked (the verbs marked
 * `open` run before: help, doctor). */
export interface VerbCtx {
  /** the session id the prompt came from */
  sid: string | undefined;
  /** the session's working directory */
  cwd: string;
  /** the session's claude process */
  pid: number;
  /** the seat this session holds now, or null */
  cur: Identity | null;
  /** the session runs the room's Claude agent (agent_type sub-human:room-claude) */
  roomClaudeAgent: boolean;
  /** the seat key's public half for a seat about to be taken (hooks/seat-key.ts publicPem; only the join hook loads it) */
  pubkey(code: RoomCode, name: SeatName): string;
  /** this process runs as the plugin's hook: the root of scripts/sub-human (doctor runs it) */
  pluginRoot: string;
  /** the hooks module seats the join the host let in to this room on its own (bare only; join.ts bare) */
  take?: RoomCode;
}

/** One verb: its words after the verb, and the context. */
export type Verb = (args: string[], ctx: VerbCtx) => Answer;
/** A verb that runs before the hooks module's lease is checked: it reads nothing of the session. */
export type OpenVerb = (args: string[], ctx: Pick<VerbCtx, 'cwd' | 'pluginRoot'>) => Answer;
