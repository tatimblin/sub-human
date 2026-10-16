/**
 * plugin/sub-human/mod/core/facts.ts: what a classic.PreToolUse hook needs that its event does not carry. Its `e` is the
 * tool call alone (ToolCallEnvelope: tool, tool_use_id, the arguments), while the command hook it stands in for read
 * session_id, transcript_path, permission_mode and agent_id from its stdin. So the module keeps them, as pure state:
 *   - per session id, the transcript path and permission mode of the last main-loop classic event that carried them
 *     (UserPromptSubmit, PostToolUse, Stop, SessionStart, ...: noteEvent);
 *   - per tool_use_id, the agentId its tool.call carried, while that call runs (tool.call fires above classic.PreToolUse,
 *     which runs inside its next: stashAgent, agentOf, dropAgent).
 * A permission mode can be stale: the person changed it (shift+tab) mid-turn with no event since. Unknown is undefined,
 * and the hook then reads it as it reads a missing field (consent: no review opens).
 * prePayload(e, facts) builds the classic PreToolUse payload from these.
 */
import type { PrePayload, RejectedPayload } from './types.ts';

/** A classic event's fields, as noteEvent reads them. */
type EventLike = { session_id?: unknown; transcript_path?: unknown; permission_mode?: unknown; agent_id?: unknown } | null | undefined;
/** What is known of a session. */
export interface SessionFacts { transcript_path?: string; permission_mode?: string }

/** A session's facts, and the agentIds of the calls that run (factsBook). */
export interface FactsBook {
  noteEvent(e: EventLike): void;
  of(sid: unknown): SessionFacts;
  stashAgent(toolUseId: unknown, agentId: unknown): void;
  agentOf(toolUseId: unknown): string | undefined;
  dropAgent(toolUseId: unknown): void;
}

export function factsBook(maxAgents = 64): FactsBook {
  const bySid = new Map<string, SessionFacts>();
  const agents = new Map<string, string>();
  return {
    /** A main-loop classic event's transcript path and mode (a subagent's, with agent_id, is its own loop's). */
    noteEvent(e: EventLike): void {
      if (!e || typeof e.session_id !== 'string' || e.agent_id !== undefined) return;
      const cur = bySid.get(e.session_id) || {};
      const next: SessionFacts = { ...cur };
      if (typeof e.transcript_path === 'string' && e.transcript_path) next.transcript_path = e.transcript_path;
      if (typeof e.permission_mode === 'string' && e.permission_mode) next.permission_mode = e.permission_mode;
      bySid.set(e.session_id, next);
      if (bySid.size > 8) bySid.delete(bySid.keys().next().value as string); // a few session ids per process (/clear)
    },
    of: (sid: unknown): SessionFacts => (typeof sid === 'string' && bySid.get(sid)) || {},
    stashAgent(toolUseId: unknown, agentId: unknown): void {
      if (typeof toolUseId !== 'string' || typeof agentId !== 'string') return;
      agents.set(toolUseId, agentId);
      if (agents.size > maxAgents) agents.delete(agents.keys().next().value as string);
    },
    agentOf: (toolUseId: unknown): string | undefined => (typeof toolUseId === 'string' ? agents.get(toolUseId) : undefined),
    dropAgent(toolUseId: unknown): void { if (typeof toolUseId === 'string') agents.delete(toolUseId); },
  };
}

/** An ExitPlanMode the person refused, as the PostToolUseFailure payload consent reads (hooks/handlers/consent.ts
 * rejectedExit): the refusal's text as `error`; the mode is plan (the dialog was the plan view). */
export function rejectedPayload(e: { tool_use_id?: unknown }, { sid, cwd, facts, text }: { sid: unknown; cwd?: unknown; facts: SessionFacts; text: string }): RejectedPayload {
  return {
    hook_event_name: 'PostToolUseFailure', session_id: sid, ...(typeof cwd === 'string' ? { cwd } : {}),
    ...(facts.transcript_path ? { transcript_path: facts.transcript_path } : {}), permission_mode: 'plan',
    tool_name: 'ExitPlanMode', tool_input: {}, tool_use_id: e.tool_use_id, error: text,
  };
}

/** The keys a tool call carries beside the tool's own arguments (ToolCallReserved, AgentLoop). */
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent']);

/** classic.PreToolUse's e as the command hook's stdin: hook_event_name, session_id, cwd, transcript_path, permission_mode
 * and agent_id as known, tool_name, tool_input (the arguments), tool_use_id. */
export function prePayload(
  e: { tool?: unknown; tool_use_id?: unknown; [k: string]: unknown },
  { sid, cwd, facts, agentId }: { sid: unknown; cwd?: unknown; facts: SessionFacts; agentId?: string | undefined },
): PrePayload {
  const tool_input = Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.has(k)));
  return {
    hook_event_name: 'PreToolUse', session_id: sid, ...(typeof cwd === 'string' ? { cwd } : {}),
    ...(facts.transcript_path ? { transcript_path: facts.transcript_path } : {}),
    ...(facts.permission_mode ? { permission_mode: facts.permission_mode } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    tool_name: e.tool, tool_input, tool_use_id: e.tool_use_id,
  };
}
