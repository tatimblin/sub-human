// context: what reaches my Claude about the room, and when (R15a, R42). The mechanics go once per conversation, with
// its first prompt; the room updates that bear on my work go beside my next prompt, datamarked and capped by
// core/deliver.ts's `context`. An overlap heads-up (R15d) can't wait for the prompt: it rides the next tool result of
// a turn already running, never starting one. The session's NAME.CODE title (R6) is set on every prompt (a no-op when
// unchanged), and cleared after a leave. A /sub-human command takes no context, and has follow.ts read the pointer again.
import type { On } from 'claude-code';
import { CODE } from '../core/api.js';
import { context } from '../core/deliver.js';
import { mechanics } from '../core/mechanics.js';
import { COMMAND, session } from './session.js';

export function registerContext(on: On): void {
  on('prompt.submit', async ($, e, next) => {
    session.drawn = 0; // the line cap is per prompt (R41)
    // a prompt typed at an idle session (no turnId) means no turn runs: a start whose end never came is over (wake.ts)
    if (e.turnId === undefined && e.origin.kind !== 'plugin') session.turns.ended = Math.max(session.turns.ended, session.turns.started);
    if (e.command) {
      if (COMMAND.test(e.command.name)) {
        session.joining = /^\s*join\s/.test(e.command.args) ? (e.command.args.split(/[/?#\s]/).find(p => CODE.test(p)) ?? null) : null;
        const out = await next(e);
        session.recheck = true; // a join, leave or kick may have moved this session's pointer
        return out;
      }
      return next(e);
    }
    const room = session.room;
    if (!room) return next(e);
    const blocks = [...(session.told ? [] : [mechanics(room.name, room.code)]), ...(session.queue.length ? [context(session.queue, room.code)] : [])];
    if (!blocks.length) return next(e);
    if (session.queue.length) $.ui.log(`sub-human: ${session.queue.length} room update(s) went to Claude`, { to: 'debug' });
    session.told = true;
    session.queue = [];
    return next({ ...e, context: [...(e.context ?? []), ...blocks] });
  });
  on('tool.call', async (_, e, next) => {
    const r = await next(e);
    const room = session.room;
    const overlaps = session.queue.filter(i => i.overlap);
    if (!room || !overlaps.length || r.result === undefined || e.agentId !== undefined) return r; // main's loop only
    session.queue = session.queue.filter(i => !i.overlap);
    return { ...r, context: [...(r.context ?? []), context(overlaps, room.code)] };
  });
  on('classic.UserPromptSubmit', async (_, e, next) => {
    const out = await next(e);
    const title = session.room?.title ?? (session.titled ? '' : undefined); // after a leave, the title goes once
    session.titled = title !== undefined && title !== '';
    return title === undefined ? out : { ...out, sessionTitle: title };
  });
  on('session.compact', (_, e, next) => { // a compacted conversation lost the mechanics: the next prompt carries them
    if (e.agentId === undefined) session.told = false;
    return next(e);
  });
}
