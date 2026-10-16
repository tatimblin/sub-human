/**
 * plugin/sub-human/lib/room/session.ts: one document per seat, members/<name>/session in the room's kv: what this
 * machine keeps for that seat's session, in one place. On a mirror it stays on this machine (kv is local there;
 * lib/room/store-mirror.ts streams only members, presence/* and tasks).
 *
 *   {v: 1,
 *    cursor   the tail's delivery cursor: every event for ids <= it was written (lib/tail.ts)
 *    shown    {ids, log: [{id, via, at}]}: the join and leave notices already shown to the person, and how (via is
 *             "mod", the tail child; older logs hold "monitor" and "prompt"), so a restarted tail child does not
 *             send them again (the last SHOWN_MAX)
 *    review   the plan-view review (lib/proposal.ts readReview; hooks/handlers/consent.ts)
 *    confirm  a review's note waiting for the person's Send (lib/proposal.ts readConfirm)
 *    pick     {hash|null, at}: the proposal the person's latest prompt named (lib/proposal.ts readPick)
 *    holds    the seat's live row holds, as mcp/hold.ts wrote them (lib/rows.ts readHolds)
 *    blocks   {agentId: n}: how often hooks/handlers/row-hold.ts blocked that row's stop (the last BLOCKS_MAX)}
 *
 *   read(store, name) -> SessionDoc      the document; for a seat that has none yet, what an earlier sub-human kept in
 *                                        its separate documents (the cursor deliver-<name>, rows/notices-<name>,
 *                                        members/<name>/{review,confirm,pick}, rows/holds-<name>), so an upgrade loses
 *                                        no cursor and no open review
 *   get(store, name, field), put(store, name, field, value)   one field (value undefined: removed)
 *   update(store, name, fn, opts?) -> SessionDoc   fn(doc) -> the next doc (undefined: no write); atomic (kv.update)
 *   shown(store, name) -> Set(ids), markShown(store, name, ids, via, {now}?)   the notices shown
 * A field written here wins over the older document for good: the first write migrates the rest with it.
 */

import * as config from '../config.ts';
import * as clock from '../clock.ts';
import type { KvApi, KvUpdateOpts } from './types.ts';
import type { SessionDoc } from '../types-app.ts';

/** What the session document needs of a store: its kv, and (for an upgrade) its per-reader cursors. */
type SessionStore = { kv: KvApi; getCursor(reader: string): number };

const VIAS: readonly string[] = ['mod'];
const BLOCKS_MAX = 64;
const keyOf = (name: string) => `members/${name}/session`;

/** What an earlier sub-human kept for this seat in separate documents. */
function legacy(s: SessionStore, name: string): SessionDoc {
  const d: SessionDoc = { v: 1 };
  const get = (key: string) => { try { return s.kv.get(key, null); } catch { return null; } };
  let cursor = 0;
  try { cursor = s.getCursor(`deliver-${name}`); } catch { /* none */ }
  if (cursor > 0) d.cursor = cursor;
  const n = get(`rows/notices-${name}`);
  if (n && (Array.isArray(n.shown) || Array.isArray(n.log))) d.shown = { ids: Array.isArray(n.shown) ? n.shown : [], log: Array.isArray(n.log) ? n.log : [] };
  for (const [field, key] of [['review', `members/${name}/review`], ['confirm', `members/${name}/confirm`], ['pick', `members/${name}/pick`], ['holds', `rows/holds-${name}`]] as const) {
    const v = get(key);
    if (v) (d as unknown as Record<string, unknown>)[field] = v;
  }
  return d;
}

function read(s: SessionStore, name: string): SessionDoc {
  let d: SessionDoc | null = null;
  try { d = s.kv.get(keyOf(name), null); } catch { d = null; }
  return d && d.v === 1 ? d : legacy(s, name);
}

function update(s: SessionStore, name: string, fn: (d: SessionDoc) => SessionDoc | undefined, opts: KvUpdateOpts = {}): SessionDoc {
  let out: SessionDoc = { v: 1 };
  s.kv.update<SessionDoc>(keyOf(name), cur => {
    const next = fn(cur && cur.v === 1 ? { ...cur } : legacy(s, name));
    if (next !== undefined) out = next;
    return next;
  }, { compact: true, ...opts });
  return out;
}

const get = <K extends keyof SessionDoc>(s: SessionStore, name: string, field: K): SessionDoc[K] => read(s, name)[field];
function put<K extends keyof SessionDoc>(s: SessionStore, name: string, field: K, value: SessionDoc[K], opts?: KvUpdateOpts): void {
  update(s, name, d => {
    if (value === undefined) delete d[field];
    else d[field] = value;
    return d;
  }, opts);
}

function shown(s: SessionStore, name: string): Set<number> {
  const v = read(s, name).shown;
  return new Set(v && Array.isArray(v.ids) ? v.ids : []);
}

/** Record ids as shown to name, and how (`via`: "mod", the tail child). */
function markShown(s: SessionStore, name: string, ids: number[], via: string, { now = clock.now() }: { now?: number } = {}): void {
  if (!VIAS.includes(via)) throw new Error(`markShown: via must be one of ${VIAS.join(', ')}`);
  if (!ids.length) return;
  const at = new Date(now).toISOString();
  update(s, name, d => {
    const cur = d.shown || { ids: [], log: [] };
    const all = [...new Set<number>([...(Array.isArray(cur.ids) ? cur.ids : []), ...ids])].sort((a, b) => a - b).slice(-config.SHOWN_MAX);
    const log = [...(Array.isArray(cur.log) ? cur.log : []), ...ids.map(id => ({ id, via, at }))].slice(-config.SHOWN_MAX);
    return { ...d, shown: { ids: all, log } };
  });
}

/** How often row-hold blocked agent id's stop, and the count after one more (the last BLOCKS_MAX agents kept). */
const blocks = (s: SessionStore, name: string, id: string): number => Number((read(s, name).blocks || {})[id]) || 0;
function setBlocks(s: SessionStore, name: string, id: string, n: number): void {
  update(s, name, d => {
    const b = { ...(d.blocks || {}) };
    delete b[id];
    b[id] = Number(n) || 0;
    const keys = Object.keys(b);
    for (const k of keys.slice(0, Math.max(0, keys.length - BLOCKS_MAX))) delete b[k];
    return { ...d, blocks: b };
  });
}

export { read, update, get, put, shown, markShown, blocks, setBlocks };
export type { SessionStore };
