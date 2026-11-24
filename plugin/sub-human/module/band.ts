// band: while I am the only one here in a room this machine hosts, one row above the prompt, `Room CODE. Invite:
// [ public ] [ tailnet ] [ ssh ]` (`Room CODE created.` when this session just made it), a button for each way in
// from another machine (R30). SUB_HUMAN_CC_OFF=invite-band turns it off. A button asks whom the invite is for, makes it as `/room invite NAME --public|
// --tailnet|--ssh` does (the same daemon op, the same refusal as one line), and the row then holds the line to send,
// with copy and cancel. The line is the secret: it is drawn and copied, never logged, never put in context. The row
// goes as soon as anyone else is here, on a leave, and when the line expires; nothing is drawn in -p or off the
// terminal. It takes no focus and has no digit hotkeys, since a bare digit in an empty prompt would press one.
import type { On, UiPressArgument } from 'claude-code';
import type { Pathway } from '../core/api.js';
import { PATHWAYS, readAnswer } from '../core/api.js';
import type { RoomState } from '../core/entries.js';
import { isHere } from '../core/entries.js';
import { nameFrom } from '../core/join.js';
import { err } from '../core/result.js';
import { why } from '../core/text.js';
import { request } from './bridge.js';
import { off, session } from './session.js';
import { others } from './status.js';

const CHECK_MS = 1000;
const CANCEL = 'Cancel';
/**
 * The buttons' colour, Claude Code's own (a theme key, so light and dark themes both work). A Button draws its
 * `[ ` and ` ]` outside its children and inverts the whole on hover and focus, so a coloured child left the brackets
 * white; drawn `plain` with the brackets in the child, the inversion covers one colour.
 */
const ACCENT = 'claude';

/** An invite made from the band, until it is cancelled, expires or someone comes in. */
interface Made { readonly code: string; readonly name: string; readonly line: string; readonly id: string; readonly expires: number }

/** The card's options: up to three members who were here before, then Cancel (two labels at least). */
function whoOptions(room: RoomState, me: string): string[] {
  const before = room.members.filter(m => m.name !== me && !m.kicked && !isHere(m)).map(m => m.name).slice(0, 3);
  return before.length ? [...before, CANCEL] : [CANCEL, 'Not now'];
}

/** `7:42 PM` where the person is. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function registerBand(on: On): void {
  let made: Made | null = null;
  let interactive = false;
  let busy = false;
  let timer: { cancel(): void } | null = null;
  // what the row shows now, so a check redraws only when that changes
  const view = (): string => {
    const room = session.room, st = session.state;
    if (!interactive || !room || !st || !session.hosted || off(session, 'invite-band') || others(st, room.name).length) return '';
    return made?.code === room.code ? `invite:${made.id}` : `alone:${room.code}:${session.opened === room.code}`;
  };

  // only an interactive session: -p draws no band, so it never starts the check
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const out = await next(e);
    timer?.cancel(); // a /clear or /resume starts the session again
    interactive = true;
    made = null;
    let shown = '';
    timer = $.clock.every(CHECK_MS, () => {
      void (async () => {
        if (made && (await $.clock.now()) >= made.expires) made = null;
        if (made && view() !== `invite:${made.id}`) made = null; // someone came in, or I left
        const now = view();
        if (now !== shown) { shown = now; $.ui.invalidate('ui.render'); }
      })();
    });
    return out;
  });
  on('ui.render', { component: 'AbovePrompt', surface: 'terminal' }, ($, e, next) => {
    const room = session.room, st = session.state, shown = view();
    if (e.props.hasSurvey || !room || !st || !shown) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const home = room.home;
    const fail = (line: string): void => { $.ui.log(line); };
    if (made && shown === `invite:${made.id}`) {
      const it = made;
      const typed = `/room join ${it.line}`;
      const copy = async (press: UiPressArgument): Promise<void> => {
        const r = await $.ui.copy({ text: typed, surface: press.surface }).catch(() => ({ isCopied: false as const, reason: 'refused' }));
        if (!r.isCopied) fail(`sub-human: nothing was copied (${r.reason}); select the line above the prompt instead.`);
      };
      const cancel = async (): Promise<void> => {
        const q = request({ op: 'uninvite', code: it.code, from: room.name, id: it.id }, home);
        const r = await $.http.fetch(q.url, q).then(x => readAnswer('uninvite', x), (x: unknown) => err(why(x)));
        if (!r.ok) fail(`sub-human: the invite for ${it.name} was not cancelled: ${r.error}`);
        made = null;
        $.ui.invalidate('ui.render');
      };
      return Box({
        flexDirection: 'row', flexWrap: 'wrap', columnGap: 2,
        children: [
          Text({ dimColor: true, children: [`Invite for ${it.name} until ${clockTime(it.expires)} · ${typed}`] }),
          Button({ key: 'copy', label: 'copy', hotkey: 'c', plain: true, onPress: copy, children: [Text({ color: ACCENT, children: ['[ copy ]'] })] }),
          Button({ key: 'cancel', label: 'cancel', plain: true, onPress: cancel, children: [Text({ color: ACCENT, children: ['[ cancel ]'] })] }),
        ],
      });
    }
    const invite = async (via: Pathway): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const options = whoOptions(st, room.name);
        const answer = await $.ui.ask('Who is the invite for? Type their name under Other.', { options, header: 'Invite' }).catch(() => CANCEL);
        if (answer === CANCEL || answer === 'Not now') return;
        const name = nameFrom(answer);
        if (name === null) { fail(`No invite was made: "${answer.slice(0, 40)}" can't be a name.`); return; }
        const q = request({ op: 'invite', code: room.code, from: room.name, name, via }, home);
        const r = await $.http.fetch(q.url, q).then(x => readAnswer('invite', x), (x: unknown) => err(why(x)));
        if (!r.ok) { fail(`No invite was made: ${r.error}`); return; }
        made = { code: room.code, name, ...r.value };
        $.ui.invalidate('ui.render');
      } finally { busy = false; }
    };
    return Box({
      flexDirection: 'row', flexWrap: 'wrap', columnGap: 2,
      children: [
        Text({ dimColor: true, children: [`Room ${room.code}${session.opened === room.code ? ' created' : ''}. Invite:`] }),
        ...PATHWAYS.map(via => Button({ key: via, label: via, plain: true, onPress: () => invite(via), children: [Text({ color: ACCENT, children: [`[ ${via} ]`] })] })),
      ],
    });
  });
}
