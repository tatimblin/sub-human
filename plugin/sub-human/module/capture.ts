// capture: what my session does → the room (ARCHITECTURE §7 "Live update" steps 1–2). The rule is core/activity.ts:
// file edits update my activity document, a commit, push, test, build or personal task change is an activity entry.
// A subagent's calls (`agentId`) are mine too (R16a). Presence: working from a main turn's start (which also clears a
// permission wait), idle at its end; follow.ts pings the daemon.
// Every write goes to the daemon over its Unix socket (§5); module/bridge.ts builds the call.
import type { On } from 'claude-code';
import * as v from '../vendor/valibot.mjs';
import { capture } from '../core/activity.js';
import { err } from '../core/result.js';
import { answer, request } from './bridge.js';
import { once, session } from './session.js';

const Created = v.looseObject({ task: v.looseObject({ id: v.string(), subject: v.string() }) });
const Renamed = v.looseObject({ taskId: v.string(), subject: v.string() });

export function registerCapture(on: On): void {
  const subjects = new Map<string, string>(); // native task id → subject, which an update's result doesn't carry
  on('tool.call', { tool: ['Edit', 'Write', 'Read', 'Bash', 'TaskCreate', 'TaskUpdate'] }, async ($, e, next) => {
    const r = await next(e);
    const room = session.room;
    if (!room) return r;
    const now = await $.clock.now();
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : '';
    const rel = path.startsWith(`${room.root}/`) ? path.slice(room.root.length + 1) : null;
    const c = capture(e, r, { name: room.name, root: room.root, now, subjects, ...(session.mine && { doc: session.mine }) });
    if (rel !== null && (c.kind === 'doc' || e.tool === 'Read' || session.mine?.files.includes(rel))) {
      session.touched = [...session.touched.filter(t => t.path !== rel), { path: rel, at: now }];
    }
    if (v.is(Created, r.result)) subjects.set(r.result.task.id, r.result.task.subject);
    if (v.is(Renamed, e)) subjects.set(e.taskId, e.subject);
    if (c.kind === 'none') return r;
    if (c.kind === 'doc') session.mine = c.doc;
    const calls = c.kind === 'doc'
      ? [request({ op: 'put_doc', code: room.code, kind: 'activity', name: room.name, doc: c.doc }, room.home)]
      : c.events.map(d => request({ op: 'append', code: room.code, draft: { ...d, id: crypto.randomUUID() } }, room.home));
    const op = c.kind === 'doc' ? 'put_doc' : 'append';
    for (const q of calls) {
      const res = await $.http.fetch(q.url, q).then(x => answer(op, x), (x: unknown) => err(String(x).slice(0, 200)));
      if (!res.ok && once(session, 'write')) { // one line a session (C3)
        $.ui.log(`sub-human couldn't share your work with room ${room.code}: ${res.error}`);
      }
    }
    return r;
  });

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) { // wake.ts waits for the turn's end
      session.turns.started++;
      session.turns.at = await $.clock.now();
    }
    const room = session.room;
    if (room && e.agentId === undefined) {
      const q = request({ op: 'put_doc', code: room.code, kind: 'presence', name: room.name, doc: { name: room.name, state: 'working', at: await $.clock.now() } }, room.home);
      await $.http.fetch(q.url, q).catch(() => null); // presence is best-effort: a refused write is the edits' line to say
    }
    return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    const out = await next(e);
    if (e.agentId === undefined) session.turns.ended++; // a subagent's end is not main's
    const room = session.room;
    if (room && e.agentId === undefined) {
      const q = request({ op: 'put_doc', code: room.code, kind: 'presence', name: room.name, doc: { name: room.name, state: 'idle', at: await $.clock.now() } }, room.home);
      await $.http.fetch(q.url, q).catch(() => null);
    }
    return out;
  });
}
