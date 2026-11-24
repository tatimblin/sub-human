// messages: a Claude's SendMessage to a colleague's Claude, caught at the sender (R6, ARCHITECTURE §6). The
// recipient's session.receive carries no sender, and native delivery would wake an idle recipient at once or interrupt
// a busy one, so a `to` of NAME.CODE for my room is answered `{isDelivered: true}` without `next` (honoured on 2.1.330,
// docs/internals/v2-risks.md) and carried by the daemon, stamped with my name: into the recipient's inbox on this
// machine, over the room's link to another. It is never written to the log. The recipient's follow.ts takes it and
// wake.ts wakes their Claude. A throwing session.send hook is skipped and the send goes native, so this one never
// throws: a send it can't carry is answered undelivered, with the reason the Claude reads. SUB_HUMAN_CC_OFF=messages
// leaves every send to Claude Code, said once.
import type { On, SessionSendResult } from 'claude-code';
import { readAnswer } from '../core/api.js';
import { why } from '../core/text.js';
import type { RoomState } from '../core/entries.js';
import { secretIn } from '../core/secrets.js';
import { request } from './bridge.js';
import { off, once, session } from './session.js';

export function registerMessages(on: On): void {
  on('session.send', async ($, e, next) => {
    const room = session.room;
    const to = room && addressed(e.to, room.code);
    if (!room || to === null) return next(e);
    if (off(session, 'messages')) {
      if (once(session, 'off messages')) $.ui.log('sub-human isn\'t carrying Claude\'s messages to colleagues here (SUB_HUMAN_CC_OFF); Claude Code sends them itself.');
      return next(e);
    }
    const refused = (why: string): SessionSendResult => ({ isDelivered: false, reason: `sub-human didn't send it to ${to}.${room.code}: ${why}` });
    try {
      const name = recipient(to, session.state);
      if (name === room.name) return refused("that is this session's own name");
      const rule = secretIn(e.text);
      if (rule) return refused(`the text looks like it holds a secret (${rule}); send it without the secret`);
      const q = request({ op: 'message', code: room.code, to: name, from: room.name, text: e.text }, room.home);
      const r = readAnswer('message', await $.http.fetch(q.url, q));
      return r.ok ? { isDelivered: true } : refused(r.error);
    } catch (x) {
      return refused(`sub-human didn't answer (${why(x)}); /sub-human doctor says why`);
    }
  });
}

/**
 * The member a title's NAME names: itself, or for a second session's `bob-2` (pointers.ts titleFor) the member `bob`
 * when no member is called `bob-2`; the daemon carries it to each of that member's sessions.
 */
export function recipient(name: string, room: RoomState | null): string {
  const base = /^(.+)-\d+$/.exec(name)?.[1];
  const member = (n: string): boolean => room?.members.some(m => m.name === n) ?? false;
  return base !== undefined && !member(name) && member(base) ? base : name;
}

/**
 * The NAME of a `to` that is NAME.CODE for room `code`, or null for any other address. `to` is typed a string, but a
 * hook that throws lets the send go native, so anything else is checked, never assumed.
 */
export function addressed(to: unknown, code: string): string | null {
  if (typeof to !== 'string') return null;
  const dot = to.lastIndexOf('.');
  return dot > 0 && to.slice(dot + 1) === code ? to.slice(0, dot) : null;
}
