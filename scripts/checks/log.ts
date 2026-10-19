/**
 * log: helpers over the room log (rooms/CODE/log.jsonl) and the row notice records, for checks/context.ts.
 *
 *   byKind(kind, fields), logIn(span), fmt(entry), props (sign-off requests sent out), drafts (an author's own check)
 *   shownLog(name)       the join/leave lines shown to name, [{id, via, at}]: its session document's shown.log (sessionOf,
 *                        in the host's room dir or its own mirror), else rows/notices-NAME.json (a run before it)
 *   shownVia(name, id)   how entry id was shown to name as a join/leave line
 *   chainOk()            the hash chain, validated by the plugin's own room lib
 */
import path from 'node:path';
import * as paths from '../lib/paths.ts';
import { readJson, clip } from '../lib/io.ts';
import type { Entry } from '../../plugin/sub-human/lib/room/types.ts';
import type { Span } from './captures.ts';

/** A room log line as the checks read it (an older run's lines may carry fields the log no longer writes). */
export type LogEntry = Entry & { id_?: unknown };
/** How a join/leave line was shown to a seat. */
export interface ShownRec { id: number, via: string, at?: string }
/** A seat's session document (members/NAME/session.json), the parts the checks read. */
export interface SessionDoc { v?: number, cursor?: number, shown?: { ids?: number[], log?: ShownRec[] }, holds?: { room?: string, members?: string[] } }

export interface RoomLogOpts {
  home: string;
  code: string;
  roomDir: string;
  log: LogEntry[];
  rowsDir?: (name: string) => string;
  sessionOf?: (name: string) => SessionDoc | null;
}

export function roomLog({ home, code, roomDir, log, rowsDir = () => path.join(roomDir, 'rows'), sessionOf = () => null }: RoomLogOpts) {
  // Reflect.get: a field by name, whatever the entry's shape
  const byKind = (k: string, f: Partial<LogEntry> = {}): LogEntry[] => log.filter(e => e.kind === k && Object.entries(f).every(([a, b]) => Reflect.get(e, a) === b));
  const fmt = (e: LogEntry | null | undefined): string => (e ? `#${e.id} ${e.from} ${e.via} ${e.kind}${e.hash ? ' ' + e.hash.slice(0, 6) : ''}${e.proposal_hash ? ' ' + e.proposal_hash.slice(0, 6) : ''}: ${clip(e.text, 90)}` : 'none');
  const logIn = (s: Span | null | undefined): LogEntry[] => (s ? log.filter(e => e.at > s.from && e.at <= s.to) : []);
  const proposals = log.filter((e): e is LogEntry & { hash: string } => e.kind === 'proposal' && !!e.hash);
  // 0.5.0-beta.24: a version is its author's to check first, a request addressed to them alone (a draft); their Yes
  // sends it out, a request to everyone (no `to`)
  const props = proposals.filter(e => !e.to || e.to === 'room');
  const drafts = proposals.filter(e => !!e.to && e.to !== 'room');

  function shownLog(name: string): ShownRec[] {
    const doc = sessionOf(name);
    const rec = doc && doc.shown ? doc.shown : readJson<{ log?: ShownRec[] } | null>(path.join(rowsDir(name), `notices-${name}.json`), {});
    return rec && Array.isArray(rec.log) ? rec.log : [];
  }
  /** How log entry id was shown to name as a join/leave line ("mod"). */
  function shownVia(name: string, id: number): string | null {
    const x = shownLog(name).find(y => y.id === id);
    return x ? x.via : null;
  }
  /** The room's hash chain, validated by the plugin's own room lib. */
  function chainOk(): { ok: boolean, evidence: string } {
    process.env.SUB_HUMAN_HOME = home;
    const r = paths.pluginLib('room.ts').open(paths.roomCode(code)).validateChain();
    return { ok: !!r.ok, evidence: r.ok ? `validateChain ok over ${r.count} entries` : `chain breaks at #${r.badAt} (${r.count} entries)` };
  }
  return { byKind, fmt, logIn, props, drafts, shownLog, shownVia, chainOk };
}

