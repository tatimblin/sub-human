/**
 * plugin/sub-human/mod/core/deliver.mjs: the room's delivery through the hooks module, as pure functions
 * (docs/next/MODS-PLAN.md Part 2b; mod/deliver.mjs makes the $ calls; test/mod-core.test.js checks these in node).
 *
 * The mod runs `node bin/sub-human tail --ndjson` for the session's life (lib/tail.js writes the events) and
 * routes each event:
 *   seat   -> kept: the child follows that seat (delivering(sid) is true while it does)
 *   chat   -> $.ui.log (a dim notice row the person sees; the model never reads it; no wake). D3.
 *   pull   -> $.session.append, a user isMeta row: the model reads it at its next request; no wake
 *   wake   -> idle: $.prompt.submit (a turn of its own); mid-turn: $.session.append plus $.ui.log of its visible
 *             lines, and at that turn's end a $.prompt.submit after all when no tool call of the main loop finished
 *             after the row (then no model request was made after it: the request in flight did not carry it)
 *   rows   -> held ($.state rows) and attached as context to the person's next prompt (and to the orch's wakes)
 *   health -> $.ui.log plus the pull append
 * Pull is at most once (D8, the plan's simple option): the tail's cursor moved once the line was written; a mod
 * lost between that write and the append drops it (PULL_DELIVERY).
 *
 *   PULL_DELIVERY                 'at-most-once'
 *   tailArgv(root) -> argv        ['node', '<root>/bin/sub-human', 'tail', '--ndjson']
 *   tailEnv(sid, root) -> env     the session id the child looks its seat up by, an empty CLAUDE_PID (a child of the
 *                                 mod inherits whatever claude inherited: cc CONTRACT process-run-stdin)
 *   lineBuffer() -> {push(text) -> [line]}   whole lines out of the pieces $.process.spawn streams
 *   parseEvent(line) -> event | null         a well-formed event of a known type, else null
 *   route(ev, {turnRunning, role, rows}) -> [action]
 *       action: {do:'log', text} | {do:'append', text} | {do:'submit', text} | {do:'hold-rows', text|null} |
 *               {do:'seat', seat} | {do:'mid-turn-wake', text}
 *   WAKE_HEAD, wakeText(text, rows) -> text  a wake's prompt: a "(for Claude)" head (so it never parses as a
 *                                 "room:" post; mod/core/prompt.mjs gateVerdict), its lines, then held rows calls
 *   visibleLines(text) -> [line]  the lines a person sees (no "(for Claude)" ones)
 *   unread(wakes, lastToolDone) -> [text]   the mid-turn wakes ({text, at}) appended after the main loop's last
 *                                 finished tool call: no request followed them, so they are submitted after all
 *   restartDelay(fails) -> ms     1 s doubling to 60 s; spawnWanted(hello) -> bool (unsure, or seated)
 *   titleFor(hello, sid, titled) -> addr | null    the session title once per session id (members; the orch's is
 *                                 its launch name)
 */
import { FOR_CLAUDE } from './chat.mjs';

export const PULL_DELIVERY = 'at-most-once';
export const WAKE_HEAD = `${FOR_CLAUDE} sub-human room: act on what concerns you; the person sees these lines.`;
const TYPES = new Set(['seat', 'chat', 'pull', 'wake', 'rows', 'health']);

export const tailArgv = root => ['node', `${root}/bin/sub-human`, 'tail', '--ndjson'];

export function tailEnv(sid, root) {
  const env = { CLAUDE_PLUGIN_ROOT: String(root || ''), CLAUDE_PID: '' };
  if (typeof sid === 'string' && sid) env.CLAUDE_CODE_SESSION_ID = sid;
  return env;
}

export function lineBuffer() {
  let rest = '';
  return {
    push(text) {
      rest += String(text ?? '');
      const parts = rest.split('\n');
      rest = parts.pop();
      return parts.filter(l => l.trim());
    },
    get pending() { return rest; },
  };
}

const str = v => typeof v === 'string' && v !== '';

export function parseEvent(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object' || !TYPES.has(o.type)) return null;
  switch (o.type) {
    case 'seat': return { type: 'seat', seat: o.seat && typeof o.seat === 'object' && str(o.seat.name) && str(o.seat.code) ? o.seat : null };
    case 'chat': return Array.isArray(o.lines) && o.lines.length ? { type: 'chat', lines: o.lines.map(String) } : null;
    case 'rows': return { type: 'rows', text: str(o.text) ? o.text : null };
    default: return str(o.text) ? { type: o.type, text: o.text } : null;
  }
}

export function visibleLines(text) {
  return String(text ?? '').split('\n').filter(l => l.trim() && !l.startsWith(FOR_CLAUDE));
}

export function wakeText(text, rows) {
  return [WAKE_HEAD, text, rows || ''].filter(Boolean).join('\n');
}

export function route(ev, { turnRunning = false, role = 'member', rows = null } = {}) {
  if (!ev) return [];
  switch (ev.type) {
    case 'seat': return [{ do: 'seat', seat: ev.seat }];
    case 'chat': return [{ do: 'log', text: ev.lines.join('\n') }];
    case 'pull': return [{ do: 'append', text: ev.text }];
    case 'rows': return [{ do: 'hold-rows', text: ev.text }];
    case 'health': return [{ do: 'log', text: ev.text }, { do: 'append', text: `${FOR_CLAUDE} ${ev.text}` }];
    case 'wake': {
      // The orch has no person to type: its rows calls ride on its wakes. A member's go with the person's prompt.
      const text = wakeText(ev.text, role === 'orch' ? rows : null);
      if (!turnRunning) return [{ do: 'submit', text }];
      const seen = visibleLines(ev.text);
      return [...(seen.length ? [{ do: 'log', text: seen.join('\n') }] : []), { do: 'mid-turn-wake', text }];
    }
    default: return [];
  }
}

export function unread(wakes, lastToolDone) {
  return (Array.isArray(wakes) ? wakes : []).filter(w => !(Number(lastToolDone) > Number(w.at))).map(w => w.text);
}

export const restartDelay = fails => Math.min(60_000, 1000 * 2 ** Math.max(0, fails));

export const spawnWanted = hello => !hello || !!hello.seat;

export function titleFor(hello, sid, titled) {
  if (!hello || !hello.seat || hello.seat.role === 'orch' || typeof sid !== 'string' || hello.sid !== sid) return null;
  return titled === sid ? null : hello.seat.addr;
}
