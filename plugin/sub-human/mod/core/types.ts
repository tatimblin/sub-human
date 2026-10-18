/**
 * plugin/sub-human/mod/core/types.ts: the shapes the hooks module's files share (types only: import type). What the
 * pure functions take is what they are handed in node too (the tests), so a field read from a child's output or an
 * engine event is `unknown` until checked.
 */
import type { ClassicResult, PluginState, ProcessRunResult } from 'claude-code';
import type { TailEvent as TailLine, TailSeat as TailLineSeat } from '../../lib/types-app.ts';
import type { HookOutput, HookSpecificOutput, PinnedReport, SubHumanReport } from '../../hooks/types.ts';

/** A shape the hooks write, as the module reads it back from a child's stdout: every field there may be missing or of
 * another type, so each is `unknown` until checked. The one source of each shape stays where it is written
 * (hooks/types.ts); this is a view of it, never a copy. */
export type Loose<T> = { [K in keyof T]?: unknown };

/** The hello as $.state keeps it (types/index.d.ts SubHumanHello; mod/core/seat.ts parseHello). */
export type Hello = PluginState['sub-human']['hello'];
/** The seat a hello names. */
export type HelloSeat = NonNullable<Hello['seat']>;

/** $.process.run's answer, as the pure functions read it (the tests hand in only these fields). */
export type RunOutput = Partial<Pick<ProcessRunResult, 'exitCode' | 'stdout' | 'stderr'>>;

/** The ClassicResult fields a shimmed command hook's output becomes (mod/core/shim.ts toClassic). */
export type ShimResult = Pick<ClassicResult,
  'block' | 'preventContinuation' | 'stopReason' | 'additionalContext' | 'sessionTitle' | 'suppressOriginalPrompt'>;

/** A command hook's stdout line, parsed (untrusted: each field checked): hooks/types.ts HookOutput, loose, and a
 * top-level sessionTitle (another plugin's hook may put it there). */
export type HookJson = Loose<HookOutput> & { sessionTitle?: unknown };

/** hookSpecificOutput of such a line, as read. */
export type HookJsonSpecific = Loose<Pick<HookSpecificOutput, 'additionalContext' | 'sessionTitle' | 'suppressOriginalPrompt'>>;

/** What a shimmed hook reports to the module beside its output (hooks/types.ts SubHumanReport), as read. */
export type SubHumanRead = Loose<SubHumanReport>;

/** A prompt's origin as the pure functions read it (PromptOrigin: its kind, and a plugin's name). */
export interface OriginLike { kind?: unknown; name?: unknown }

/** The store guard's context (mod/core/guard.ts): every field optional; an unknown home leaves the string rules. */
export interface GuardCtx {
  home?: string | null;
  realHome?: string | null;
  userHome?: string | null;
  pluginRoot?: string | null;
  realPluginRoot?: string | null | undefined;
  cwd?: string | null;
  realCwd?: string | null | undefined;
  /** Claude Code's directory (CLAUDE_CONFIG_DIR, else ~/.claude): its history.jsonl and this session's transcript */
  claudeDir?: string | null;
  /** this session's id: its transcript is projects/<any>/<sid>.jsonl */
  sid?: string | null;
}

/** A tail child's seat event's seat, as parseEvent checks it: its name and code (lib/tail.ts sends role and addr too). */
export type TailSeat = Pick<TailLineSeat, 'name' | 'code'> & Partial<Omit<TailLineSeat, 'name' | 'code'>>;

/** A tail child's ndjson event, parsed (mod/core/deliver.ts parseEvent): lib/tail.ts's TailEvent, the seat as checked.
 * A type-only import, erased when Claude Code or node loads this file. */
export type TailEvent = Exclude<TailLine, { type: 'seat' }> | { type: 'seat'; seat: TailSeat | null };

/** A command hook's stdin as the module builds it (the shim hands it to hooks/run.ts): the fields every one carries. */
interface PayloadBase { hook_event_name: string; session_id: unknown; cwd?: string; transcript_path?: string; permission_mode?: string }
/** classic.PreToolUse's e as a command hook's stdin (mod/core/facts.ts prePayload). */
export interface PrePayload extends PayloadBase { tool_name: unknown; tool_input: Record<string, unknown>; tool_use_id: unknown; agent_id?: string }
/** A refused ExitPlanMode as the PostToolUseFailure stdin consent reads (mod/core/facts.ts rejectedPayload). */
export interface RejectedPayload extends PayloadBase { tool_name: string; tool_input: Record<string, never>; tool_use_id: unknown; error: string }
/** /sub-human run by the module, as the UserPromptExpansion stdin join.ts reads (mod/core/command.ts joinPayload;
 * hooks/types.ts JoinIn). */
export interface JoinPayload {
  hook_event_name: string; session_id: unknown; cwd: unknown; expansion_type: string; command_name: string; command_args: string;
  command_source: string; sub_human_via: string; sub_human_nonce: unknown; permission_mode?: string; sub_human_take?: string;
}

/** One $ call an event maps to (mod/core/deliver.ts route). */
export type DeliverAction =
  | { do: 'log' | 'append' | 'mid-turn-wake' | 'hold-pull'; text: string }
  | { do: 'submit'; text: string; seen: string[] }
  | { do: 'hold-rows'; text: string | null }
  | { do: 'seat'; seat: TailSeat | null }
  | { do: 'invites'; open: string[] }
  | { do: 'take'; code: string; name: string; text: string; check?: string };

/** The room context waiting for the next prompt ($.state pulls, mod/core/deliver.ts holdPull): each pull event's lines
 * by id (the prompt that carried ids up to N clears them), and how many lines PULL_CAP left out. */
export interface Pulls { next: number; items: { id: number; lines: string[] }[]; dropped: number }

declare module 'claude-code' {
  interface BuiltinToolInputs {
    /** MultiEdit: gone from this build's tool list, still in older ones; the store guard matches it (mod/guard.ts). */
    MultiEdit: { file_path: string; edits: { old_string: string; new_string: string; replace_all?: boolean }[] };
  }
}

/** An invite on the status line (mod/core/command.ts readReply): hooks/types.ts PinnedReport as checked, its cut (the
 * notice text) split into lines: status, else short with the notices cut (a terminal narrower than status); ref, to
 * take it off once the invite is no longer open. */
export type PinnedStatus = Omit<PinnedReport, 'cut'> & { cut?: string[] };

/** join.ts's reply (hooks/reply.ts render of a lib/commands/types.ts Answer), as the module reads it back
 * (mod/core/command.ts readReply): its say or joined, a lease that did not hold (stale), or no answer (failed). */
export type JoinReply =
  | { kind: 'joined'; context: string; lines: string[] }
  | { kind: 'say'; lines: string[]; refused: boolean; shareable: boolean; pinned?: PinnedStatus }
  | { kind: 'stale'; lines: string[] }
  | { kind: 'failed'; lines: string[] };
