// The shapes the hooks share: what a hook reads on stdin and what it writes. Types only (import type); the hook
// inputs come from Claude Code's own declarations ('claude-code'), the store records from lib/ (a seat: identity.ts
// Identity; a member: room/types.ts Member; cards, proposals, reviews and notes: types-app.ts).
import type { BaseHookInput, ClassicHookInputs } from 'claude-code';
import type { Entry } from '../lib/room/types.ts';

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
  agent_type?: string;
  source?: string;
};

/** UserPromptSubmit as hooks/prompt.ts hands it on: the payload plus what mod/prompt.ts adds (the prompt's origin and
 * the session's nonce; at-room believes the origin only with the nonce). */
export type PromptIn = HookIn<'UserPromptSubmit'> & { sub_human_origin?: unknown; sub_human_nonce?: unknown };

/** UserPromptExpansion as join.ts reads it: the payload plus what mod/core/command.ts joinPayload adds. */
export type JoinIn = HookIn<'UserPromptExpansion'> & { sub_human_via?: unknown; sub_human_nonce?: unknown; agent_type?: string };

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
}

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
