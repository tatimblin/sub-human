// follow: watches my room (ARCHITECTURE §7 "Live update" step 3). It finds the room through this session's pointer,
// reads the room as it stands, then each poll reads the small tail file and, only when it moved, the log by byte ranges
// and (when its documents stamp moved) the document folders; follow-lines.ts absorb() says what that is for me. The
// pointer is read again after a /sub-human command, a /clear or resume (the id changes and no session.start fires) and
// every PING_MS, when the session pings the daemon: a pointer gone is a leave, and following stops quietly. A session
// in no room pings too, every poll until one gets through under its id, then each PING_MS, so /sub-human knows the
// module runs here (C1). After /sub-human join,
// the daemon writes the pointer once the host lets this machine in (R30): its appearing is drawn as one line. The link
// to a room hosted elsewhere is asked at each ping, so the status line says when its host is away (R34).
import type { On } from 'claude-code';
import * as v from '../vendor/valibot.mjs';
import type { DocKinds, LogLine, RoomState } from '../core/entries.js';
import { fold, takeSnapshot } from '../core/fold.js';
import type { Me } from '../core/deliver.js';
import { enqueue, terms } from '../core/deliver.js';
import { decodeDoc } from '../core/schema.js';
import { PING_MS, decodePointer, sessionFile } from '../core/api.js';
import { readConfig } from '../config.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { blobFile, docDir, fileKey, homeDir, logFile, roomDir, tailFile } from '../home.js';
import { parseTail } from '../store/store.js';
import type { Absorbed, Kind } from './follow-lines.js';
import { absorb, docsOf, toDraw, docsStamp, freshCursor, linesAfter, parseJson, planTerms, unreadPlans } from './follow-lines.js';
import { answer, request } from './bridge.js';
import type { InRoom } from './session.js';
import { forget, fresh, joined, once, session } from './session.js';
import { statusLine } from './status.js';
import { TOOLS } from './tools.js';

export const POLL_MS = 1000;
/** `$.fs.read` answers at most 4 MiB. */
const READ_MAX = 4 * 1024 * 1024;
/** What news and `read since` keep at most; the oldest go first. */
const UNSEEN_MAX = 500;
/** The debug line each finished poll leaves: what a test waits on. */
export const POLLED = 'sub-human: polled';

