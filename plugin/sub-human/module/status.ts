// status: what the person sees of the room without asking (R15b). The status line names who else is here and what
// needs me; `/sub-human news` opens a pane with the updates since I last looked, drawn here with no model call, and
// clears the held messages. follow.ts fills the session's feed and redraws the line; this file draws it and the pane.
import type { On } from 'claude-code';
import type { Input } from '../core/deliver.js';
import type { Member, RoomState } from '../core/entries.js';
import { oneLine, why } from '../core/text.js';
import { COMMAND, session, unread } from './session.js';
import { isHere } from '../core/entries.js';
import { pending } from './plans-pending.js';

/** The pane's id; one news pane at a time. */
export const NEWS_PANE = 'sub-human-news';
const LINE_MAX = 300;

/** How wide the line may be where nothing says (the `$.ui.status` row). */
export const LINE_COLUMNS = 80;
const SEP = ' · ';
const DOT = { working: '●', idle: '○', waiting: '◐', away: '◌' } as const;

/**
 * `CODE  ● bob  ○ carol · plan "paging" needs your review (+2)` (R15b): the room's code (a renamed session's title no
 * longer shows it), each other member with a dot (● working, ○ idle, ◐ waiting on a permission prompt, ◌ away), or
 * that the host is away (R34) when nobody's presence can be known; then the one most urgent thing that needs me, with
 * how many more do. Within `width`, names fold into `+N` first: the code and what needs me are kept whole.
 */
export function statusLine(room: RoomState, me: { readonly code: string; readonly name: string }, held: number, away = false, width: number = LINE_COLUMNS): string {
  const needs = needsMe(room, me.name, held);
  const right = needs[0] === undefined ? '' : ` · ${needs[0]}${needs.length > 1 ? ` (+${needs.length - 1})` : ''}`;
  if (away) return `${me.code}  host away${right}`;
  // a member who hasn't left is drawn even while away: they are still in the room, and a message still reaches them
  const names = room.members.filter(m => m.name !== me.name && !m.kicked && m.machine !== undefined).map(m => `${dot(m)} ${m.name}`);
  for (let k = names.length; ; k--) {
    const rest = names.length - k;
    const line = [me.code, ...names.slice(0, k), ...(rest ? [`+${rest}`] : [])].join('  ') + right;
    if (k === 0 || line.length <= width) return line;
  }
}

function dot(m: Member): string {
  if (!isHere(m)) return DOT.away;
  return m.presence?.waiting ? DOT.waiting : m.presence?.state === 'working' ? DOT.working : DOT.idle;
}

/**
 * What needs me, most urgent first: a plan version waiting on my review, a plan sent to me, messages held for me
 * (a command or URL in them, R10), and a task I added, not yet claimed, whose blockers are all done.
 */
export function needsMe(room: RoomState, me: string, held: number): string[] {
  const plans = pending(room, me);
  const done = new Set(room.tasks.filter(t => t.status === 'done').map(t => t.n));
  return [
    ...plans.filter(p => p.kind === 'review').map(p => `plan "${oneLine(p.name, 40)}" needs your review`),
    ...plans.filter(p => p.kind === 'sent').map(p => `${p.from} sent you plan "${oneLine(p.name, 40)}"`),
    ...(held ? [`${held} held message${held === 1 ? '' : 's'}: /sub-human news`] : []),
    // until someone claims it: a claimed task is started
    ...room.tasks.filter(t => t.addedBy === me && t.status === 'open' && t.blockedBy.length && t.blockedBy.every(n => done.has(n)))
      .map(t => `task #${t.n} is free to start`),
  ];
}

/**
 * The news pane's lines: what each colleague changed and found since I last looked, by member in the order they
 * first acted. A `left` is shown only when no machine of the member's is still present (a leave on one machine).
 */
