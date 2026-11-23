// follow: watches my room (ARCHITECTURE §7 "Live update" step 3). At session start it reads the room as it stands; then
// each poll reads the small tail file and, only when it moved, the log by byte ranges and (when its documents stamp
// moved) the document folders. New lines and colleagues' new edits go to deliver(): context waits in `session.queue`
// for context.ts, a person's line is one dim line, and the status line names who is here with the unread count.
// For U9: `count` only grows (news will reset it), and `session.room` is read once a session finds its pointer.
import type { On } from 'claude-code';
import * as v from '../vendor/valibot.mjs';
import type { ActivityDoc, DocKinds, LogLine } from '../core/entries.js';
import { fold, takeSnapshot, updatesSince } from '../core/fold.js';
import type { Input, Item, Me, State } from '../core/deliver.js';
import { deliver, edits, enqueue } from '../core/deliver.js';
import { decodeDoc } from '../core/schema.js';
import { decodePointer, sessionFile } from '../core/api.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { docDir, fileKey, homeDir, logFile, roomDir, tailFile } from '../home.js';
import type { Head } from '../store/store.js';
import { parseTail } from '../store/store.js';
import type { Held, Kind } from './follow-lines.js';
import { docsOf, docsStamp, linesAfter, parseJson, statusLine } from './follow-lines.js';

export const POLL_MS = 1000;
/** `$.fs.read` answers at most 4 MiB. */
const READ_MAX = 4 * 1024 * 1024;
/** The debug line each finished poll leaves: what a test waits on. */
export const POLLED = 'sub-human: polled';

export interface InRoom { readonly home: string; readonly code: string; readonly name: string; readonly dir: string; readonly root: string }
/** What this session's module knows of its room, shared by follow, capture and context. */
export const session: { room: InRoom | null; queue: readonly Item[]; touched: Me['touched']; mine: ActivityDoc | null; writeFailed: boolean } =
  { room: null, queue: [], touched: [], mine: null, writeFailed: false };

export function registerFollow(on: On): void {
  let timer: { cancel(): void } | null = null;
  on('session.start', async ($, e, next) => {
    const out = await next(e);
    timer?.cancel();
    Object.assign(session, { room: null, queue: [], touched: [], mine: null, writeFailed: false });
    const home = homeDir({ SUB_HUMAN_HOME: await $.env.get('SUB_HUMAN_HOME') }, (await $.env.get('HOME')) ?? '');
    const id = await $.session.id();
    let head: Head = { seq: 0, hash: '' };
    let offset = 0;
    let tailSeen = '';
    let stamp: string | undefined;
    let state: State | null = null;
    let count = 0;
    let shown = '';
    let busy = false;
    let stopped = false; // a fork: this session follows the room no more
    const said = new Set<string>(); // each problem is one line per session (C3)
    const say = (line: string): void => { if (!said.has(line)) { said.add(line); $.ui.log(line); } };
    const held: Held = { presence: new Map(), activity: new Map(), focus: new Map() };

    // the documents of a kind whose file changed since the last look, each with the one it replaced
    const readDocs = async <K extends Kind>(room: InRoom, kind: K): Promise<{ before?: DocKinds[K]; doc: DocKinds[K] }[]> => {
      const changed = [];
      for (const f of await $.fs.list(docDir(room.dir, kind)).catch(() => [])) {
        const old = held[kind].get(f.name);
        if (f.kind !== 'file' || !f.name.endsWith('.json') || old?.mtime === f.mtimeMs) continue;
        const text = await $.fs.read(`${docDir(room.dir, kind)}/${f.name}`).catch(() => null);
        const d = decodeDoc(kind, text === null ? null : parseJson(v.unknown(), text));
        if (!d.ok) continue;
        held[kind].set(f.name, { mtime: f.mtimeMs, doc: d.value });
        changed.push({ doc: d.value, ...(old && { before: old.doc }) });
      }
      return changed;
    };
    const readLog = async (room: InRoom, to: number): Promise<Result<readonly LogLine[]>> => {
      const out: LogLine[] = [];
      while (head.seq < to) {
        const text = await $.fs.read(logFile(room.dir), { offset, length: READ_MAX }).catch(() => null);
        if (text === null) return err(`sub-human can't read room ${room.code}'s log; its updates wait until it can.`);
        const r = await linesAfter(text, head);
        if (!r.ok) return err(`sub-human stopped following room ${room.code}: its log no longer matches what this session read (${r.error.replace(/^fork: /, '')}).`);
        if (r.value.bytes === 0) break; // the tail is ahead of a line still being written
        out.push(...r.value.lines);
        head = r.value.head;
        offset += r.value.bytes;
      }
      return ok(out);
    };
    const step = async (room: InRoom): Promise<void> => {
      const text = await $.fs.read(tailFile(room.dir)).catch(() => null);
      if (text === null || text === tailSeen) return; // an idle poll is this one small read
      const tail = parseTail(text);
      const lines = await readLog(room, tail.ok ? tail.value.seq : 0);
      if (!lines.ok) {
        stopped = lines.error.includes('stopped following');
        if (stopped) timer?.cancel();
        say(lines.error);
        return;
      }
      tailSeen = text;
      const docs = state === null || docsStamp(text) !== stamp;
      stamp = docsStamp(text);
      const activity = docs ? await readDocs(room, 'activity') : [];
      if (docs) { await readDocs(room, 'presence'); await readDocs(room, 'focus'); }
      session.mine = activity.find(d => d.doc.name === room.name)?.doc ?? session.mine;
      const first = state === null;
      state = { ...(state ?? { wakes: [], bursts: {} }), room: fold(state && takeSnapshot(state.room), lines.value, docsOf(held)) };
      if (!first) { // the room as it stood at the start is the catch-up's (read brief), never news
        const me: Me = { name: room.name, code: room.code, touched: session.touched, terms: [] };
        const now = await $.clock.now();
        const inputs: Input[] = [
          ...lines.value.map(l => ({ kind: 'entry', entry: l.entry }) satisfies Input),
          ...activity.flatMap(d => edits(d.before?.files ?? [], d.doc) ?? []),
        ];
        for (const input of inputs) {
          const d = deliver(input, me, state, now);
          state = d.state;
          if (d.verdict.kind === 'context') session.queue = enqueue(session.queue, d.verdict.item);
          if (d.verdict.kind !== 'none' && d.verdict.line !== undefined) $.ui.log(d.verdict.line); // wakes: drawn until wake.ts
        }
        count += updatesSince(lines.value, room.name).count;
      }
      const line = statusLine(state.room, room, count);
      if (line !== shown) { shown = line; $.ui.status(line); }
    };
    const poll = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const p = session.room ? null : decodePointer((await $.fs.read(sessionFile(home, id)).catch(() => null)) ?? '');
        if (p) session.room = { home, code: p.code, name: p.name, dir: roomDir(home, await fileKey(p.code)), root: e.cwd };
        if (session.room) await step(session.room);
      } catch (x) {
        say(`sub-human can't follow the room: ${String(x).slice(0, 200)}`);
      } finally {
        busy = false;
        $.ui.log(POLLED, { to: 'debug' });
      }
    };
    await poll();
    if (!stopped) timer = $.clock.every(POLL_MS, () => { void poll(); });
    return out;
  });
  on('session.end', (_, e, next) => {
    timer?.cancel();
    timer = null;
    return next(e);
  });
}
