/**
 * plugin/sub-human/lib/notices.ts: join / leave lines for every human in the room, as a group chat shows them:
 * "bob joined", "bob rejoined", "bob left (connection lost)" (no room code, no ids).
 *
 * Where a human sees them:
 *   1. at the moment, as a persistent line in their session: the hooks module's tail child (scripts/sub-human tail)
 *      sends them as `chat` events and mod/deliver.ts draws them with $.ui.log, no model turn (markShown).
 *   2. for a while after: the room row's text ("+bob joined", "−bob left (session ended)"; lib/rows.ts rowText) and the room
 *      row view's progress line (mcp/hold.ts).
 *
 * Time comes from lib/clock.ts unless the caller passes `now` (ms), so tests drive it without sleeps.
 *
 *   joinLeave(entries, viewer, {now, settle}) -> [{id, kind, name, at, settled, rejoin, why}]
 *       others' member_joined / member_left (never the room Claude's or viewer's own), in log order. A leave settles
 *       settleMs() (SUB_HUMAN_LEAVE_MS, LEAVE_SETTLE_MS = 8 s, the same as the tail's) after it; a leave
 *       followed by a rejoin within it is no notice, and neither is that rejoin. why: a leave's " (REASON)" as the chat
 *       line gives it (lib/room/render.ts leftWhy), else ''.
 *   text(n) -> "bob joined" | "bob rejoined" | "bob left" | "bob left (connection lost)"
 *   rowSegment(entries, viewer, {now}) -> "+bob joined" | "−bob left (connection lost)" | ''   the newest settled notice of the
 *       last ROW_MS (2 min)
 *   shown(code, name) -> Set(ids), markShown(code, name, ids, via, {now}?)   what was already shown to this member (a
 *       restarted tail child does not send it again), and how: via is required and is "mod" (the tail child;
 *       older logs also hold "monitor" and "prompt"). The room document rows/notices-<name>
 *       {shown, log: [{id, via, at}]} (lib/room/store.ts kv)
 */
import * as config from './config.ts';
import * as clock from './clock.ts';
import * as room from './room.ts';
import * as render from './room/render.ts';

/** One join / leave notice (joinLeave). */
const { joinLeave, noticeText: text, rowSegment } = render;
const VIAS: readonly string[] = ['mod'];

// ---------- what was already shown to a member ----------
const kvOf = (code: string) => room.open(code).store.kv;
const shownKey = (name: string) => `rows/notices-${name}`;
function shown(code: string, name: string): Set<number> {
  const v = kvOf(code).get(shownKey(name), null);
  return new Set(v && Array.isArray(v.shown) ? v.shown : []);
}
/** Record ids as shown to name, and how (`via`: "mod", the tail child). */
function markShown(code: string, name: string, ids: number[], via: string, { now = clock.now() } = {}): void {
  if (!VIAS.includes(via)) throw new Error(`markShown: via must be one of ${VIAS.join(', ')}`);
  if (!ids.length) return;
  const kv = kvOf(code);
  const cur = kv.get(shownKey(name), {}) || {};
  const s = [...new Set<number>([...(Array.isArray(cur.shown) ? cur.shown : []), ...ids])].sort((a, b) => a - b).slice(-config.SHOWN_MAX);
  const at = new Date(now).toISOString();
  const log = [...(Array.isArray(cur.log) ? cur.log : []), ...ids.map(id => ({ id, via, at }))].slice(-config.SHOWN_MAX);
  kv.set(shownKey(name), { shown: s, log }, { compact: true });
}

export { joinLeave, text, rowSegment, shown, markShown };
