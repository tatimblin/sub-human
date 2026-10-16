/**
 * plugin/sub-human/lib/room/watch.ts: what changed in a room's directory (FsRoomStore.watch, lib/room/fs-store.ts, the
 * only importer: the room's file names stay inside the store), for the host's subscribe streams (lib/remote/server.ts). One fs.watch per directory and process (recursive: the log and its segments, members.json,
 * tasks.json, presence/NAME.json, remote/*.json), shared by every stream of that room (the web listener serves many in
 * one process), plus a slow poll that says "anything may have changed" in case the watcher missed an event. A watcher
 * that cannot start or fails falls back to the fast poll the server used before (FOLLOW_POLL_MS).
 *
 *   watch(dir, onChange, {slowMs?, fastMs?}) -> unwatch   onChange({log, docs}) with what changed: log, a line or a
 *       segment; docs, the kv documents (members.json -> members, presence/bob.json -> presence/bob, tasks.json ->
 *       tasks), coalesced to one call per turn of the event loop; onChange(null): the slow poll (FOLLOW_SLOW_MS), or a
 *       watcher-less poll (fastMs): treat everything as changed
 */

import fs from 'node:fs';
import path from 'node:path';
import { FOLLOW_POLL_MS, FOLLOW_SLOW_MS } from '../config.ts';

/** What changed: the log (a line, a segment, the snapshot) and which kv documents; null: anything may have. */
interface Change { log: boolean; docs: ReadonlySet<string> }
type OnChange = (change: Change | null) => void;
interface Shared { watcher: fs.FSWatcher | null; subs: Set<OnChange>; pending: Set<string>; scheduled: boolean; failed: boolean }

const shared = new Map<string, Shared>();

function docKey(name: string): string | null {
  const n = name.split(path.sep).join('/');
  if (!n.endsWith('.json') || n.includes('.tmp') || n === 'snapshot.json' || n === 'outbox.json') return null;
  return n.slice(0, -'.json'.length);
}

function start(dir: string, sh: Shared): void {
  try {
    sh.watcher = fs.watch(dir, { recursive: true, persistent: false }, (_type, name) => {
      if (!name) { for (const fn of sh.subs) fn(null); return; } // no name: anything may have changed
      sh.pending.add(String(name));
      if (sh.scheduled) return;
      sh.scheduled = true;
      setImmediate(() => {
        sh.scheduled = false;
        const names = [...sh.pending];
        sh.pending.clear();
        const docs = new Set(names.map(docKey).filter((k): k is string => !!k));
        const change: Change = { log: names.some(n => /^(?:log(?:-\d+)?\.jsonl|snapshot\.json)$/.test(n)), docs };
        if (!change.log && !docs.size) return; // a lock, a temporary file
        for (const fn of [...sh.subs]) fn(change);
      });
    });
    sh.watcher.on('error', () => { sh.failed = true; try { sh.watcher?.close(); } catch { /* closed */ } sh.watcher = null; });
  } catch { sh.failed = true; sh.watcher = null; }
}

function watch(dir: string, onChange: OnChange, { slowMs = FOLLOW_SLOW_MS, fastMs = FOLLOW_POLL_MS }: { slowMs?: number; fastMs?: number } = {}): () => void {
  const key = path.resolve(dir);
  let sh = shared.get(key);
  if (!sh) {
    sh = { watcher: null, subs: new Set(), pending: new Set(), scheduled: false, failed: false };
    shared.set(key, sh);
    start(key, sh);
  }
  sh.subs.add(onChange);
  const s = sh;
  // the slow poll covers a missed event; with no watcher, the fast poll is the only source
  const timer = setInterval(() => onChange(null), s.watcher && !s.failed ? slowMs : fastMs);
  timer.unref();
  let fast = !s.watcher || s.failed;
  const check = setInterval(() => { // a watcher that failed since: poll fast from now on
    if (fast || !s.failed) return;
    fast = true;
    clearInterval(timer);
    const t = setInterval(() => onChange(null), fastMs);
    t.unref();
    stops.push(() => clearInterval(t));
  }, slowMs);
  check.unref();
  const stops: (() => void)[] = [() => clearInterval(timer), () => clearInterval(check)];
  return () => {
    for (const f of stops.splice(0)) f();
    s.subs.delete(onChange);
    if (!s.subs.size) {
      try { s.watcher?.close(); } catch { /* closed */ }
      shared.delete(key);
    }
  };
}

export { watch, docKey };
export type { Change };
