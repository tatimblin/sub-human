/**
 * plugin/sub-human/lib/cli/doctor/rooms.ts: the log of each room this home hosts, checked as the tail checks it: the
 * hash chain over every segment this machine holds (store.validateChain) and every person's line judged against the
 * keys the room pins (store.trust: verified, legacy, unverified). A copy of a room hosted elsewhere is the host's to
 * check (its link refuses a line that does not chain). `sub-human verify CODE` prints the same for one room.
 *
 *   verifyRoom(code) -> RoomVerify   {code, count, chain: {ok, badAt?, line?}, unverified: [id], legacy: n}
 *   roomChecks() -> [Check]          room:CODE per hosted room: pass; fail when the chain breaks or a person's line
 *                                    does not verify (a line written outside the plugin, or a key that is not theirs);
 *                                    a leftover folder (registry isLeftover) warns with `link CODE --forget`
 *   verifyText(v) -> string          one room's verdict, for the CLI
 */
import { check, cli } from './check.ts';
import { createRequire } from 'node:module';
import type { Check } from '../types.ts';

const require = createRequire(import.meta.url);
const store = (): typeof import('../../room/store.ts') => require('../../room/store.ts');

export interface RoomVerify { code: string; count: number; chain: { ok: boolean; badAt?: number | null; line?: number }; unverified: number[]; legacy: number }

export function verifyRoom(code: string): RoomVerify {
  const s = store().open(code);
  const chain = s.validateChain();
  const unverified: number[] = [];
  let legacy = 0;
  for (const e of s.readAll()) {
    if (e.via !== 'human') continue;
    const v = s.trust(e);
    if (v === 'unverified') unverified.push(e.id);
    else if (v === 'legacy') legacy++;
  }
  return { code, count: chain.count, chain: { ok: chain.ok, ...(chain.badAt != null ? { badAt: chain.badAt } : {}), ...(chain.line != null ? { line: chain.line } : {}) }, unverified, legacy };
}

const ids = (xs: number[]) => (xs.length > 6 ? `${xs.slice(0, 6).map(i => `#${i}`).join(', ')} and ${xs.length - 6} more` : xs.map(i => `#${i}`).join(', '));

export function verifyText(v: RoomVerify): string {
  const parts: string[] = [];
  parts.push(v.chain.ok ? `${v.count} lines, the hash chain holds` : `the hash chain breaks at #${v.chain.badAt ?? '?'}${v.chain.line ? ` (line ${v.chain.line} of the log)` : ''}: that line and the ones after it may have been changed outside the plugin`);
  if (v.unverified.length) parts.push(`${v.unverified.length} person's line(s) do not verify against the keys the room pins (${ids(v.unverified)}): shown "(unverified)", never a person's own words`);
  if (v.legacy) parts.push(`${v.legacy} line(s) from before signed posts (legacy)`);
  return parts.join(' · ');
}

export function roomChecks(): Check[] {
  const out: Check[] = [];
  let codes: string[] = [];
  try { codes = store().listRooms(); } catch { return out; }
  for (const code of codes) {
    let v: RoomVerify;
    try {
      // a folder something wrote after its room was forgotten: no room at all (item 9 R1)
      if (store().isLeftover(code)) {
        out.push(check(`room:${code}`, 'warn', `room ${code}`, 'a leftover folder with no log and no connection, not a room hosted here', `set it aside: ${cli(`link ${code} --forget`)}`));
        continue;
      }
      if (!store().open(code).isHost) continue;
      v = verifyRoom(code);
    } catch (e) {
      out.push(check(`room:${code}`, 'warn', `room ${code}`, `its log could not be read: ${e instanceof Error ? e.message : e}`));
      continue;
    }
    const bad = !v.chain.ok || v.unverified.length > 0;
    out.push(check(`room:${code}`, bad ? 'fail' : 'pass', `room ${code}`, verifyText(v),
      bad ? `the room's log was written outside sub-human: tell the room, and keep a copy (${cli(`verify ${code}`)} lists it); the people's own lines are the verified ones` : undefined));
  }
  return out;
}
