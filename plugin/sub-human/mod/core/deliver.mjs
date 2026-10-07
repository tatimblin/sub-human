/**
 * plugin/sub-human/mod/core/deliver.mjs: the room's delivery as pure functions; mod/deliver.mjs makes the $ calls.
 * In: the tail child's ndjson events (lib/tail.js). Out: route(ev) -> actions, one $ call each:
 *   seat -> follow it; chat -> $.ui.log per line (a notice is one line, cc CONTRACT ui-log-notice); pull -> isMeta
 *   append; wake -> $.prompt.submit when idle, else append plus log, re-checked at the turn's end (turnLedger);
 *   rows -> held for the next prompt (the orch's ride on its wakes); health -> log plus append.
 * Failure: pull is at most once (PULL_DELIVERY): the tail's cursor moves when the line is written, so a mod lost
 * between that write and the append drops it; a malformed event parses to null and is ignored.
 */
import { FOR_CLAUDE } from './chat.mjs';
import { shimEnv } from './shim.mjs';

// Equal to lib/config.js's entries of the same name (test/mod-core-deliver.test.js): mod/ imports no CommonJS.
/** The tail child's first restart delay, doubled per failure in a row up to MOD_RESTART_MAX_MS. */
export const MOD_RESTART_MS = 1000;
export const MOD_RESTART_MAX_MS = 60_000;
/** A child that ran this long before it exited was healthy: its restart starts the backoff over. */
export const MOD_RESTART_STEADY_MS = 60_000;
/** The tail child's failures in a row before the person is told: a restart resumes from the child's cursor, so
 * one exit loses nothing; a child that keeps failing leaves the room unheard. */
export const MOD_RESTART_TELL_FAILS = 3;
/** At most one delivery-error notice per this long, however many failures it covers. */
export const MOD_DELIVERY_ERROR_LOG_MS = 300_000;
/** Wakes held for the next turn.start, newest kept: a session that never runs a turn again must not grow it. */
export const PENDING_MAX = 20;
/** What the person sees when something the room sent may not have reached the session (one line). */
export const DELIVERY_ERROR_NOTICE = 'sub-human: a room message could not be delivered; `sub-human read` shows the room';

export const PULL_DELIVERY = 'at-most-once';
/** A wake's prompt starts with this "(for Claude)" head, so it never parses as a "room:" post (prompt.mjs gateVerdict). */
export const WAKE_HEAD = `${FOR_CLAUDE} sub-human room: act on what concerns you; the person sees these lines.`;
const TYPES = new Set(['seat', 'chat', 'pull', 'wake', 'rows', 'health']);

export const tailArgv = root => ['node', `${root}/bin/sub-human`, 'tail', '--ndjson'];

// The same env a shimmed hook gets (an empty CLAUDE_PID: a child of the mod inherits whatever claude inherited,
// cc CONTRACT process-run-stdin); a child with no session id looks its seat up by nothing rather than by ''.
export const tailEnv = (sid, root) => shimEnv(typeof sid === 'string' && sid ? { session_id: sid } : {}, root);

/** {push(text) -> [line]}: whole lines out of the pieces $.process.spawn streams. */
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

/** A well-formed event of a known type, else null. */
export function parseEvent(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object' || !TYPES.has(o.type)) return null;
  switch (o.type) {
    case 'seat': {
      const ok = o.seat && typeof o.seat === 'object' && str(o.seat.name) && str(o.seat.code);
      return { type: 'seat', seat: ok ? o.seat : null };
    }
    case 'chat': return Array.isArray(o.lines) && o.lines.length ? { type: 'chat', lines: o.lines.map(String) } : null;
    case 'rows': return { type: 'rows', text: str(o.text) ? o.text : null };
    default: return str(o.text) ? { type: o.type, text: o.text } : null;
  }
}

function visibleLines(text) {
  return String(text ?? '').split('\n').filter(l => l.trim() && !l.startsWith(FOR_CLAUDE));
}

function wakeText(text, rows) {
  return [WAKE_HEAD, text, rows || ''].filter(Boolean).join('\n');
}

