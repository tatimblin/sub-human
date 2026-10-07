'use strict';
/**
 * plugin/sub-human/lib/notices.js: join / leave lines for every human in the room, as a group chat shows them:
 * "bob joined", "bob rejoined", "bob left" (no room code, no ids).
 *
 * Where a human sees them:
 *   1. at the moment, as a persistent line in their session: the hooks module's tail child (bin/sub-human tail)
 *      sends them as `chat` events and mod/deliver.mjs draws them with $.ui.log, no model turn (markShown).
 *   2. for a while after: the room row's text ("+bob joined", "−bob left"; lib/rows.js rowText) and the room
 *      row view's progress line (mcp/hold.js).
 *
 * Time comes from lib/clock.js unless the caller passes `now` (ms), so tests drive it without sleeps.
 *
 *   joinLeave(entries, viewer, {now, settle}) -> [{id, kind, name, at, settled, rejoin}]
 *       others' member_joined / member_left (never the orch's or viewer's own), in log order. A leave settles
 *       settleMs() (SUB_HUMAN_LEAVE_MS, LEAVE_SETTLE_MS = 8 s, the same as the tail's) after it; a leave
 *       followed by a rejoin within it is no notice, and neither is that rejoin.
 *   text(n) -> "bob joined" | "bob rejoined" | "bob left"
 *   rowSegment(entries, viewer, {now}) -> "+bob joined" | "−bob left" | ''   the newest settled notice of the
 *       last ROW_MS (2 min)
 *   shown(code, name) -> Set(ids), markShown(code, name, ids, via, {now}?)   what was already shown to this member (a
 *       restarted tail child does not send it again), and how: via is required and is "mod" (the tail child;
 *       older logs also hold "monitor" and "prompt"). The room document rows/notices-<name>
 *       {shown, log: [{id, via, at}]} (lib/room/store.js kv)
 */
const config = require('./config.js');
const clock = require('./clock.js');
const room = require('./room.js');

const LEAVE_SETTLE_MS = config.LEAVE_SETTLE_MS;
const ROW_MS = config.ROW_NOTICE_MS;
const VIAS = ['mod'];

const settleMs = () => config.envMs('SUB_HUMAN_LEAVE_MS', LEAVE_SETTLE_MS);
const isMove = e => e && e.via === 'system' && (e.kind === 'member_joined' || e.kind === 'member_left');

function joinLeave(es, viewer, { now = clock.now(), settle = settleMs() } = {}) {
  const list = (es || []).filter(e => isMove(e) && e.from !== viewer && e.from !== 'orch');
  const drop = new Set();
  for (const l of list) {
    if (l.kind !== 'member_left') continue;
    const back = list.find(j => j.kind === 'member_joined' && j.from === l.from && j.id > l.id);
    if (back && Date.parse(back.at) - Date.parse(l.at) < settle) { drop.add(l.id); drop.add(back.id); }
  }
  return list.filter(e => !drop.has(e.id)).map(e => ({
    id: e.id, kind: e.kind, name: e.from, at: e.at,
    settled: e.kind === 'member_joined' || now - Date.parse(e.at) >= settle,
    rejoin: e.kind === 'member_joined' && /\brejoined\b/.test(String(e.text || '')),
  }));
}

function text(n) {
  if (n.kind === 'member_left') return `${n.name} left`;
  return `${n.name} ${n.rejoin ? 'rejoined' : 'joined'}`;
}

function rowSegment(es, viewer, { now = clock.now() } = {}) {
  const fresh = x => now - Date.parse(x.at) - (x.kind === 'member_left' ? settleMs() : 0) < ROW_MS;
  const n = joinLeave(es, viewer, { now }).filter(x => x.settled && fresh(x)).at(-1);
  if (!n) return '';
  return n.kind === 'member_left' ? `−${n.name} left` : `+${n.name} ${n.rejoin ? 'rejoined' : 'joined'}`;
}

// ---------- what was already shown to a member ----------
const kvOf = code => room.open(code).store.kv;
const shownKey = name => `rows/notices-${name}`;
function shown(code, name) {
  const v = kvOf(code).get(shownKey(name), null);
  return new Set(v && Array.isArray(v.shown) ? v.shown : []);
}
/** Record ids as shown to name, and how (`via`: "mod", the tail child). */
function markShown(code, name, ids, via, { now = clock.now() } = {}) {
  if (!VIAS.includes(via)) throw new Error(`markShown: via must be one of ${VIAS.join(', ')}`);
  if (!ids.length) return;
  const kv = kvOf(code);
  const cur = kv.get(shownKey(name), {}) || {};
  const s = [...new Set([...(Array.isArray(cur.shown) ? cur.shown : []), ...ids])].sort((a, b) => a - b).slice(-config.SHOWN_MAX);
  const at = new Date(now).toISOString();
  const log = [...(Array.isArray(cur.log) ? cur.log : []), ...ids.map(id => ({ id, via, at }))].slice(-config.SHOWN_MAX);
  kv.set(shownKey(name), { shown: s, log }, { compact: true });
}

module.exports = { joinLeave, text, rowSegment, shown, markShown };