export function newsLines(unseen: readonly Input[], room: RoomState, code: string): string[] {
  const by = new Map<string, string[]>();
  const add = (who: string, line: string): void => { by.set(who, [...(by.get(who) ?? []), oneLine(line, LINE_MAX)]); };
  for (const u of unseen) {
    if (u.kind === 'edits') { add(u.from, `edited ${u.files.join(', ')}`); continue; }
    if (u.kind === 'message') { add(u.from, `their Claude, held for you: ${u.text}`); continue; }
    const e = u.entry;
    const claude = e.by === 'claude' ? 'their Claude: ' : '';
    switch (e.kind) {
      case 'joined': add(e.from, 'joined'); break;
      case 'left': if (!room.members.some(m => m.name === e.from && m.presence && m.presence.state !== 'away')) add(e.from, 'left'); break;
      case 'finding': case 'post': add(e.from, `${claude}${e.kind === 'post' && e.to ? `(to ${e.to}) ` : ''}${e.text}`); break;
      case 'activity': add(e.from, `${e.text}${e.ok === undefined ? '' : e.ok ? ' (passed)' : ' (failed)'}`); break;
      case 'plan': add(e.from, `stored plan ${e.name} version ${e.version}`); break;
      case 'decision': add(e.from, `plan ${e.name} version ${e.version} was decided`); break;
      case 'plan_sent': add(e.from, `sent plan ${e.name} version ${e.version} to ${e.to ?? 'the room'}`); break;
      case 'task': add(e.from, `task #${e.task.n} ${e.task.title} is ${e.task.status}`); break;
      case 'plan_ask': case 'plan_answer': case 'plan_accept': case 'invite': case 'admit': case 'kick': break; // a card, a wake or the host's
    }
  }
  if (!by.size) return [`Nothing new in ${code} since you last looked.`];
  return [`News in ${code} since you last looked:`, ...[...by].flatMap(([who, lines]) => ['', oneLine(who, 64), ...lines.map(l => `  ${l}`)])];
}

export function registerStatus(on: On): void {
  let shown: readonly string[] = [];
  on('command.run', { command: COMMAND, args: /^\s*news\s*$/ }, async ($, e, next) => {
    const room = session.room;
    if (!room || !session.state) return next(e); // the command answers that this session is in no room
    shown = newsLines(unread(session, 'news'), session.state, room.code);
    const opened = await $.ui.open({ id: NEWS_PANE, title: `${room.code} news`, focus: true, closeOnEscape: true })
      .catch((x: unknown) => ({ isPlaced: false as const, reason: why(x) }));
    if (!opened.isPlaced) { $.ui.log(`news isn't shown here (${opened.reason}); /sub-human who says what each member is doing.`); return {}; }
    session.read.news = session.fed;
    session.held = 0;
    session.shown = statusLine(session.state, room, 0, session.away);
    if (session.hint) $.ui.invalidate('ui.render');
    else $.ui.status(session.shown);
    $.ui.log('news is open; Esc closes it.');
    return {};
  });
  on('ui.render', { component: 'Pane', requestId: NEWS_PANE }, () => ({
    type: 'Box', props: { flexDirection: 'column' },
    children: shown.map(line => ({ type: 'Text', ...(line === shown[0] && { props: { bold: true } }), children: [line] })),
  }));
  // The terminal draws the line at the end of the hint under the prompt: a plugin's `$.ui.status` is drawn as a
  // warning there ("⚠ sub-human: …", docs/internals/v2-status-line.md), which the room's line isn't. Once a terminal
  // draws the hint, `$.ui.status` is cleared and every change of the line redraws the hint instead.
  on('ui.render', { component: 'PromptHint', plugin: '*' }, ($, e, next) => { // the engine's line, no plugin's
    if (e.surface !== 'terminal') return next(e);
    if (!session.hint) { session.hint = true; $.ui.status(undefined); }
    const room = session.room;
    if (!room || !session.state) return next(e);
    const had = e.props.tail ?? '';
    const width = (e.viewport?.columns ?? LINE_COLUMNS) - e.props.hint.length - had.length - SEP.length;
    return next({ ...e, props: { ...e.props, tail: `${had}${SEP}${statusLine(session.state, room, session.held, session.away, width)}` } });
  });
}
