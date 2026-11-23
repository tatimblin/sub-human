// capture: my session's finished file edits → my activity document (ARCHITECTURE §7 "Live update" steps 1–2). The
// rule is core/activity.ts; the write goes to the daemon over its Unix socket, since the module can't write the store
// safely (§5); module/bridge.ts builds the call. Commits, tests and the task bridge come later on the same path.
import type { On } from 'claude-code';
import { capture } from '../core/activity.js';
import { err } from '../core/result.js';
import { answer, request } from './bridge.js';
import { session } from './follow.js';

export function registerCapture(on: On): void {
  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const r = await next(e);
    const room = session.room;
    if (!room) return r;
    const now = await $.clock.now();
    const rel = e.file_path.startsWith(`${room.root}/`) ? e.file_path.slice(room.root.length + 1) : null;
    const c = capture(e, r, { name: room.name, root: room.root, now, ...(session.mine && { doc: session.mine }) });
    if (rel !== null && (c.kind === 'doc' || session.mine?.files.includes(rel))) {
      session.touched = [...session.touched.filter(t => t.path !== rel), { path: rel, at: now }];
    }
    if (c.kind !== 'doc') return r;
    session.mine = c.doc;
    const q = request({ op: 'put_doc', code: room.code, kind: 'activity', name: room.name, doc: c.doc }, room.home);
    const res = await $.http.fetch(q.url, q).then(x => answer('put_doc', x), (x: unknown) => err(String(x).slice(0, 200)));
    if (!res.ok && !session.writeFailed) { // one line a session (C3)
      session.writeFailed = true;
      $.ui.log(`sub-human couldn't share your edits with room ${room.code}: ${res.error}`);
    }
    return r;
  });
}
