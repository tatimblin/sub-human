// context: what reaches my Claude about the room, and when (R15a, R42). The mechanics go once per conversation, with
// its first prompt; the room updates that bear on my work go beside my next prompt, datamarked and capped by
// core/deliver.ts's `context`. An overlap heads-up (R15d) can't wait for the prompt: it rides the next tool result of
// a turn already running, never starting one. The session's NAME.CODE title (R6) goes with the first prompt after a join
// and is cleared after a leave, never over a title the person chose (session.ts retitle). No command takes context.
import type { On } from 'claude-code';
import { context } from '../core/deliver.js';
import { mechanics } from '../core/mechanics.js';
import { retitle, session } from './session.js';

export function registerContext(on: On): void {
  on('prompt.submit', async ($, e, next) => {
    session.drawn = 0; // the line cap is per prompt (R41)
    // a prompt typed at an idle session (no turnId) means no turn runs: a start whose end never came is over (wake.ts)
    if (e.turnId === undefined && e.origin.kind !== 'plugin') session.turns.ended = Math.max(session.turns.ended, session.turns.started);
    if (e.command) return next(e); // command.ts answers /room; no command takes context
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
    const title = retitle(session, e.session_title);
    return title === undefined ? out : { ...out, sessionTitle: title };
  });
  on('session.compact', (_, e, next) => { // a compacted conversation lost the mechanics: the next prompt carries them
    if (e.agentId === undefined) session.told = false;
    return next(e);
  });
}
