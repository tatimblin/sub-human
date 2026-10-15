/**
 * plugin/sub-human/lib/remote/quota.ts: per-link quotas on the host (lib/remote/server.ts), one table (lib/config.ts
 * LINK_QUOTAS): every op a link sends counts against its own window, and one over its max is RATE with reason QUOTA,
 * saying when to try again. A person's posts were bounded in 0.5 betas (human, blobs, streams); now every op is.
 *
 * Where each count lives, so that reconnecting does not reset what costs the host something:
 *   log      append.human, append.agent: the room's own lines by that seat (via human / agent) in the window, read
 *            from the log's tail (the newest lines first, stopping at the window): nothing extra is written
 *   link     hello (with a token or an invite), subscribe, seat (join and leave), blob.put: a window of times per link
 *            in the host-only kv document remote/quota ({linkId: {op: [ms, ...]}}), written once per counted op
 *   session  beat, blob.get, ping, handoff, and any hello on one connection: in the session's memory (they are
 *            frequent, cheap, or bounded elsewhere)
 *
 *   fromLog(entries, {from, via, now?}) -> n            the seat's lines in the window (newest first; stops at its start)
 *   checkLog(entries, {from, via, op, now?})            RATE QUOTA when n reached the op's max
 *   charge(store, linkId, op, {now?})                   one more of op for the link (kv remote/quota), RATE QUOTA when over
 *   session() -> {take(op, now?)}                       a connection's own window per op
 *   QUOTA_KEY 'remote/quota'
 */

import { RoomError } from '../room/validate.ts';
import { LINK_QUOTAS } from '../config.ts';
import type { AuthStore } from './types-core.ts';
import type { Entry } from '../room/types.ts';

type Op = keyof typeof LINK_QUOTAS;
type Counts = Record<string, Partial<Record<Op, number[]>>>;

const QUOTA_KEY = 'remote/quota';

const over = (op: Op, what: string, retryMs: number): RoomError => {
  const q = LINK_QUOTAS[op];
  const per = q.windowMs >= 3_600_000 ? `${Math.round(q.windowMs / 3_600_000)} h` : q.windowMs >= 60_000 ? `${Math.round(q.windowMs / 60_000)} min` : `${Math.round(q.windowMs / 1000)} s`;
  return new RoomError('RATE', `quota: ${what} ${q.max} times in ${per}; try again in ${Math.max(1, Math.ceil(retryMs / 1000))} s`, 'QUOTA');
};

function fromLog(entries: readonly Entry[], { from, via, windowMs, now = Date.now() }: { from: string; via: string; windowMs: number; now?: number }): number {
  let n = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (now - Date.parse(e.at) >= windowMs) break;
    if (e.from === from && e.via === via) n++;
  }
  return n;
}

function checkLog(entries: readonly Entry[], { from, via, op, now = Date.now() }: { from: string; via: string; op: 'append.human' | 'append.agent'; now?: number }): void {
  const q = LINK_QUOTAS[op];
  if (fromLog(entries, { from, via, windowMs: q.windowMs, now }) >= q.max) throw over(op, `${from} posted`, q.windowMs);
}

function charge(store: Pick<AuthStore, 'kv'>, linkId: string, op: Op, { now = Date.now() }: { now?: number } = {}): void {
  const q = LINK_QUOTAS[op];
  let err: RoomError | null = null;
  store.kv.update(QUOTA_KEY, (cur: Counts | null) => {
    err = null;
    const mine = { ...(cur && cur[linkId]) };
    const times = (mine[op] || []).filter(t => now - t < q.windowMs);
    if (times.length >= q.max) { err = over(op, `this connection's ${op}`, q.windowMs - (now - times[0])); return undefined; }
    mine[op] = [...times, now];
    return { ...cur, [linkId]: mine };
  });
  if (err) throw err;
}

/** A connection's own windows: take(op) counts one, RATE QUOTA when the op's max is reached in its window. */
function session(): { take(op: Op, now?: number): void } {
  const seen = new Map<Op, number[]>();
  return {
    take(op, now = Date.now()) {
      const q = LINK_QUOTAS[op];
      const times = (seen.get(op) || []).filter(t => now - t < q.windowMs);
      if (times.length >= q.max) throw over(op, `this connection's ${op}`, q.windowMs - (now - times[0]));
      times.push(now);
      seen.set(op, times);
    },
  };
}

export { fromLog, checkLog, charge, session, QUOTA_KEY };
export type { Op as QuotaOp };
