'use strict';
/**
 * plugin/sub-human/lib/notices.js: join / leave lines for every human in the room, as a group chat shows them:
 * "bob joined", "bob rejoined", "bob left" (no room code, no ids).
 *
 * Where a human sees them:
 *   1. at the moment, as a persistent line in their session: the seat's room monitor (bin/sub-human tail) prints
 *      them with the room's other chat lines and the member's Claude prints them as given (member.md). Claude
 *      Code 2.1.281 has no surface that puts a persistent line in the transcript without a model turn: a
 *      FileChanged hook's systemMessage is a 5 s footer notification (key "env-hook", replaced by the next one),
 *      and a monitor event always wakes the model. The monitor records what it printed (markShown, via
 *      "monitor").
 *   2. for a while after: the room row's text ("+bob joined", "−bob left"; lib/rows.js rowText) and the room
 *      row view's progress line (mcp/hold.js).
 *   3. if (1) never printed it (no monitor running): the next typed prompt's `systemMessage` (at-room.js).
 *   The notice file below (hooks/notice.js, FileChanged) is no longer written by the monitor; it stays for a
 *   caller that wants a transient footer notification.
 *
 *   joinLeave(entries, viewer, {now, settleMs}) -> [{id, kind, name, at, settled, rejoin}]
 *       others' member_joined / member_left (never the orch's or viewer's own), in log order. A leave settles
 *       settleMs (SUB_HUMAN_LEAVE_MS, 8 s, the same as the monitor's) after it; a leave followed by a rejoin
 *       within settleMs is no notice, and neither is that rejoin.
 *   text(code, n, members) -> "bob joined" | "bob rejoined" | "bob left"; rowSegment(entries, viewer, {now}) ->
 *       "+bob joined" | "−bob left" | '' (the newest settled notice of the last ROW_MS, 2 min)
 *   file(sid), write(sid, items), read(file) -> {items: [{id, code, name, text, at}]}   the watched file
 *       (items of the last FILE_KEEP_MS are kept, so two notices in one burst both show)
 *   shown(code, name) -> Set(ids), markShown(code, name, ids, via)   what was already shown to this member, and how
 *       (<room>/rows/notices-<name>.json {shown, log: [{id, via: monitor|prompt|notification, at}]})
 */
const fs = require('node:fs');
const path = require('node:path');
const identity = require('./identity.js');

const LEAVE_SETTLE_MS = 8000;
const ROW_MS = 120_000;
const FRESH_MS = 90_000;     // only notices this young are delivered at the moment (a restarted monitor skips old ones)
const FILE_KEEP_MS = 30_000;
const SHOWN_MAX = 200;
const SID_SAFE = /^[A-Za-z0-9_-]{1,128}$/;

const settleMs = () => (Number(process.env.SUB_HUMAN_LEAVE_MS) > 0 ? Number(process.env.SUB_HUMAN_LEAVE_MS) : LEAVE_SETTLE_MS);
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

function here(members) {
  const list = Array.isArray(members) ? members : Object.values(members || {});
  return list.filter(m => m && m.name && !m.left_at && m.role !== 'orch' && m.name !== 'orch').map(m => m.name);
}

function text(code, n, members) { // code and members are unused since the chat form; kept for callers
  if (n.kind === 'member_left') return `${n.name} left`;
  return `${n.name} ${n.rejoin ? 'rejoined' : 'joined'}`;
}

function rowSegment(es, viewer, { now = Date.now() } = {}) {
  const n = joinLeave(es, viewer, { now }).filter(x => x.settled && now - Date.parse(x.at) - (x.kind === 'member_left' ? settleMs() : 0) < ROW_MS).at(-1);
  if (!n) return '';
  return n.kind === 'member_left' ? `−${n.name} left` : `+${n.name} ${n.rejoin ? 'rejoined' : 'joined'}`;
}

// ---------- the watched file (one per session id) ----------
const dir = () => path.join(identity.home(), 'notices');
const file = sid => (SID_SAFE.test(String(sid || '')) ? path.join(dir(), `${sid}.json`) : null);

function read(f) {
  try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return v && Array.isArray(v.items) ? v : { items: [] }; } catch { return { items: [] }; }
}

/** Add items to sid's notice file (written in place: the watcher waits for the write to settle). */
function write(sid, items, now = Date.now()) {
  const f = file(sid);
  if (!f || !items.length) return null;
  const cur = read(f).items.filter(x => x && now - Date.parse(x.at) < FILE_KEEP_MS && !items.some(y => y.id === x.id && y.code === x.code));
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ items: [...cur, ...items] }) + '\n');
  return f;
}

/** Create sid's (empty) notice file so the watcher has a file to watch; returns its path or null. */
function ensure(sid) {
  const f = file(sid);
  if (!f) return null;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    if (!fs.existsSync(f)) fs.writeFileSync(f, '{"items":[]}\n');
    return f;
  } catch { return null; }
}
function remove(sid) { const f = file(sid); if (f) { try { fs.unlinkSync(f); } catch { /* gone */ } } }

// ---------- what was already shown to a member ----------
const shownFile = (code, name) => path.join(identity.roomDir(code), 'rows', `notices-${name}.json`);
function shown(code, name) {
  try { const v = JSON.parse(fs.readFileSync(shownFile(code, name), 'utf8')); return new Set(Array.isArray(v.shown) ? v.shown : []); } catch { return new Set(); }
}
/** Record ids as shown to name, and how (`via`: "monitor" from bin/sub-human tail, "prompt" from at-room, "notification" from the FileChanged hook). */
function markShown(code, name, ids, via = 'notification') {
  if (!ids.length) return;
  const f = shownFile(code, name);
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { /* none yet */ }
  const s = [...new Set([...(Array.isArray(cur.shown) ? cur.shown : []), ...ids])].sort((a, b) => a - b).slice(-SHOWN_MAX);
  const at = new Date().toISOString();
  const log = [...(Array.isArray(cur.log) ? cur.log : []), ...ids.map(id => ({ id, via, at }))].slice(-SHOWN_MAX);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ shown: s, log }));
  fs.renameSync(tmp, f);
}

module.exports = {
  LEAVE_SETTLE_MS, ROW_MS, FRESH_MS, FILE_KEEP_MS,
  settleMs, joinLeave, text, rowSegment, here,
  dir, file, read, write, ensure, remove, shown, markShown,
};
