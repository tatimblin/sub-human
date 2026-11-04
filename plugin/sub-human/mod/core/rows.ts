/**
 * plugin/sub-human/mod/core/rows.ts: the room row (agents/room.md), as pure functions. Owned here: lib/rows.ts
 * re-exports the agent type; the module spawns the row itself (mod/deliver.ts roomRow: $.agent.spawn, never the
 * model's Agent call) and takes its end quietly (mod/rows.ts).
 *
 *   ROOM_AGENT, isRow(type)          the row agent's type (plugin-namespaced) and whether type is it
 *   roomRowFor(hello, sid) -> code|null   the room whose row this session wants: a member's seat of this session id,
 *                                    the verdict's room-row on (mod/core/cc.ts GATED); null for the room session, no
 *                                    seat, another session's hello
 *   liveRow(agents, code, skip) -> id|null   room code's row that $.agent.list still runs (any status but completed,
 *                                    failed, killed), past the ids in skip
 *   rowSpawn(code)                   $.agent.spawn's input: description the room code (the row's label), prompt
 *                                    "room: CODE"
 *   spawnStep(ledger, code, now) -> {spawn, ledger}   whether a spawn may go now: one at a time per room, at most one
 *                                    each ROW_RESPAWN_MS and ROW_SPAWNS_MAX in a row, so a row that dies at once
 *                                    never loops; spawnDone(ledger, code, started) ends one (one that started nothing
 *                                    may go again at once); spawnLived (the row found live: the count starts over);
 *                                    spawnForget (the seat changed: the room's ledger goes)
 *   handbackFrom(text) -> id|null    the agent whose final report a delivery is (Claude Code's "[Subagent hand-back]"
 *                                    frame inside <agent-message from="ID">: cc CONTRACT subagent-handback-message)
 *   rowReportFrom(text) -> id|null   the agent whose hand-back is the room row's own last word (its report is exactly
 *                                    `left` or `error`, agents/room.md): a row this process never saw spawned (the
 *                                    agent view's fork, or a reload) still ends without a turn
 *   finishedFrom(text) -> id|null    the agent a task notification says finished (<task-notification> with
 *                                    <task-id>ID</task-id> and <status>completed</status>; the same CONTRACT entry)
 */
import { QUIET_ROW } from './constants.ts';
import type { Hello } from './types.ts';

export const ROOM_AGENT = 'sub-human:room';

export const isRow = (type: unknown): boolean => type === ROOM_AGENT;

export function roomRowFor(hello: Hello | null | undefined, sid: unknown): string | null {
  if (!hello || typeof sid !== 'string' || hello.sid !== sid || !hello.seat || hello.seat.role === 'claude') return null;
  if (hello.cc && hello.cc.off.includes('room-row')) return null;
  return hello.seat.code;
}

/** The statuses of an agent that no longer runs ($.agent.list keeps it listed a while). */
const ENDED = new Set(['completed', 'failed', 'killed']);
/** The room row of room code that $.agent.list still runs (its description is the code: rowSpawn), past the ids in
 * skip (rows listed before a spawn: not the one it started). A row of another room (the seat changed) is not it. */
export function liveRow(agents: readonly { id: string; type: string; status: string; description?: string }[], code: string, skip: ReadonlySet<string> = new Set()): string | null {
  return agents.find(a => a.type === ROOM_AGENT && a.description === code && !ENDED.has(a.status) && !skip.has(a.id))?.id ?? null;
}

export const rowSpawn = (code: string): { subagentType: string; description: string; prompt: string } => ({ subagentType: ROOM_AGENT, description: code, prompt: `room: ${code}` });

export const ROW_RESPAWN_MS = 60_000;
export const ROW_SPAWNS_MAX = 5;
/** Per room: the spawns this process made, the last one's time, and whether one is under way. */
export type SpawnLedger = Readonly<Record<string, { n: number; at: number; busy: boolean } | undefined>>;
export function spawnStep(ledger: SpawnLedger, code: string, now: number): { spawn: boolean; ledger: SpawnLedger } {
  const cur = ledger[code] ?? { n: 0, at: -Infinity, busy: false };
  if (cur.busy || cur.n >= ROW_SPAWNS_MAX || now - cur.at < ROW_RESPAWN_MS) return { spawn: false, ledger };
  return { spawn: true, ledger: { ...ledger, [code]: { n: cur.n + 1, at: now, busy: true } } };
}
/** The spawn under way for code is over; one that started no row (refused, failed) may be tried again at once (it
 * still counts toward ROW_SPAWNS_MAX). */
