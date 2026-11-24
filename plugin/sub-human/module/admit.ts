// The host's Let in / Refuse card (R30): from an interactive session's start, while the session is in a room (follow.ts
// fills that in) or has typed `/sub-human invite`, the module asks the daemon every few seconds who waits to be let
// into this session's rooms (`asks`: only rooms hosted here have any), shows each joiner once as a native question card
// naming them, their machine, a name that is not the invite's and the check string both people compare, and posts the
// answer (`admit`). So a host session started after the invite shows the knock too. A card dismissed is a Refuse. A
// line dialled twice is one dim line; one that had let someone in offers their kick.
import type { On } from 'claude-code';
import type { Ask } from '../core/api.js';
import { readAnswer } from '../core/api.js';
import { homeDir } from '../home.js';
import { request } from './bridge.js';
import { COMMAND, session } from './session.js';

export const POLL_MS = 3000;

/** The card for an ask: its question and two labels, Yes first; or, for an alert, only its line. */
export function card(a: Ask): { readonly question: string; readonly options: readonly [string, string] } | { readonly line: string } {
  if (a.kind === 'again') return { line: `sub-human: someone else also used the invite for ${a.expected}; nobody got in with it` };
  if (a.kind === 'leaked') return { question: `Someone else also used the invite ${a.name} joined ${a.code} with. Remove ${a.name}?`, options: [`Remove ${a.name}`, 'Keep'] };
  const who = a.name === a.expected ? a.name : `${a.name} (the invite was for ${a.expected})`;
  const already = a.member ? ` ${a.name} is already a member there.` : '';
  return { question: `Let ${who} on ${a.machine || 'another machine'} into ${a.code}?${already} Check ${a.check} matches theirs.`, options: ['Let in', 'Refuse'] };
}

export function registerAdmit(on: On): void {
  let timer: { cancel(): void } | null = null;
  let invited = false;
  on('command.run', { command: COMMAND, args: /^\s*invite\b/ }, (_, e, next) => {
    invited = true;
    return next(e);
  });
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const out = await next(e);
    timer?.cancel(); // a /clear or /resume starts the session again, under its new id
    const home = homeDir({ SUB_HUMAN_HOME: await $.env.get('SUB_HUMAN_HOME') }, (await $.env.get('HOME')) ?? '');
    const id = await $.session.id();
    let busy = false, said = '';
    // a failure is one line, said again only when it changes, so a poll every few seconds never repeats it; and only
    // once the person has invited: before that, follow.ts's ping already says a daemon that is down
    const fail = (why: string): void => { if (why !== said && invited) $.ui.log(`sub-human: no joiner can be let in: ${why}`); said = why; };
    timer = $.clock.every(POLL_MS, () => {
      if (busy || (!session.room && !invited)) return;
      busy = true;
      void (async () => {
        try {
          const ask = request({ op: 'asks', session: id }, home);
          const got = readAnswer('asks', await $.http.fetch(ask.url, ask));
          if (!got.ok) { fail(got.error); return; }
          said = '';
          for (const a of got.value.asks) {
            const c = card(a);
            if ('line' in c) { $.ui.log(c.line); continue; }
            const chosen = await $.ui.ask(c.question, { options: c.options, header: 'Join' }).catch(() => c.options[1]);
            const yes = chosen === c.options[0];
            if (a.kind === 'leaked' && !yes) continue;
            const reply = request({ op: 'admit', session: id, code: a.code, id: a.id, answer: yes ? (a.kind === 'leaked' ? 'kick' : 'let_in') : 'refuse' }, home);
            const r = readAnswer('admit', await $.http.fetch(reply.url, reply));
            if (!r.ok) $.ui.log(`sub-human: ${r.error}`);
          }
        } catch {
          fail('sub-human did not answer'); // the next poll asks again
        } finally { busy = false; }
      })();
    });
    return out;
  });
}
