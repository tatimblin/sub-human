// The rules a join follows, pure: a person's member name, and which room a bare /sub-human joins (core/api.ts join):
// the room asked for; else the room this cwd last used, while the person is a member; else the one open room (a member
// present); else, with several open, none (they are listed); else a new code.
import type { RoomState } from './entries.js';
import { isHere } from './entries.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';

/** The /sub-human verbs, by their first word (commands/index.ts loads one file per verb). */
export const VERBS: readonly ['who', 'tasks', 'leave', 'kick', 'help', 'doctor', 'news', 'invite', 'join'] =
  ['who', 'tasks', 'leave', 'kick', 'help', 'doctor', 'news', 'invite', 'join'];
export type VerbName = (typeof VERBS)[number];

/** A member name: one lowercase word, so `NAME.CODE` reads one way. */
export const NAME: RegExp = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Names that would read as a verb or as the room itself. */
export const RESERVED: ReadonlySet<string> = new Set(['room', 'all', 'claude', 'system', 'host', ...VERBS]);

/**
 * A person's own name as a member name: the first word, lowercased, accents and other marks dropped. A name ending in
 * `-<digits>` is none: that is how a second session's title reads (core/api.ts titleFor).
 */
export function nameFrom(text: string): string | null {
  const first = text.trim().split(/\s+/)[0] ?? '';
  const n = first.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[_-]+/, '').slice(0, 32);
  return NAME.test(n) && !RESERVED.has(n) && !/-\d+$/.test(n) ? n : null;
}

export type Pick = { readonly code: string; readonly fresh: boolean } | { readonly rooms: readonly string[] };

const open = (s: RoomState): boolean => s.members.some(isHere);

export function pick(o: {
  readonly rooms: ReadonlyMap<string, RoomState>;
  readonly name: string;
  readonly asked?: string;
  readonly last?: string;
  readonly random: () => number;
}): Result<Pick> {
  if (o.asked !== undefined) {
    return o.rooms.has(o.asked) ? ok({ code: o.asked, fresh: false }) : err(`there is no room ${o.asked} on this machine. Type /sub-human to open one.`);
  }
  const last = o.last === undefined ? undefined : o.rooms.get(o.last);
  if (o.last !== undefined && last?.members.some(m => m.name === o.name && m.machine !== undefined && !m.kicked)) return ok({ code: o.last, fresh: false });
  const opened = [...o.rooms].filter(([, s]) => open(s)).map(([c]) => c).sort();
  const [only, ...more] = opened;
  if (only !== undefined) return more.length ? ok({ rooms: opened }) : ok({ code: only, fresh: false });
  for (let i = 0; i < 20; i++) {
    const fresh = newCode(o.random);
    if (!o.rooms.has(fresh)) return ok({ code: fresh, fresh: true });
  }
  return err('no free room code was found. Type /sub-human again.');
}

const WORDS = [
  'otter', 'badger', 'beaver', 'bison', 'crane', 'dingo', 'egret', 'falcon', 'ferret', 'finch', 'gecko', 'heron', 'ibex',
  'koala', 'lemur', 'llama', 'lynx', 'macaw', 'marmot', 'mink', 'moose', 'newt', 'orca', 'osprey', 'panda', 'puffin',
  'quail', 'raven', 'seal', 'sloth', 'stoat', 'swan', 'tapir', 'toucan', 'vole', 'walrus', 'wombat', 'zebra',
];
/** A fresh room code; `random` is in [0, 1). */
export function newCode(random: () => number): string {
  const word = WORDS[Math.floor(random() * WORDS.length)] ?? 'vole';
  return `${word}-${String(Math.floor(random() * 10_000)).padStart(4, '0')}`;
}
