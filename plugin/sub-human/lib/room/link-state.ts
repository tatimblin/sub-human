/**
 * plugin/sub-human/lib/room/link-state.ts: how this machine's link to a room hosted elsewhere is doing, for the
 * room row (lib/rows.ts), the agent statusline (statusline/segments.ts), `sub-human doctor` (lib/cli/doctor.ts) and
 * the tail's link line (lib/tail.ts linkLine). Read only, never throws. Zero dependencies beyond lib/io.ts,
 * lib/room/links.ts and (lazily) lib/remote/link.ts.
 *
 * One vocabulary, STATES, everywhere a link's state is written or shown (the daemon's state record and its document
 * `link`, the row, doctor, the tail):
 *   online      connected; hooks' writes cross now
 *   connecting  dialling: the first connection, or a redial (after a failure, a wake, a network change)
 *   offline     not connected, retrying on its own (or its daemon is not running: the join hook restarts it)
 *   fork        for good: this copy no longer matches the host's log (`sub-human link --reset CODE`)
 *   stopped     for good: refused (AUTH, PROTOCOL), revoked, the room closed or moved with no way to follow
 * Older records said up / down (state file, before 0.4.1): LEGACY maps them (down with detail fork or stopped reads
 * as that).
 *
 * Sources, best first:
 *   links.readState(code)            the link daemon's record <home>/links/<code>.state.json {state, since, attempt,
 *                                    lastError, rttMs, queued, pid, detail, at} (lib/room/links.ts). Read defensively:
 *                                    any field may be absent
 *   the mirror's document `link`     {pid, state, since, reason?, code?} (lib/remote/link.ts status)
 * A record whose daemon is gone (its pid, else the document's, is not alive) reads 'offline' with lastError "the link
 * daemon is not running" and dead: true; fork and stopped stay what they are.
 *
 *   read(code) -> State | null       null when this machine has no link to CODE (a room hosted here, or none)
 *       State = {state: STATES, since?, attempt?, lastError?, prevError?, rttMs?, queued?, pid?, detail?, dead?,
 *                source: 'state-file'|'link-doc'}
 *   normalize(state, detail?) -> STATES member   an old or new word to the vocabulary (unknown: 'offline')
 *   indicator(st, {now}?) -> string  the compact segment: "⇄ online", "… connecting", "… connecting (3)",
 *       "✕ offline 2m · 2 queued", "✕ stopped", "✕ out of step: /sub-human doctor"; '' for null
 *   isDown(st) -> bool               connecting after a first failure, offline, fork or stopped: worth leading a row with
 *   stateFile(code) -> string        <home>/links/<code>.state.json
 *   STATES                           Set of the five words
 */
import { isAlive } from '../io.ts';
import * as links from './links.ts';
import { createRequire } from 'node:module';
import type { LinkState, LinkStateWord } from './types.ts';
import type { LinkStatus } from '../remote/link.ts';

const require = createRequire(import.meta.url);


const STATES = new Set<LinkStateWord>(['online', 'connecting', 'offline', 'fork', 'stopped']) as ReadonlySet<string>;
const LEGACY: Record<string, LinkStateWord> = { up: 'online', down: 'offline' };
const FOR_GOOD: ReadonlySet<string> = new Set<LinkStateWord>(['fork', 'stopped']);
const isState = (s: unknown): s is LinkStateWord => STATES.has(s as string);

const stateFile = (code: unknown): string => links.stateFile(code);

const num = (x: unknown): number | undefined => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : undefined);
const str = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined);
const clean = <O extends object>(o: O): O => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as O; // only undefined fields dropped

function normalize(state: unknown, detail?: unknown): LinkStateWord {
  if (FOR_GOOD.has(detail as string)) return detail as LinkStateWord;
  const s = LEGACY[state as string] || state;
  return isState(s) ? s : 'offline';
}

/** The mirror's `link` document (lib/remote/link.ts status), or null when it cannot be read. */
function linkDoc(code: string): LinkStatus | null {
  try { return (require('../remote/link.ts') as typeof import('../remote/link.ts')).status(code); } catch { return null; }
}

const NOT_RUNNING = 'the link daemon is not running';

/** Test seam: read() calls through this object, which a test may stub (test/link-state.node-test.ts); an ES module's own
 * exports are read-only. */
const seam = { read: (code: string): LinkState | null => readLink(code) };
const read = (code: string): LinkState | null => seam.read(code);

function readLink(code: string): LinkState | null {
  try {
    if (!links.get(code)) return null;
  } catch { return null; }
  const doc = linkDoc(code);
  let f = null;
  try { f = links.readState(code); } catch { f = null; }
  if (f && typeof f === 'object' && (STATES.has(f.state as string) || (f.state as string) in LEGACY)) {
    const pid = num(f.pid);
    const dead = pid ? !isAlive(pid) : !!(doc && doc.pid && !doc.running);
    const st: LinkState = clean({
      state: normalize(f.state, f.detail), since: str(f.since), attempt: num(f.attempt), lastError: str(f.lastError), prevError: str(f.prevError),
      rttMs: num(f.rttMs), queued: num(f.queued), pid, detail: str(f.detail), source: 'state-file' as const,
    });
    if (dead && !FOR_GOOD.has(st.state)) return { ...st, state: 'offline', lastError: st.lastError || NOT_RUNNING, dead: true };
    return st;
  }
  if (!doc || !doc.state) return { state: 'offline', lastError: NOT_RUNNING, dead: true, source: 'link-doc' };
  const dead = !!(doc.pid && !doc.running);
  const state = normalize(doc.state);
  const lastError = str(doc.reason) || (dead ? NOT_RUNNING : undefined);
  return clean({ state: dead && !FOR_GOOD.has(state) ? 'offline' : state, since: str(doc.since), lastError, ...(dead ? { dead: true } : {}), source: 'link-doc' as const });
}

function ago(iso: string, now: number): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

function indicator(st: Partial<LinkState> | null | undefined, { now = Date.now() }: { now?: number } = {}): string {
  if (!st) return '';
  const state = normalize(st.state, st.detail);
  const queued = (st.queued ?? 0) > 0 ? ` · ${st.queued} queued` : '';
  if (state === 'online') return '⇄ online';
  if (state === 'fork') return '✕ out of step: /sub-human doctor';
  if (state === 'stopped') return `✕ stopped${queued}`;
  if (state === 'connecting') return (st.attempt ?? 0) > 1 ? `… connecting (${st.attempt})${queued}` : `… connecting${queued}`;
  const t = st.since ? ago(st.since, now) : '';
  return `✕ offline${t ? ` ${t}` : ''}${queued}`;
}

function isDown(st: Partial<LinkState> | null | undefined): boolean {
  if (!st) return false;
  const state = normalize(st.state, st.detail);
  return state === 'offline' || FOR_GOOD.has(state) || (state === 'connecting' && (st.attempt ?? 0) > 1);
}

export { read, normalize, indicator, isDown, stateFile, STATES, seam };
