'use strict';
/**
 * plugin/sub-human/lib/notices.js: join / leave lines for every human in the room, as a group chat shows them:
 * "bob joined", "bob rejoined", "bob left" (no room code, no ids).
 *
 * Where a human sees them:
 *   1. at the moment, as a persistent line in their session: the seat's room monitor (bin/sub-human tail) prints
 *      them with the room's other chat lines and the member's Claude prints them as given (member.md). Claude
 *      Code has no surface that puts a persistent line in the transcript without a model turn, so the monitor's
 *      wake carries them. The monitor records what it printed (markShown, via "monitor").
 *   2. for a while after: the room row's text ("+bob joined", "−bob left"; lib/rows.js rowText) and the room
 *      row view's progress line (mcp/hold.js).
 *   3. if (1) never printed it (no monitor running): the next typed prompt's `systemMessage` (at-room.js,
 *      via "prompt").
 *
 *   joinLeave(entries, viewer, {now, settle}) -> [{id, kind, name, at, settled, rejoin}]
 *       others' member_joined / member_left (never the orch's or viewer's own), in log order. A leave settles
 *       settleMs() (SUB_HUMAN_LEAVE_MS, LEAVE_SETTLE_MS = 8 s, the same as the monitor's) after it; a leave
 *       followed by a rejoin within it is no notice, and neither is that rejoin.
 *   text(n) -> "bob joined" | "bob rejoined" | "bob left"
 *   rowSegment(entries, viewer, {now}) -> "+bob joined" | "−bob left" | ''   the newest settled notice of the
 *       last ROW_MS (2 min)
 *   shown(code, name) -> Set(ids), markShown(code, name, ids, via)   what was already shown to this member, and
 *       how: via is required, "monitor" (bin/sub-human tail) or "prompt" (at-room.js).
 *       the room document rows/notices-<name> {shown, log: [{id, via, at}]} (lib/room/store.js kv)
 */
const config = require('./config.js');
const room = require('./room.js');

const LEAVE_SETTLE_MS = config.LEAVE_SETTLE_MS;
const ROW_MS = config.ROW_NOTICE_MS;
const VIAS = ['monitor', 'prompt'];

const settleMs = () => config.envMs('SUB_HUMAN_LEAVE_MS', LEAVE_SETTLE_MS);
const isMove = e => e && e.via === 'system' && (e.kind === 'member_joined' || e.kind === 'member_left');

function joinLeave(es, viewer, { now = Date.now(), settle = settleMs() } = {}) {
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

function rowSegment(es, viewer, { now = Date.now() } = {}) {
  const n = joinLeave(es, viewer, { now }).filter(x => x.settled && now - Date.parse(x.at) - (x.kind === 'member_left' ? settleMs() : 0) < ROW_MS).at(-1);
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
/** Record ids as shown to name, and how (`via`: "monitor" from bin/sub-human tail, "prompt" from at-room). */
function markShown(code, name, ids, via) {
  if (!VIAS.includes(via)) throw new Error(`markShown: via must be one of ${VIAS.join(', ')}`);
  if (!ids.length) return;
  const kv = kvOf(code);
  const cur = kv.get(shownKey(name), {}) || {};
  const s = [...new Set([...(Array.isArray(cur.shown) ? cur.shown : []), ...ids])].sort((a, b) => a - b).slice(-config.SHOWN_MAX);
  const at = new Date().toISOString();
  const log = [...(Array.isArray(cur.log) ? cur.log : []), ...ids.map(id => ({ id, via, at }))].slice(-config.SHOWN_MAX);
  kv.set(shownKey(name), { shown: s, log }, { compact: true });
}

module.exports = { joinLeave, text, rowSegment, shown, markShown };
