// The shapes the hooks share: what a hook reads on stdin, what it writes, and the store records it handles.
// Types only (import type); the hook inputs come from Claude Code's own declarations ('claude-code').
import type { BaseHookInput, ClassicHookInputs } from 'claude-code';

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

/** A seat (lib/identity.ts seat()): who a hook runs for. */
export interface Seat {
  code: string;
  name: string;
  role: string;
  /** undefined only for a seat taken back from a payload that carried none (hooks/session-restore.ts) */
  session_id?: string | null;
  pid: number;
  address: string;
}

/** A room member's record (lib/identity.ts readMembers values): the fields the hooks read. */
export interface MemberRec {
  name: string;
  role?: string;
  left_at?: string | null;
  pid?: number;
  session_id?: string | null;
}

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
/** A card the hooks build (lib/proposal.ts, lib/handoff.ts, lib/remote/admission.ts). */
export interface Card { questions: { question: string; options: { label: string; description: string }[] }[] }

/** A proposal pending for a seat (lib/proposal.ts pendingFor). */
export interface PendingProposal { id?: number; hash: string; approvers?: string[]; path?: string; from?: string | null }

/** A note waiting for the person's Send (lib/proposal.ts readConfirm). */
export interface ConfirmNote { hash: string; note: string; from: string | null; title: string | null; at: number; asked?: number }

/** The plan-view review's state (members/NAME/review.json, lib/proposal.ts readReview). */
export interface ReviewState {
  phase: 'entering' | 'shown' | 'exiting' | 'restore';
  mode?: string;
  at?: number;
  hash?: string;
  from?: string | null;
  file?: string;
  backup?: string | null;
  restored?: boolean;
  tool_use_id?: string | null;
  said?: string;
  resolved?: boolean;
  foreign?: boolean;
  card?: string;
}

/** lib/proposal.ts answer, then decide: what record() hands back. */
export interface Recorded { stale?: boolean; failed?: string; unknown?: boolean; decision?: { text: string } | null }

/** An Agent / Task call's input as the row hooks read it (untrusted: each field checked). */
export interface AgentCall { subagent_type?: unknown; prompt?: unknown; description?: unknown; name?: unknown }

/** A tool event's stdin with its tool_input read as T. */
export type WithToolInput<E extends HookEvent, T> = Omit<HookIn<E>, 'tool_input'> & { tool_input?: T };
