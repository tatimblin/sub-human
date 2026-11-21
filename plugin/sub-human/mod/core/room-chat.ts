/**
 * plugin/sub-human/mod/core/room-chat.ts: the room row as the room's chat (0.8.0, the gated feature room-chat), as
 * pure functions; mod/chat.ts runs the hooks. The row (sub-human:room) is idle between lines and resumable: the
 * module answers each of its steps (turn.step, no model), and its background child sub-human:keeper does the
 * blocking hold, so the idle row wakes main with no task notification (cc CONTRACT row-keepalive-child).
 *
 *   KEEPER_AGENT                     the keeper's type
 *   chatOn(hello) -> bool            the row is the chat: the verdict's room-row and room-chat both on
 *   chatSpawn(code)                  $.agent.spawn's input: name the room code (the row's label), prompt "chat: CODE"
 *   keeperCall(code)                 the room's Agent call for its keeper (background, prompt "keep: CODE")
 *   keeperHold(code, wake?)          the keeper's hold input: {room, take: true} (it replaces an older keeper's hold of
 *                                    the room, so a /clear's new row ends the old one); wake: it returns "WAKE: …" once
 *                                    someone else's line comes in, for a row the module does not send to (a row main's
 *                                    model started: a plugin's send to it hands its whole run to its model, every hook
 *                                    of the plugin skipped as re-entry; in auto mode with autoMode rules the send is
 *                                    refused outright; live 2.1.296), so the keeper's end is what wakes it
 *   typedText(text) -> string|null   the person's exact words in a composer row of the row's view (the wrapper Claude
 *                                    Code puts around a line typed into a background agent: cc CONTRACT
 *                                    row-composer-append); null for any other row
 *   postNote(result) -> string|null  what the row says under the person's line: null when at-room sent it, else its
 *                                    refusal or receipt ("⧗ queued: …")
 *   keeperStep(times, now) -> {spawn, times}   a keeper spawn may go now: at most KEEPER_MAX in KEEPER_WINDOW_MS (a
 *                                    keeper that dies at once looped ~200 requests in 25 s in the spike)
 *   ended(result) -> bool            a hold result that ends the keeper (STOP, WAKE, cancelled); anything else (a
 *                                    deny, an error) is a hold that did not run; woken(result): WAKE
 *   rowStatus(code, here, unread)    the one line under main's prompt: "CODE · maya, dev here · 2 new"
 *   rowUuids(jsonl) -> string[]      the uuids of a room transcript's synthesized rows (answeredWithoutRequest: cc
 *                                    CONTRACT step-answered-without-request), its lines to draw again after a resume
 *   drawLine(text) -> RenderElement  a row line as drawn: no bullet, each line's author ("maya:", "maya's Claude:",
 *                                    "you:") bold
 *   keepRow(rows, sid, row) -> rows  the room row per session id ($.store), the newest ROWS_KEPT
 *   planAsk(text) -> bool            a line typed into the row that asks for a room plan: it starts with `plan ` or
 *                                    `/plan ` (case-insensitive; a fixed rule). It is not posted: main's Claude is asked
 *                                    to write it (PLAN_ASK, the context beside the person's line), so the person's check
 *                                    opens in their plan view as for any room plan
 */
import type { RenderElement } from 'claude-code';
import type { Hello } from './types.ts';
import { ROOM_AGENT } from './rows.ts';
import type { ShimResult } from './types.ts';

export const KEEPER_AGENT = 'sub-human:keeper';

export const chatOn = (hello: Hello | null | undefined): boolean =>
  !(hello && hello.cc && (hello.cc.off.includes('room-row') || hello.cc.off.includes('room-chat')));

export const chatSpawn = (code: string): { subagentType: string; name: string; description: string; prompt: string } =>
  ({ subagentType: ROOM_AGENT, name: code, description: 'type here', prompt: `chat: ${code}` });

export const keeperCall = (code: string): { subagent_type: string; description: string; prompt: string; run_in_background: true } =>
  ({ subagent_type: KEEPER_AGENT, description: 'keeper', prompt: `keep: ${code}`, run_in_background: true });

export const keeperHold = (code: string, wake = false): { room: string; take: true; wake?: true } => ({ room: code, take: true, ...(wake ? { wake } : {}) });

