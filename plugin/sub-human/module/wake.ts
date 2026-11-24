// wake: starts my Claude's turn for what core/deliver.ts decided wakes it (R10): a person's line naming me, an answer
// to my Claude's open question, a colleague's Claude's direct message, or the answer on a plan it waits on (R21a). A
// tick with nothing to submit while no main turn runs is the reviewer's idle moment: a card waiting on me (R21b). follow.ts leaves each wake's prompt in
// session.wakes, already framed and datamarked, debounced and under the hour's budget; a message carrying a command or
// URL was drawn for my person instead and never reaches here. This only chooses when: never inside a running turn (so
// nobody is interrupted), as one `$.prompt.submit` once the main loop is idle, once more if that turn is aborted, and
// not at all where nobody watches (a session that isn't interactive, or `$.session.surfaces()` empty). It never
// touches the permission mode. Claude Code takes one hook per event without a matcher, and follow.ts and capture.ts
// hold session.start and the turn events, so these two are matched: capture.ts counts the turns in session.turns.
// SUB_HUMAN_CC_OFF=wake starts no turn: the wakes are dropped, said once (their drawn lines stay).
import type { On } from 'claude-code';
import { why } from '../core/text.js';
import { context, tokens, WAKE_TOKENS } from '../core/deliver.js';
import { mechanics } from '../core/mechanics.js';
import { POLL_MS } from './follow.js';
import type { InRoom, Session } from './session.js';
import { planSession } from './plans-review.js';
import { off, once, session } from './session.js';

/** A wake's prompt is submitted at most this many times: once, and once more after an aborted turn. */
export const WAKE_TRIES = 2;
/** A turn start with no end for this long is taken as ended (an end the module never heard), so wakes go on. */
export const STUCK_MS: number = 15 * 60_000;

interface Flight { readonly text: string; readonly tries: number; readonly ended: number; aborted: boolean }

/**
 * One wake prompt, taken from the session: the queued wakes that fit the cap (the first always; the rest wait), then
 * the mechanics if still owed and they fit, then the room updates within what is left. A plugin's own prompt may not
 * pass its own prompt.submit hook, so the wake carries what context.ts would have added.
 */
export function compose(s: Session, room: InRoom | null, cap: number = WAKE_TOKENS): string {
  const parts: string[] = [];
  let used = 0;
  const fits = (t: string): boolean => used + tokens(t) + 1 <= cap;
  const add = (t: string): void => { parts.push(t); used += tokens(t) + 1; };
  for (const w of s.wakes) { if (parts.length && !fits(w)) break; add(w); }
  s.wakes = s.wakes.slice(parts.length);
  if (!room) return parts.join('\n\n');
  const m = mechanics(room.name, room.code);
  if (!s.told && fits(m)) { add(m); s.told = true; }
  const updates = s.queue.length ? context(s.queue, room.code, cap - used - 1) : '';
  if (updates) { add(updates); s.queue = []; }
  return parts.join('\n\n');
}

export function registerWake(on: On): void {
  let flight: Flight | null = null; // the wake submitted, until the main loop's next turn ends
  let timer: { cancel(): void } | null = null;
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const out = await next(e);
    timer?.cancel();
    flight = null;
    let busy = false;
    const tick = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const t = session.turns;
        if (t.started > t.ended && (await $.clock.now()) - t.at >= STUCK_MS) t.ended = t.started;
        if (t.started > t.ended) return; // a turn is running: its end comes first
        const retry = flight !== null && t.ended > flight.ended && flight.aborted && flight.tries < WAKE_TRIES ? flight : null;
        if (flight && t.ended > flight.ended && !retry) flight = null; // the woken turn ended
        if (!flight && !session.wakes.length) { void planSession.review?.(); return; } // idle: a card waiting on me (R21b)
        if ((flight && !retry) || (!retry && !session.wakes.length)) return;
        if (!(await $.session.surfaces()).length) { session.wakes = []; flight = null; return; } // the drawn lines stay
        if (off(session, 'wake')) {
          session.wakes = [];
          if (once(session, 'off wake')) $.ui.log('sub-human won\'t wake Claude for the room here (SUB_HUMAN_CC_OFF); the lines above are for you to pass on.');
          return;
        }
        const text = retry?.text ?? compose(session, session.room);
        flight = { text, tries: (retry?.tries ?? 0) + 1, ended: session.turns.ended, aborted: false };
        const r = await $.prompt.submit({ text });
        if (r.drop !== undefined) { flight = null; $.ui.log(`sub-human: a wake was dropped: ${r.drop}`, { to: 'debug' }); }
      } catch (x) {
        flight = null;
        $.ui.log(`sub-human: a wake wasn't submitted: ${why(x)}`, { to: 'debug' });
      } finally {
        busy = false;
      }
    };
    timer = $.clock.every(POLL_MS, () => { void tick(); });
    return out;
  });
  on('turn.complete', { isAborted: true }, (_, e, next) => { // Esc on the woken turn: tick submits it once more
    if (flight && e.agentId === undefined) flight.aborted = true; // a subagent's abort is not the woken turn's
    return next(e);
  });
}
