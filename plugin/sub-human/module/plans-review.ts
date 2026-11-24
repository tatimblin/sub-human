// plans-review: the reviewer's side (ARCHITECTURE §7 "Group plan" steps 3–4, "Sent plan"; R21–R22c). follow.ts draws
// the one notice line; at my next idle moment (a turn's end, or my next prompt) each plan waiting on me is a native
// question card whose question says what changed since the version I last saw. "Read the full plan" opens a pane with
// the diff and the whole text (a card can't scroll); its button, or the next idle moment, asks again. An answer goes
// to the daemon as `plan answer` or `plan accept`. A sent plan I accept, and my part of an agreed one (R22a), go to my
// Claude with my next prompt. A card dismissed twice is left to the status count and news. No plan file is touched
// and no mode changes (R19); nothing here starts a turn.
import type { On } from 'claude-code';
import { readAnswer } from '../core/api.js';
import { why } from '../core/text.js';
import type { PlanAct } from '../core/api.js';
import { err } from '../core/result.js';
import { blobFile } from '../home.js';
import { request } from './bridge.js';
import type { Card } from './plans-cards.js';
import { BACK, noteCard, readPick, reviewCard } from './plans-cards.js';
import { nextPending, paneLines } from './plans-pending.js';
import { acceptedNote, myAgreed, partsNote } from './plans-notes.js';
import { session } from './session.js';

/** The plan pane's id; one at a time. */
export const PLAN_PANE = 'sub-human-plan';
/** A card dismissed this often is asked no more. */
const DISMISSALS = 2;

/**
 * What plans.ts reads of this session, as plain data: whether a person is here to answer a card (`-p` has none), and
 * the room plans this session stored, by name → the plan file each came from ('' from the plan tool).
 */
export const planSession: { interactive: boolean; readonly stored: Map<string, string> } = { interactive: false, stored: new Map() };

export function registerReview(on: On): void {
  // what is asked no more this session (answered), or not until after the next prompt (dismissed)
  const skip = new Map<string, 'done' | 'later'>();
  const dismissed = new Map<string, number>();
  const told = new Set<string>();
  let notes: string[] = []; // for my Claude, with the next prompt
  let pane: readonly string[] = [];
  let review: (() => Promise<void>) | null = null;

  // each event's matcher says when a card may come (capture, context and follow hold the unmatched hooks): in a session
  // with a person, at the end of a main turn that answered, and on a prompt they typed (here or through Remote Control)
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const out = await next(e);
    skip.clear();
    dismissed.clear();
    told.clear();
    planSession.stored.clear();
    planSession.interactive = true;
    notes = [];
    let busy = false;
    let paneSaid = false;
    // dismissed: not again until after the next prompt, and never past DISMISSALS; the others still get their turn
    const later = (key: string): void => {
      const n = (dismissed.get(key) ?? 0) + 1;
      dismissed.set(key, n);
      skip.set(key, n >= DISMISSALS ? 'done' : 'later');
    };
    const ask = (c: Card) => $.ui.ask(c.question, { options: c.options, header: 'Plan' }).catch(() => null);
    review = async () => {
      if (busy) return;
      busy = true;
      try {
        for (;;) {
          const room = session.room;
          const s = session.state;
          const p = room && s ? nextPending(s, room.name, new Set(skip.keys())) : null;
          if (!room || !p) return;
          const read = (hash: string) => $.fs.read(blobFile(room.dir, hash)).catch(() => null);
          const after = await read(p.hash);
          const before = p.before ? await read(p.before.hash) : null;
          if (after === null) { skip.set(p.key, 'later'); continue; } // not on this machine yet: the next idle moment
          const card = reviewCard(p, before, after);
          let pick = readPick(await ask(card), card);
          if (pick.kind === 'note') {
            const c = noteCard(p);
            pick = readPick(await ask(c), c);
          }
          if (pick.kind === 'back') continue;
          if (pick.kind === 'later' || pick.kind === 'note') { later(p.key); continue; }
          if (pick.kind === 'read') {
            pane = paneLines(p, before, after);
            const opened = await $.ui.open({ id: PLAN_PANE, title: `${p.name} v${p.version}`, focus: true, closeOnEscape: true })
              .catch((x: unknown) => ({ isPlaced: false as const, reason: why(x) }));
            if (opened.isPlaced) return; // its button asks again; so does the next idle moment
            if (!paneSaid) $.ui.log(`sub-human: the full plan isn't shown here (${opened.reason}); ask Claude to read plan ${p.name} to you.`);
            paneSaid = true; // one line a session
            later(p.key);
            continue;
          }
          const note = pick.note === undefined ? {} : { note: pick.note };
          const act: PlanAct = p.kind === 'review'
            ? { act: 'answer', name: p.name, version: p.version, answer: pick.answer === 'changes' ? 'changes' : 'agree', ...note }
            : { act: 'accept', name: p.name, version: p.version, answer: pick.answer === 'agree' ? 'accept' : pick.answer, ...note };
          const q = request({ op: 'plan', code: room.code, from: room.name, ...act }, room.home);
          const r = await $.http.fetch(q.url, q).then(x => readAnswer('plan', x), (x: unknown) => err(why(x)));
          if (!r.ok) {
            $.ui.log(`sub-human couldn't record your answer on ${p.name} v${p.version}: ${r.error}`);
            skip.set(p.key, 'later');
            return;
          }
          skip.set(p.key, 'done');
          $.ui.log(`sub-human: answered ${p.name} v${p.version}`, { to: 'debug' });
          if (act.act === 'accept' && act.answer === 'accept') notes.push(acceptedNote(p, room.code, after));
        }
      } finally {
        busy = false;
      }
    };
    return out;
  });

  on('turn.complete', { reason: 'answer' }, async (_, e, next) => {
    const out = await next(e);
    if (e.agentId === undefined) await review?.();
    return out;
  });

  on('prompt.submit', { origin: { kind: /^(?:composer|bridge)$/ } }, async ($, e, next) => {
    if (e.command) return next(e);
    await review?.();
    for (const [k, why] of skip) if (why === 'later') skip.delete(k);
    const room = session.room;
    const s = session.state;
    const blocks = notes;
    notes = [];
    for (const a of room && s ? myAgreed(s, room.name) : []) {
      if (!room || !s || told.has(`${a.name}:${a.version}`)) continue;
      told.add(`${a.name}:${a.version}`);
      const text = await $.fs.read(blobFile(room.dir, a.hash)).catch(() => null);
      const note = text === null ? null : partsNote(s, room.name, room.code, a.name, a.version, text);
      if (note) blocks.push(note);
    }
    return blocks.length ? next({ ...e, context: [...(e.context ?? []), ...blocks] }) : next(e);
  });

  on('ui.render', { component: 'Pane', requestId: PLAN_PANE }, ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const back = async (): Promise<void> => {
      await $.ui.close({ id: PLAN_PANE }).catch(() => undefined);
      await review?.();
    };
    return Box({
      flexDirection: 'column',
      children: [...pane.map((line, i) => Text({ bold: i === 0, children: line || ' ' })), Button({ key: 'answer', label: BACK, onPress: back })],
    });
  });
}
