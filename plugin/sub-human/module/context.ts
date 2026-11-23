// context: the room updates that bear on my work reach my Claude beside my next prompt (R15a), datamarked and capped
// by core/deliver.ts's `context`. follow.ts fills the queue; a prompt that runs a slash command takes none.
import type { On } from 'claude-code';
import { context } from '../core/deliver.js';
import { session } from './follow.js';

export function registerContext(on: On): void {
  on('prompt.submit', ($, e, next) => {
    const room = session.room;
    if (!room || e.command || !session.queue.length) return next(e);
    const text = context(session.queue, room.code);
    session.queue = [];
    $.ui.log(`sub-human: ${text.split('\n').length} room update(s) went to Claude`, { to: 'debug' });
    return next({ ...e, context: [...(e.context ?? []), text] });
  });
}
