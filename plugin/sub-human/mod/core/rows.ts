/**
 * plugin/sub-human/mod/core/rows.ts: which agents are the panel's rows, as pure functions. Owned here: lib/rows.ts
 * re-exports the agent types, and the module's row hooks (mod/rows.ts) start node only for a call or stop of one.
 *
 *   PARTICIPANT, ROOM_AGENT     the row agents' types (agents/participant.md, agents/room.md, plugin-namespaced)
 *   isRow(type) -> bool         type is one of them
 *   spawnedId(response) -> id|null   the agent id an Agent call's response names (tool_response.agentId)
 *   handbackFrom(text) -> id|null    the agent whose final report a delivery is (Claude Code's "[Subagent hand-back]"
 *                                    frame inside <agent-message from="ID">: cc CONTRACT subagent-handback-message)
 *   finishedFrom(text) -> id|null    the agent a task notification says finished (<task-notification> with
 *                                    <task-id>ID</task-id> and <status>completed</status>; the same CONTRACT entry)
 */
export const PARTICIPANT = 'sub-human:participant';
export const ROOM_AGENT = 'sub-human:room';

export const isRow = (type: unknown): boolean => type === PARTICIPANT || type === ROOM_AGENT;

export function spawnedId(response: unknown): string | null {
  const r = response && typeof response === 'object' ? response as { agentId?: unknown; agent_id?: unknown; data?: { agentId?: unknown } } : {};
  const id = r.agentId || r.agent_id || (r.data && r.data.agentId);
  return typeof id === 'string' && id ? id : null;
}

/** @cc [Subagent hand-back] The text below is the final report of a subagent this session delegated to.
 * @stability incidental */
const HANDBACK = /<agent-message from="([\w-]+)">\s*\[Subagent hand-back\]/;
export function handbackFrom(text: unknown): string | null {
  const m = HANDBACK.exec(String(text ?? ''));
  return m ? m[1] : null;
}

const FINISHED = /^\s*<task-notification>\s*<task-id>([\w-]+)<\/task-id>[\s\S]*?<status>(?:completed|failed|killed)<\/status>/;
export function finishedFrom(text: unknown): string | null {
  const m = FINISHED.exec(String(text ?? ''));
  return m ? m[1] : null;
}
