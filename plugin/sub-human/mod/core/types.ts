/**
 * plugin/sub-human/mod/core/types.ts: the shapes the hooks module's files share (types only: import type). What the
 * pure functions take is what they are handed in node too (the tests), so a field read from a child's output or an
 * engine event is `unknown` until checked.
 */
import type { ClassicResult, PluginState, ProcessRunResult, PromptSubmitResult } from 'claude-code';

/** The hello as $.state keeps it (types/index.d.ts SubHumanHello; mod/core/seat.ts parseHello). */
export type Hello = PluginState['sub-human']['hello'];
/** The seat a hello names. */
export type HelloSeat = NonNullable<Hello['seat']>;

/** $.process.run's answer, as the pure functions read it (the tests hand in only these fields). */
export type RunOutput = Partial<Pick<ProcessRunResult, 'exitCode' | 'stdout' | 'stderr'>>;

/** The ClassicResult fields a shimmed command hook's output becomes (mod/core/shim.ts toClassic). */
export type ShimResult = Pick<ClassicResult,
  'block' | 'preventContinuation' | 'stopReason' | 'additionalContext' | 'sessionTitle' | 'suppressOriginalPrompt'>;

/** A command hook's stdout line, parsed (untrusted: each field checked). */
export interface HookJson {
  decision?: unknown;
  reason?: unknown;
  continue?: unknown;
  stopReason?: unknown;
  systemMessage?: unknown;
  sessionTitle?: unknown;
  hookSpecificOutput?: unknown;
  subHuman?: unknown;
}

/** hookSpecificOutput of such a line, as read. */
export interface HookJsonSpecific { additionalContext?: unknown; sessionTitle?: unknown; suppressOriginalPrompt?: unknown }

/** What a shimmed hook reports to the module beside its output (hooks/types.ts SubHumanReport), as read. */
export interface SubHumanReport { say?: unknown; refused?: unknown; shareable?: unknown; joined?: unknown; reviewOpen?: unknown }

/** A prompt's origin as the pure functions read it (PromptOrigin: its kind, and a plugin's name). */
export interface OriginLike { kind?: unknown; name?: unknown }

/** The store guard's context (mod/core/guard.ts): every field optional; an unknown home leaves the string rules. */
export interface GuardCtx {
  home?: string | null;
  realHome?: string | null;
  userHome?: string | null;
  pluginRoot?: string | null;
  realPluginRoot?: string | null;
  cwd?: string | null;
  realCwd?: string | null;
}

/** A tail child's seat event's seat (lib/tail.ts). */
export interface TailSeat { name: string; code: string; role?: string }

/** A tail child's ndjson event, parsed (mod/core/deliver.ts parseEvent). */
export type TailEvent =
  | { type: 'seat'; seat: TailSeat | null }
  | { type: 'chat'; lines: string[] }
  | { type: 'rows'; text: string | null }
  | { type: 'pull' | 'wake' | 'health'; text: string };

/** One $ call an event maps to (mod/core/deliver.ts route). */
export type DeliverAction =
  | { do: 'log' | 'append' | 'mid-turn-wake'; text: string }
  | { do: 'submit'; text: string; seen: string[] }
  | { do: 'relay'; lines: string[] }
  | { do: 'hold-rows'; text: string | null }
  | { do: 'seat'; seat: TailSeat | null };

/** What a relay needs of a hook's $, as plain functions (no $ crosses an import): mod/deliver.ts queueRelay. */
export interface RelayIo {
  now: () => Promise<number>;
  after: (ms: number, fn: () => void) => unknown;
  submit: (text: string) => Promise<PromptSubmitResult>;
  log: (text: string) => unknown;
}

declare module 'claude-code' {
  interface BuiltinToolInputs {
    /** MultiEdit: gone from this build's tool list, still in older ones; the store guard matches it (mod/guard.ts). */
    MultiEdit: { file_path: string; edits: { old_string: string; new_string: string; replace_all?: boolean }[] };
  }
}

/** join.ts's reply, read (mod/core/command.ts readReply). */
export type JoinReply =
  | { kind: 'joined'; context: string; lines: string[] }
  | { kind: 'say'; lines: string[]; refused: boolean; shareable: boolean }
  | { kind: 'failed'; lines: string[] };