export const logLines = x => (Array.isArray(x) ? x : String(x ?? '').split('\n'))
  .filter(l => String(l).trim())
  .map(text => ({ do: 'log', text: String(text) }));

/**
 * [action], each {do:'log'|'append'|'mid-turn-wake', text} | {do:'submit', text, seen} | {do:'hold-rows', text|null}
 * | {do:'seat', seat}. A mid-turn wake is appended now and handed to turnLedger, since the request in flight may not
 * carry it. A submit's `seen` are the lines the person would see, logged when the submit does not take the wake.
 */
export function route(ev, { turnRunning = false, role = 'member', rows = null } = {}) {
  if (!ev) return [];
  switch (ev.type) {
    case 'seat': return [{ do: 'seat', seat: ev.seat }];
    case 'chat': return logLines(ev.lines);
    case 'pull': return [{ do: 'append', text: ev.text }];
    case 'rows': return [{ do: 'hold-rows', text: ev.text }];
    case 'health': return [...logLines(ev.text), { do: 'append', text: `${FOR_CLAUDE} ${ev.text}` }];
    case 'wake': {
      // The orch has no person to type: its rows calls ride on its wakes. A member's go with the person's prompt.
      const text = wakeText(ev.text, role === 'orch' ? rows : null);
      const seen = visibleLines(ev.text);
      if (!turnRunning) return [{ do: 'submit', text, seen }];
      return [...logLines(seen), { do: 'mid-turn-wake', text }];
    }
    default: return [];
  }
}

/** The mid-turn wakes ({text, at}) after the main loop's last finished tool call: no request followed them. */
export function unread(wakes, lastToolDone) {
  return (Array.isArray(wakes) ? wakes : []).filter(w => !(Number(lastToolDone) > Number(w.at))).map(w => w.text);
}

/** MOD_RESTART_MS doubling to MOD_RESTART_MAX_MS; nextFails starts over after a steady run. */
export const restartDelay = fails => Math.min(MOD_RESTART_MAX_MS, MOD_RESTART_MS * 2 ** Math.max(0, fails));

export const nextFails = (fails, ranMs) => (Number(ranMs) > MOD_RESTART_STEADY_MS ? 0 : (Number(fails) || 0) + 1);

export const noticeDue = (lastAt, now) => !(Number(now) - Number(lastAt) < MOD_DELIVERY_ERROR_LOG_MS);

/**
 * The main-loop turn as delivery sees it. A wake appended mid-turn is checked at that turn's end: unless a tool
 * call finished after it (a model request follows each one), the request then in flight was the last and never
 * carried it, so complete() hands it back to be submitted. A wake that neither a submit nor an append took is
 * held, and start() hands it back at the next turn, when the session is evidently running turns again.
 *   start(turnId) -> [text]                 the held wakes, now to deliver
 *   appended(text, at) -> bool              tracked (a turn is running) or not (submit it: no turn will check it)
 *   toolDone(at); complete(turnId) -> [text]   the unread mid-turn wakes of that turn ([] for another turn)
 *   hold(text) -> dropped                   how many old held wakes PENDING_MAX pushed out
 */
export function turnLedger() {
  let running = null;
  let midTurn = [];
  let lastToolDone = -Infinity;
  let pending = [];
  return {
    get running() { return running; },
    start(turnId) {
      running = turnId;
      midTurn = [];
      const held = pending;
      pending = [];
      return held;
    },
    appended(text, at) {
      if (running === null) return false;
      midTurn.push({ text, at });
      return true;
    },
    toolDone(at) { lastToolDone = at; },
    complete(turnId) {
      if (running === null || turnId !== running) return [];
      running = null;
      const waiting = midTurn;
      midTurn = [];
      return unread(waiting, lastToolDone);
    },
    hold(text) {
      pending.push(text);
      return pending.length > PENDING_MAX ? pending.splice(0, pending.length - PENDING_MAX).length : 0;
    },
  };
}

/** Start the tail child unless the hello is sure the session has no seat. */
export const spawnWanted = hello => !hello || !!hello.seat;
