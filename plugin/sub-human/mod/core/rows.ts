/**
 * plugin/sub-human/mod/core/rows.ts: which agents are the panel's rows, as pure functions. Owned here: lib/rows.ts
 * re-exports the agent types, and the module's row hooks (mod/rows.ts) start node only for a call or stop of one.
 *
 *   PARTICIPANT, ROOM_AGENT     the row agents' types (agents/participant.md, agents/room.md, plugin-namespaced)
 *   isRow(type) -> bool         type is one of them
 *   spawnedId(response) -> id|null   the agent id an Agent call's response names (tool_response.agentId)
 *   handbackFrom(text) -> id|null    the agent whose final report a delivery is (Claude Code's "[Subagent hand-back]"
 *                                    frame inside <agent-message from="ID">: cc CONTRACT subagent-handback-message)
 *   rowReportFrom(text) -> id|null   the agent whose hand-back is a room row's own last word (its report is exactly
 *                                    `left` or `error`, agents/room.md and participant.md): a row this process never saw
 *                                    spawned (the agent view's fork, or a reload) still ends without a turn
 *   finishedFrom(text) -> id|null    the agent a task notification says finished (<task-notification> with
 *                                    <task-id>ID</task-id> and <status>completed</status>; the same CONTRACT entry)
 *   ROWS_DOWN, rowsToSay(held, up) -> text|null   what a typed prompt carries for the rows: the held rows calls while
 *                                    the room server is connected (a row agent's only tool is its hold), else ROWS_DOWN,
 *                                    so a row that cannot start is not asked for again and again (live 2026-10-17: with
 *                                    the server held back, every participant spawn was refused for zero tools and the
 *                                    calls came back with each prompt); mod/prompt.ts says each text once
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
  return m?.[1] ?? null; // the group always matches when m does
}

/** The report inside a hand-back's frame (the harness indents each of its lines) is exactly a row's last word. */
const ROW_REPORT = /<agent-message from="([\w-]+)">\s*\[Subagent hand-back\][^\n]*\n\s*(left|error)\s*<\/agent-message>/;
export function rowReportFrom(text: unknown): string | null {
  const m = ROW_REPORT.exec(String(text ?? ''));
  return m?.[1] ?? null; // the group always matches when m does
}

const FINISHED = /^\s*<task-notification>\s*<task-id>([\w-]+)<\/task-id>[\s\S]*?<status>(?:completed|failed|killed)<\/status>/;
export function finishedFrom(text: unknown): string | null {
  const m = FINISHED.exec(String(text ?? ''));
  return m?.[1] ?? null; // the group always matches when m does
}

/** Said once, instead of the rows calls, while the room server is not connected in this session. */
export const ROWS_DOWN = "SUB-HUMAN ROWS: the room's tools (plugin:sub-human:room) are not connected in this session, so its room row cannot start: don't spawn it. Tell the person once: /mcp reconnects plugin:sub-human:room. SendMessage to other Claudes and @room still work.";

export const rowsToSay = (held: string | null, up: boolean): string | null => (held ? (up ? held : ROWS_DOWN) : null);