export function registerFollow(on: On): void {
  let timer: { cancel(): void } | null = null;
  on('session.start', async ($, e, next) => {
    const out = await next(e);
    timer?.cancel();
    Object.assign(session, fresh());
    const home = homeDir({ SUB_HUMAN_HOME: await $.env.get('SUB_HUMAN_HOME') }, (await $.env.get('HOME')) ?? '');
    session.off = readConfig({ SUB_HUMAN_CC_OFF: (await $.env.get('SUB_HUMAN_CC_OFF')) ?? undefined }, '').off;
    let c = freshCursor();
    let busy = false;
    let beat = 0;
    let registered = false;
    let cc: string | undefined; // the Claude Code version, told to the daemon with each ping for doctor
    let stopped = false; // a fork: this session follows the room no more
    let pinged = { id: '', at: 0 }; // the id that last got a ping through, and when: in no room, one each PING_MS
    let id = '';
    const say = (line: string, key = line): void => { if (once(session, key)) $.ui.log(line); };

    // the documents of a kind whose file changed since the last look, each with the one it replaced
    const readDocs = async <K extends Kind>(room: InRoom, kind: K): Promise<{ before?: DocKinds[K]; doc: DocKinds[K] }[]> => {
      const changed = [];
      for (const f of await $.fs.list(docDir(room.dir, kind)).catch(() => [])) {
        const old = c.held[kind].get(f.name);
        if (f.kind !== 'file' || !f.name.endsWith('.json') || old?.mtime === f.mtimeMs) continue;
        const text = await $.fs.read(`${docDir(room.dir, kind)}/${f.name}`).catch(() => null);
        const d = decodeDoc(kind, text === null ? null : parseJson(v.unknown(), text));
        if (!d.ok) continue;
        c.held[kind].set(f.name, { mtime: f.mtimeMs, doc: d.value });
        changed.push({ doc: d.value, ...(old && { before: old.doc }) });
      }
      return changed;
    };
    const readLog = async (room: InRoom, to: number): Promise<Result<readonly LogLine[]>> => {
      const out: LogLine[] = [];
      while (c.head.seq < to) {
        const text = await $.fs.read(logFile(room.dir), { offset: c.offset, length: READ_MAX }).catch(() => null);
        if (text === null) return err(`sub-human can't read room ${room.code}'s log; its updates wait until it can.`);
        const r = await linesAfter(text, c.head);
        if (!r.ok) return err(`sub-human stopped following room ${room.code}: its log no longer matches what this session read (${r.error.replace(/^fork: /, '')}).`);
        if (r.value.bytes === 0) break; // the tail is ahead of a line still being written
        out.push(...r.value.lines);
        c.head = r.value.head;
        c.offset += r.value.bytes;
      }
      return ok(out);
    };
    const step = async (room: InRoom): Promise<void> => {
      const text = await $.fs.read(tailFile(room.dir)).catch(() => null);
      if (text === null || text === c.tail) return; // an idle poll is this one small read
      const tail = parseTail(text);
      const lines = await readLog(room, tail.ok ? tail.value.seq : 0);
      if (!lines.ok) {
        stopped = lines.error.includes('stopped following');
        if (stopped) timer?.cancel();
        say(lines.error);
        return;
      }
      c.tail = text;
      const docs = c.state === null || docsStamp(text) !== c.stamp;
      c.stamp = docsStamp(text);
      const activity = docs ? await readDocs(room, 'activity') : [];
      if (docs) { await readDocs(room, 'presence'); await readDocs(room, 'focus'); }
      session.mine = activity.find(d => d.doc.name === room.name)?.doc ?? session.mine;
      const first = c.state === null;
      const folded = { ...(c.state ?? { wakes: [], draws: [], bursts: {} }), room: fold(c.state && takeSnapshot(c.state.room), lines.value, docsOf(c.held)) };
      c.state = folded;
      if (!first) {
        for (const h of unreadPlans(folded.room, room.name, c.terms)) c.terms.set(h, terms((await $.fs.read(blobFile(room.dir, h)).catch(() => null)) ?? ''));
        take(absorb(folded, lines.value, activity, me(room, folded.room), await $.clock.now()));
      }
      session.state = c.state.room;
      shown(room);
    };
    const me = (room: InRoom, r: RoomState): Me => ({ name: room.name, code: room.code, touched: session.touched, terms: planTerms(r, c.terms) });
    const take = (a: Absorbed): void => {
      c.state = a.state;
      for (const item of a.items) session.queue = enqueue(session.queue, item);
      const drawn = toDraw(a.drawn, session.drawn);
      session.drawn = drawn.shown;
      for (const line of drawn.draw) $.ui.log(line);
      session.wakes = [...session.wakes, ...a.wakes];
      session.unseen = [...session.unseen, ...a.feed].slice(-UNSEEN_MAX);
      session.since = [...session.since, ...a.feed].slice(-UNSEEN_MAX);
      session.count += a.count;
    };
    const shown = (room: InRoom): void => {
      const line = c.state ? statusLine(c.state.room, room, session.count, session.away) : session.shown;
      if (line !== session.shown) { session.shown = line; $.ui.status(line); }
    };
    // colleagues' Claudes' direct messages (R6), which the daemon keeps for this session until taken; a daemon that
    // doesn't answer is the ping's to say
    const inbox = async (room: InRoom): Promise<void> => {
      if (!c.state) return; // the room isn't read yet: the messages wait in the daemon
      const q = request({ op: 'inbox', session: id }, home);
      const r = await $.http.fetch(q.url, q).then(x => answer('inbox', x), () => null);
      const messages = r?.ok ? r.value.messages.filter(m => m.code === room.code) : [];
      const st = c.state; // read again: the room may have changed during the fetch
      if (!messages.length || !st) return;
      take(absorb(st, [], [], me(room, st.room), await $.clock.now(), messages));
      shown(room);
    };
    // where this session's pointer says it is: the same room, another (joined elsewhere), or none (it left); then a
    // ping, which keeps a session in a room live even while idle at the prompt, and the room's link
    const locate = async (): Promise<void> => {
      session.recheck = false;
      id = await $.session.id();
      const p = decodePointer((await $.fs.read(sessionFile(home, id)).catch(() => null)) ?? '');
      const was = session.room;
      if (p && was && p.code === was.code && p.name === was.name) session.room = { ...was, title: p.title };
      else {
        if (was) {
          c = freshCursor();
          forget(session);
          $.ui.status(undefined);
        }
        session.room = p && { home, code: p.code, name: p.name, title: p.title, dir: roomDir(home, await fileKey(p.code)), root: e.cwd };
      }
      cc ??= (await $.session.version().catch(() => null))?.version ?? '';
      const now = await $.clock.now();
      if (p || pinged.id !== id || now - pinged.at >= PING_MS) {
        const q = request({ op: 'ping', session: id, ...(p && { code: p.code, name: p.name }), ...(cc && { cc }) }, home);
        const r = await $.http.fetch(q.url, q).then(x => answer('ping', x), (x: unknown) => err(String(x).slice(0, 200)));
        if (r.ok) pinged = { id, at: now };
        for (const n of r.ok ? r.value?.notes ?? [] : []) $.ui.log(n, { to: 'debug' }); // the daemon's (a room swept)
        if (!r.ok && p) say(`sub-human didn't answer, so ${p.code} may show you away: ${r.error}. /sub-human doctor says why.`, 'ping');
      }
      const code = p?.code ?? session.joining;
      const q = code === null ? null : request({ op: 'link', code }, home);
      const got = q && (await $.http.fetch(q.url, q).then(x => answer('link', x), () => null));
      const l = got?.ok ? got.value : null;
      const line = joined(session, p, l);
      if (line !== null) $.ui.log(line);
      if (!p) return;
      const away = l?.phase === 'host_away' || l?.phase === 'offline';
      if (away !== session.away && session.room) { session.away = away; shown(session.room); }
      if (!registered) { // Claude's tools, from the next prompt on, once this session is in a room
        registered = true;
        const failed = await Promise.all(TOOLS.map(t => $.tool.register(t).then(() => null, (x: unknown) => String(x).slice(0, 200))));
        const why = failed.find(f => f !== null);
        if (why) say(`sub-human's tools aren't available in this session: ${why}`); // C3: one line, no fallback
      }
    };
    const poll = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        if (!session.room || session.recheck || ++beat % (PING_MS / POLL_MS) === 0) await locate();
        if (session.room && !stopped) { await step(session.room); await inbox(session.room); }
      } catch (x) {
        say(`sub-human can't follow the room: ${String(x).slice(0, 200)}`);
      } finally {
        busy = false;
        $.ui.log(POLLED, { to: 'debug' });
      }
    };
    timer = $.clock.every(POLL_MS, () => { void poll(); });
    void poll(); // a big room's first read never holds up the session's start
    return out;
  });
  on('session.end', (_, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') { // the process goes on as another session: keep following
      Object.assign(session, { recheck: true, told: false, queue: [] });
      return next(e);
    }
    timer?.cancel();
    timer = null;
    return next(e);
  });
}