/** @cc The user sent a new message while you were working:
 * The wrapper around a line typed into a background agent's row (door prompt, origin composer), live on 2.1.296. */
const TYPED = /^The user sent a new message while you were working:\n([\s\S]*?)\n\n?This is how Claude Code surfaces messages the user sends mid-turn/;
export function typedText(text: unknown): string | null {
  const m = typeof text === 'string' ? TYPED.exec(text) : null;
  return m && m[1] !== undefined && m[1].trim() ? m[1] : null;
}

/** at-room's stop: "Sent…" went out; any other stop or block is what the person reads under their line. */
export function postNote(result: ShimResult): string | null {
  const said = result.block ?? result.stopReason ?? '';
  if (!result.block && /^Sent\b/.test(said)) return null;
  return said || '✗ not posted: sub-human did not answer. Type it again, or use @room in main.';
}

export const KEEPER_MAX = 5;
export const KEEPER_WINDOW_MS: number = 10 * 60_000;
export function keeperStep(times: readonly number[], now: number): { spawn: boolean; times: number[] } {
  const recent = times.filter(t => now - t < KEEPER_WINDOW_MS);
  if (recent.length >= KEEPER_MAX) return { spawn: false, times: recent };
  return { spawn: true, times: [...recent, now] };
}

export const ended = (result: unknown): boolean => typeof result === 'string' && /^\s*(?:STOP\b|WAKE\b|\(cancelled\))/.test(result);
export const woken = (result: unknown): boolean => typeof result === 'string' && /^\s*WAKE\b/.test(result);

export function rowStatus(code: string, here: string, unread: number): string {
  return [code, here, unread ? `${unread} new` : ''].filter(Boolean).join(' · ');
}

export function rowUuids(jsonl: string): string[] {
  const out: string[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.includes('answeredWithoutRequest')) continue;
    try {
      const o: unknown = JSON.parse(line);
      if (o && typeof o === 'object' && 'answeredWithoutRequest' in o && o.answeredWithoutRequest === true && 'uuid' in o && typeof o.uuid === 'string') out.push(o.uuid);
    } catch { /* a torn line */ }
  }
  return out;
}

/** "maya: hi" -> "maya:" bold, then the rest; a line with no author ("bob joined", "  │ more") as it is. */
const AUTHOR = /^([^\s:│][^:\n]{0,60}?:) /;
export function drawLine(text: string): RenderElement {
  const rows = text.split('\n').map((l): RenderElement => {
    const m = AUTHOR.exec(l);
    return m && m[1] ? { type: 'Text', children: [{ type: 'Text', props: { bold: true }, children: [m[1]] }, l.slice(m[1].length)] } : { type: 'Text', children: [l] };
  });
  return { type: 'Box', props: { flexDirection: 'column' }, children: rows };
}

export const planAsk = (text: string): boolean => /^\s*\/?plan\s+\S/i.test(text);
export const PLAN_ASK = "(for Claude) sub-human: the person typed the line above in the room row: a request for a room plan, not posted to the room. Write it as a room plan with the plan tool (op edit, one call); their check opens in their plan view first.";

export type ChatRows = Readonly<Record<string, KeptRow | undefined>>;
export const ROWS_KEPT: number = 20;
/** A kept row: its room, its agent id, and wake (main's model started it: it is woken by its keeper's end, never sent to). */
export type KeptRow = { code: string; id: string; wake?: true };
export function keepRow(rows: unknown, sid: string, row: KeptRow): ChatRows {
  const keys = rows && typeof rows === 'object' ? Object.keys(rows).filter(k => k !== sid) : [];
  const was = keys.flatMap(k => { const r = rowOf(rows, k); return r ? [[k, r] as const] : []; });
  return { ...Object.fromEntries(was.slice(-(ROWS_KEPT - 1))), [sid]: row };
}
/** The row kept for sid, or null. */
export function rowOf(rows: unknown, sid: string): KeptRow | null {
  const v: unknown = rows && typeof rows === 'object' ? Object.getOwnPropertyDescriptor(rows, sid)?.value : undefined;
  if (!(v && typeof v === 'object' && 'code' in v && 'id' in v && typeof v.code === 'string' && typeof v.id === 'string')) return null;
  return { code: v.code, id: v.id, ...('wake' in v && v.wake === true ? { wake: true as const } : {}) };
}