export function spawnDone(ledger: SpawnLedger, code: string, started = true): SpawnLedger {
  const cur = ledger[code];
  return cur ? { ...ledger, [code]: { ...cur, busy: false, ...(started ? {} : { at: -Infinity }) } } : ledger;
}
/** A turn start found code's row live: it did not die at once, so its spawns count from none again (the cap is for
 * rows that die quickly). */
export function spawnLived(ledger: SpawnLedger, code: string): SpawnLedger {
  const cur = ledger[code];
  return cur && cur.n ? { ...ledger, [code]: { ...cur, n: 0 } } : ledger;
}
/** The seat changed (a leave, a take): code's ledger starts over. */
export function spawnForget(ledger: SpawnLedger, code: string): SpawnLedger {
  if (!(code in ledger)) return ledger;
  const { [code]: _gone, ...rest } = ledger;
  return rest;
}

/** @cc [Subagent hand-back] The text below is the final report of a subagent this session delegated to.
 * @stability incidental */
const HANDBACK = /<agent-message from="([\w-]+)">\s*\[Subagent hand-back\]/;
export function handbackFrom(text: unknown): string | null {
  const m = HANDBACK.exec(String(text ?? ''));
  return m?.[1] ?? null; // the group always matches when m does
}

/** The report inside a hand-back's frame (the harness indents each of its lines) is exactly the row's last word. */
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

/** Why a row's hand-back or "finished" notification starts no turn: mod/rows.ts's prompt.submit drop reason. */
export const ROW_ENDED = 'sub-human: row ended, nothing to do';
/** @cc Prompt dropped by a hook
 * How Claude Code draws a prompt.submit drop between turns: a warning row "Prompt dropped by a hook: <reason>"
 * (CONTRACT ups-stop-frame; mid-turn it is a toast and no row). @stability incidental */
export const DROP_FRAME = 'Prompt dropped by a hook: ';
/** What that row says instead: nothing (QUIET_ROW; its level stays, and a rewrite needs a character, so the row itself
 * stays); "row closed" goes to the debug log (mod/rows.ts). */
export const ROW_CLOSED: string = QUIET_ROW;

/** A row as session.append hands it, as far as rowEndedRow reads it. */
type RowLike = { type?: unknown; content?: unknown };
/** The warning row of a row-ended drop, as ROW_CLOSED (cc CONTRACT session-append-notice-rewrite), or null for any
 * other row: only a system row whose one text block is exactly the frame around ROW_ENDED. */
export function rowEndedRow<M extends RowLike>(row: M | null | undefined): M | null {
  if (!row || row.type !== 'system' || !Array.isArray(row.content) || row.content.length !== 1) return null;
  const block: unknown = row.content[0];
  if (typeof block !== 'object' || block === null || !('type' in block) || !('text' in block)) return null;
  if (block.type !== 'text' || block.text !== DROP_FRAME + ROW_ENDED) return null;
  return { ...row, content: [{ type: 'text', text: ROW_CLOSED }] };
}

/** A seated session whose room server is not connected (Claude Code skipped or lost it: cc CONTRACT mcp-failure-cache),
 * told once per time it goes down: the person by a $.ui.log line, Claude by context. mod/prompt.ts asks on every typed
 * prompt of a seat ($.mcp.connect, which also connects a server the session has not yet). */
export const TOOLS_DOWN_NOTICE = 'Room tools not connected, so no room row. Run /mcp and reconnect plugin:sub-human:room.';
export const TOOLS_DOWN = "SUB-HUMAN: the room's tools (plugin:sub-human:room: post, read, plan, task) are not connected in this session. Don't call them; SendMessage to other Claudes still reaches them. The person was told how to reconnect (/mcp).";
/** wasDown: said already for this time down; up: connected now. say: tell both now; down: what to remember. */
export const toolsDownStep = (wasDown: boolean, up: boolean): { say: boolean; down: boolean } => ({ say: !up && !wasDown, down: !up });

