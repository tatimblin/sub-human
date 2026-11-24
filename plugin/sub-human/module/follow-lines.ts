// What follow.ts reads, as pure functions: the log's new lines from a byte range, the tail's documents stamp, the
// documents held for fold, and what a poll's news is for me (absorb). No `$` here; follow.ts makes the reads.
import * as v from '../vendor/valibot.mjs';
import type { ActivityDoc, DocKind, DocKinds, Docs, LogLine, RoomState } from '../core/entries.js';
import type { Input, Item, Me, State } from '../core/deliver.js';
import { deliver, edits } from '../core/deliver.js';
import { updatesSince } from '../core/fold.js';
import { parseJson } from '../core/schema.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import type { Head } from '../store/store.js';
import { lineHash, verifyLines } from '../store/store.js';

/** The documents follow has read, by file name, with the mtime it read them at. */
export type Held = { [K in DocKind]: Map<string, { mtime: number; doc: DocKinds[K] }> };

/**
 * The complete lines of a log read that follow `head`, chain-checked; `bytes` is how much of `text` they took. A
 * break is a fork (the error starts `fork`), never repaired.
 */
export async function linesAfter(text: string, head: Head): Promise<Result<{ lines: LogLine[]; head: Head; bytes: number }>> {
  const done = text.slice(0, text.lastIndexOf('\n') + 1); // a line with no newline yet is still being written
  const raws = done.split('\n').slice(0, -1);
  const r = await verifyLines(raws, head.seq, head.hash, head.seq);
  if (!r.ok) return r;
  const last = raws.at(-1);
  const h = last === undefined ? head : { seq: head.seq + raws.length, hash: await lineHash(last) };
  return ok({ lines: [...r.value], head: h, bytes: new TextEncoder().encode(done).length });
}

const Stamp = v.looseObject({ docs: v.optional(v.string()) });
/** The tail file's documents stamp, which the daemon renews on every put_doc. */
export function docsStamp(tail: string): string | undefined { const s = parseJson(Stamp, tail); return s.ok ? s.value.docs : undefined; }

export function docsOf(held: Held): Docs {
  const docs = <K extends DocKind>(kind: K): DocKinds[K][] => [...held[kind].values()].map(x => x.doc);
  return { presence: docs('presence'), activity: docs('activity'), focus: docs('focus') };
}

/** Where follow has read to in one room; a new room starts from a fresh one. */
export interface Cursor {
  head: Head;
  /** Bytes of the log read so far. */
  offset: number;
  /** The tail file's text at the last read, and its documents stamp. */
  tail: string;
  stamp: string | undefined;
  /** Null until the first read: the room as it stood then is the catch-up's, never news. */
  state: State | null;
  held: Held;
  /** A plan version's hash → the terms of its text. */
  terms: Map<string, readonly string[]>;
}
export function freshCursor(): Cursor {
  return { head: { seq: 0, hash: '' }, offset: 0, tail: '', stamp: undefined, state: null, held: { presence: new Map(), activity: new Map(), focus: new Map() }, terms: new Map() };
}

/** The latest versions of the plans `me` is on whose terms aren't read yet (R15c), by hash. */
export function unreadPlans(room: RoomState, me: string, read: ReadonlyMap<string, readonly string[]>): string[] {
  return room.plans.flatMap(p => {
    const at = p.versions.at(-1);
    return at && !read.has(at.hash) && p.versions.some(x => x.from === me || x.asked.includes(me)) ? [at.hash] : [];
  });
}
/** The terms of the latest versions read. */
export function planTerms(room: RoomState, read: ReadonlyMap<string, readonly string[]>): string[] {
  return room.plans.flatMap(p => read.get(p.versions.at(-1)?.hash ?? '') ?? []);
}

/** At most this many lines are drawn between two prompts (R41); the rest are counted in one more line, drawn once. */
export const DRAWN_MAX = 3;

/** A line to draw, with what decides which survive the cap: the context cap's value (overlap 3, about me 2, relevant 1). */
export interface Drawn { readonly line: string; readonly value: number; readonly at: number }

/**
 * The lines to draw now, given how many were drawn since the last prompt: the most valuable first, newest first among
 * equals, up to the cap; past it, one `and N more` line, once.
 */
