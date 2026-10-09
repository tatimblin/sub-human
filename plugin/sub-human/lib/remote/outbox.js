'use strict';
/**
 * plugin/sub-human/lib/remote/outbox.js: the bounded @room outbox of a mirror. While the link is down, a person's
 * @room post (already signed by the hook, so its nonce and ts are fixed) is kept here by the link daemon
 * (lib/remote/link.js, the file's one writer) and placed in order once the link is back. Only a post qualifies:
 * answers (signoff, objection), proposals, joins and anything an agent writes are never queued, because a stale
 * consent or a late answer is worse than none; they fail at once with OFFLINE. The daemon never re-signs: a post
 * older than ageMs (LINK_OUTBOX_AGE_MS, inside the host's SIG_SKEW_MS) is dropped with a notice instead.
 *
 *   <mirror dir>/outbox.json (0600)   [{payload, queued_at}] in the order typed
 *   queueable(payload) -> bool        a via=human `say` to the room or to claude (an @claude), signed (sig v2: nonce and ts)
 *   open(dir, {max?, ageMs?}) -> Outbox   (ageMs on it: how long a post may wait)
 *     items() -> [{payload, queued_at}]
 *     size() -> n
 *     add(payload, now?, {force?}?) -> n   appended; RoomError OFFLINE when max posts are queued already (force: a
 *                                      post sent already whose answer is late, lib/remote/link.js, is always kept)
 *     first() -> item | undefined;  drop() removes the first
 *     remove(nonce) -> bool            removes the post signed with that nonce (it landed, or was refused)
 *     expire(now?) -> [item]           removes and returns the posts queued more than ageMs ago
 */

const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJsonAtomic } = require('../io.js');
const { RoomError } = require('../room/validate.js');
const config = require('../config.js');

/**
 * @param {object} p
 * @returns {boolean}
 */
const queueable = p => !!p && p.kind === 'say' && p.via === 'human' && (p.to === undefined || p.to === 'room' || p.to === 'claude')
  && typeof p.nonce === 'string' && Number.isFinite(p.ts);

/**
 * @param {string} dir
 * @param {{max?: number, ageMs?: number}} [opts]
 */
function open(dir, { max = config.LINK_OUTBOX_MAX, ageMs = config.envMs('SUB_HUMAN_LINK_OUTBOX_AGE_MS', config.LINK_OUTBOX_AGE_MS) } = {}) {
  const file = path.join(dir, 'outbox.json');
  const load = () => { const v = readJson(file); return Array.isArray(v) ? v.filter(x => x && x.payload) : []; };
  let list = load();
  const save = () => {
    if (!list.length) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(file, list, { mode: 0o600 });
  };
  return {
    file,
    ageMs,
    items: () => list.slice(),
    size: () => list.length,
    add(payload, now = Date.now(), { force = false } = {}) {
      if (!force && list.length >= max) throw new RoomError('OFFLINE', `the room is offline and ${max} @room posts are queued already; nothing more is queued`);
      list.push({ payload, queued_at: new Date(now).toISOString() });
      save();
      return list.length;
    },
    first: () => list[0],
    drop() { list.shift(); save(); },
    remove(nonce) {
      const i = list.findIndex(x => x.payload.nonce === nonce);
      if (i < 0) return false;
      list.splice(i, 1);
      save();
      return true;
    },
    expire(now = Date.now()) {
      const old = list.filter(x => now - Date.parse(x.queued_at) > ageMs);
      if (old.length) { list = list.filter(x => !old.includes(x)); save(); }
      return old;
    },
  };
}

module.exports = { queueable, open };
