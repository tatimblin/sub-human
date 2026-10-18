// The shapes the hooks share: what a hook reads on stdin and what it writes. Types only (import type); the hook
// inputs come from Claude Code's own declarations ('claude-code'), the store records from lib/ (a seat: identity.ts
// Identity; a member: room/types.ts Member; cards, proposals, reviews and notes: types-app.ts).
import type { BaseHookInput, ClassicHookInputs } from 'claude-code';
import type { Entry } from '../lib/room/types.ts';
import type { Answer, Pinned } from '../lib/commands/types.ts';

/** A classic hook event's name (PreToolUse, Stop, ...). */
export type HookEvent = keyof ClassicHookInputs;

/** A classic hook's stdin as parsed: every field may be missing (hand runs, the tests and the shim send partial
 * payloads), so each is checked before use. */
export type HookIn<E extends HookEvent> = Partial<ClassicHookInputs[E]>;

/** Any hook's stdin, read by a script several events run (consent.ts): the fields it reads, every one optional. */
export type AnyHookIn = Partial<BaseHookInput> & {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  stop_hook_active?: boolean;
  /** PostToolUseFailure: the error as the model read it */
  error?: string;
  /** the module's PreToolUse(ExitPlanMode) payload: the person had typed text in the prompt (PromptHint isDraft) */
  sub_human_typing?: boolean;
  /** the module's PlanAttachment payload (mod/consent.ts: the plan_mode attachment's detail): the session's plan file */
  plan_file_path?: string;
  agent_type?: string;
  source?: string;
};

/** UserPromptSubmit as hooks/handlers/prompt.ts hands it on: the payload plus what mod/prompt.ts adds (the prompt's origin and
 * the session's nonce; at-room believes the origin only with the nonce). */
export type PromptIn = HookIn<'UserPromptSubmit'> & { sub_human_origin?: unknown; sub_human_nonce?: unknown };

/** UserPromptExpansion as join.ts reads it: the payload plus what mod/core/command.ts joinPayload adds. */
export type JoinIn = HookIn<'UserPromptExpansion'> & { sub_human_via?: unknown; sub_human_nonce?: unknown; sub_human_take?: unknown; agent_type?: string };

/** hookSpecificOutput, for every event the hooks answer. */
export interface HookSpecificOutput {
  hookEventName: string;
  additionalContext?: string;
  sessionTitle?: string;
  suppressOriginalPrompt?: boolean;
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
  updatedInput?: unknown;
  decision?: unknown;
}

/** What the hooks report to the module beside a classic output (mod/core/shim.ts, mod/core/command.ts). */
export interface SubHumanReport {
  say?: string;
  refused?: boolean;
  shareable?: boolean;
  joined?: boolean;
  reviewOpen?: boolean;
  /** consent: a note of the seat waits for its card (the module then sends a room post to consent) */
  noteWaits?: boolean;
  /** consent, for a plan_mode attachment: a line the module appends to the attachment's text (a room plan edit's seed) */
  attach?: string;
  /** an invite's line and PIN for the module's status line (never saved in the transcript) and how long it stays;
   * say then holds the text without them */
  pinned?: PinnedReport;
  /** join: run by the module (sub_human_via "command.run") with a nonce this session's lease does not hold: nothing
   * ran; the module says hello again (which rewrites the lease) and asks once more */
  lease?: 'stale';
}

/** An invite's pinned form as the module gets it: lib/commands/types.ts Pinned, less the text (say holds it). cut: the
 * notice text when short is pinned in place of status (a terminal narrower than status). */
export type PinnedReport = Omit<Pinned, 'text'>;

/** One JSON output line of a command hook. */
export interface HookOutput {
  decision?: 'block';
  reason?: string;
  continue?: boolean;
  stopReason?: string;
  systemMessage?: string;
  hookSpecificOutput?: HookSpecificOutput;
  subHuman?: SubHumanReport;
}

/**
 * What a handler answers (hooks/run.ts renders it at the edge: hooks/reply.ts render). The first four are the /sub-human
 * join's: a lib/commands/types.ts Answer (the one source of their kinds and fields) as it leaves the handler. module:
 * the hooks module ran it (join.ts checked the nonce), so the answer goes back as {subHuman}, which the module draws
 * itself; else Claude Code ran the hooks.json entry and reads it as a classic block or expansion.
 *   say      what the person asked for (help, who is here, done); shareable: it may be the command's output row
 *   refused  a refusal of a prompt that holds no secret ("✗ " before it)
 *   secret   only the person may read it (an invite, anything a PIN-shaped prompt gets): the typed prompt is kept out of
 *            the conversation as well; refused (default true) puts "✗ " before it
 *   joined   a seat taken: the Answer's me and lead become context, the mechanics block for the model; say the line
 *            for the person; warn what a classic answer shows as a systemMessage (the room's Claude did not start,
 *            bypass-permissions mode)
 *   classic  any other hook's answer as a command hook gives it: its JSON lines, exit code (2 blocks) and stderr
 */
export type Reply =
  | (Extract<Answer, { kind: 'say' | 'refused' | 'secret' }> & { module: boolean })
  | (Omit<Extract<Answer, { kind: 'joined' }>, 'me' | 'lead'> & { context: string; warn?: string | null; module: boolean })
  | { kind: 'classic'; outputs?: object[]; exit?: number; stderr?: string };

/** A hooks/handlers/<name>.ts module, as hooks/run.ts loads it, for its stdin type I. handle: the answer (or out()
 * lines and nothing); fail: the answer after a throw, or a stdin that does not parse (raw is what came, input {});
 * without it the hook exits 1. Properties, not methods, so a module's own input type is checked against I. */
export interface Handler<I> {
  handle: (input: I, raw: string) => Reply | null | void | Promise<Reply | null | void>;
  fail?: (err: unknown, input: I, raw: string) => Reply | null | void;
}

/** The fields every hook payload may carry (BaseHookInput, and hook_event_name), as hooks/run.ts checks them: each
 * one present is a string. A handler's own fields are its input type's (each checked before use). */
export interface HookBase {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt_id?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  hook_event_name?: string;
}

/** A card option and question, as AskUserQuestion takes them and as a call's input or response may carry them
 * (untrusted: each field checked). */
export interface CardOption { label?: unknown; description?: unknown; preview?: unknown }
export interface CardQuestion { question?: unknown; header?: unknown; multiSelect?: unknown; options?: CardOption[] }
/** lib/proposal.ts answer, then decide: what consent's record() hands back. failed: a RoomError (the link to the host
 * is down); unknown: the answer went out and may still land. */
export type Recorded =
  | { stale: true; why: string; entry?: undefined; decision?: undefined; failed?: undefined; unknown?: undefined }
  | { entry: Entry; decision: Entry | null; stale?: undefined; failed?: undefined; unknown?: undefined }
  | { failed: string; unknown?: true; stale?: undefined; entry?: undefined; decision?: undefined };

/** An Agent / Task call's input as the row hooks read it (untrusted: each field checked). */
export interface AgentCall { subagent_type?: unknown; prompt?: unknown; description?: unknown; name?: unknown }

/** A tool event's stdin with its tool_input read as T. */
export type WithToolInput<E extends HookEvent, T> = Omit<HookIn<E>, 'tool_input'> & { tool_input?: T };