export function toDraw(drawn: readonly Drawn[], shown: number): { draw: string[]; shown: number } {
  const ranked = [...drawn].sort((a, b) => b.value - a.value || b.at - a.at).map(d => d.line);
  const draw = ranked.slice(0, Math.max(0, DRAWN_MAX - shown));
  const rest = ranked.length - draw.length;
  if (!rest || shown > DRAWN_MAX) return { draw, shown: shown + draw.length };
  return { draw: [...draw, `sub-human: and ${rest} more: /room news`], shown: DRAWN_MAX + 1 };
}

export interface Absorbed {
  readonly state: State;
  /** Context for my Claude's next prompt. */
  readonly items: readonly Item[];
  /** The dim lines to draw, before the cap (toDraw). */
  readonly drawn: readonly Drawn[];
  /** The prompts that wake my Claude, for wake.ts (R10). */
  readonly wakes: readonly string[];
  /** A line for each wake, drawn only where no wake is submitted: the wake's own prompt names who it is from. */
  readonly wakeLines: readonly Drawn[];
  /** What news and `read since` gain: colleagues' joins, leaves, new edits and the updates fold counts, in order. */
  readonly feed: readonly Input[];
  /** Messages held for the person, a command or URL in them (R10): the status line points to news for them. */
  readonly held: number;
}

/**
 * What one poll's new lines, colleagues' new edits and the direct messages from colleagues' Claudes (never in the log,
 * R6) are for me, from a state already folded with them.
 */
export function absorb(
  state: State, lines: readonly LogLine[], activity: readonly { readonly before?: ActivityDoc; readonly doc: ActivityDoc }[], me: Me, now: number,
  messages: readonly { readonly from: string; readonly text: string }[] = [],
): Absorbed {
  const edited = activity.flatMap(d => edits(d.before?.files ?? [], d.doc) ?? []);
  // a file a colleague and I both took up in one poll is one overlap, told as theirs (R15d)
  const theirs = new Set(edited.flatMap(i => (i.from === me.name ? [] : i.files)));
  const inputs: Input[] = [
    ...lines.map(l => ({ kind: 'entry', entry: l.entry }) satisfies Input),
    ...edited.flatMap(i => {
      const files = i.from === me.name ? i.files.filter(f => !theirs.has(f)) : i.files;
      return files.length ? [{ ...i, files }] : [];
    }),
    ...messages.map(m => ({ kind: 'message', from: m.from, text: m.text }) satisfies Input),
  ];
  let s = state;
  const items: Item[] = [];
  const drawn: Drawn[] = [];
  const wakes: string[] = [];
  const wakeLines: Drawn[] = [];
  const kept: Input[] = [];
  for (const input of inputs) {
    const d = deliver(input, me, s, now);
    s = d.state;
    const v = d.verdict;
    if (v.kind === 'context') items.push(v.item);
    if (v.kind === 'wake') {
      wakes.push(v.text);
      (v.always ? drawn : wakeLines).push({ line: v.line, value: 2, at: now }); // a plan's answer is the person's news too
    }
    if (v.kind === 'draw') kept.push(input);
    if (v.kind === 'draw' && v.unread) continue; // a held command past its burst's first: counted, not drawn
    if (v.kind !== 'wake' && v.kind !== 'none' && v.line !== undefined) {
      drawn.push(v.kind === 'context' ? { line: v.line, value: v.item.value, at: v.item.at } : { line: v.line, value: 2, at: now });
    }
  }
  const news = updatesSince(lines, me.name);
  const at = (i: Input): number => (i.kind === 'entry' ? i.entry.at : Number.MAX_SAFE_INTEGER); // an edit is as of now
  const others = inputs.filter(i => (i.kind === 'edits' ? i.from !== me.name
    : i.kind === 'entry' && i.entry.from !== me.name && (i.entry.kind === 'joined' || i.entry.kind === 'left')));
  const feed = [...others, ...news.items.map(entry => ({ kind: 'entry', entry }) satisfies Input), ...kept.filter(i => i.kind === 'message')]
    .sort((a, b) => at(a) - at(b));
  return { state: s, items, drawn, wakes, wakeLines, feed, held: kept.length };
}
