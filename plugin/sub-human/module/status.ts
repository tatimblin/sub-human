// status: what the person sees of the room without asking (R15b). The status line names who else is here and counts
// the updates since they last looked; `/sub-human news` opens a pane with those updates, drawn here with no model
// call, and clears the count. follow.ts fills `session.unseen` and draws the line; this file draws the pane.
import type { On } from 'claude-code';
import type { Input } from '../core/deliver.js';
import type { Member, RoomState } from '../core/entries.js';
import { oneLine } from '../core/text.js';
import { COMMAND, session } from './session.js';

/** The pane's id; one news pane at a time. */
export const NEWS_PANE = 'sub-human-news';
const FOCUS_MAX = 24;
const LINE_MAX = 300;

/**
 * `CODE · bob (working on paging), carol here · 1 task · 2 updates`: who else is here (or that the host is away, R34,
 * when nobody's presence can be known), my open room tasks (R24), and what I haven't seen.
 */
export function statusLine(room: RoomState, me: { readonly code: string; readonly name: string }, count: number, away = false): string {
  const here = room.members.filter(m => m.name !== me.name && !m.kicked && m.machines.length > 0).map(doing);
  const tasks = room.tasks.filter(t => t.owner === me.name && t.status !== 'done').length;
  return [
    me.code, ...(away ? ['host away'] : here.length ? [`${here.join(', ')} here`] : []), ...plural(tasks, 'task'), ...plural(count, 'update'),
  ].join(' · ');
}
const plural = (n: number, word: string): string[] => (n ? [`${n} ${word}${n === 1 ? '' : 's'}`] : []);

function doing(m: Member): string {
  if (m.presence?.waiting) return `${m.name} (waiting)`;
  if (m.presence?.state !== 'working') return m.name;
  return m.focus ? `${m.name} (working on ${oneLine(m.focus.text, FOCUS_MAX)})` : `${m.name} (working)`;
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
    if (u.kind !== 'entry') continue;
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
  on('prompt.submit', { command: { name: COMMAND, args: /^\s*news\s*$/ } }, async ($, e, next) => {
    const room = session.room;
    if (!room || !session.state) return next(e); // the command answers that this session is in no room
    shown = newsLines(session.unseen, session.state, room.code);
    const opened = await $.ui.open({ id: NEWS_PANE, title: `${room.code} news`, focus: true, closeOnEscape: true })
      .catch((x: unknown) => ({ isPlaced: false as const, reason: String(x).slice(0, 200) }));
    if (!opened.isPlaced) return { drop: `sub-human: news isn't shown here (${opened.reason}); /sub-human who says what each member is doing.` };
    session.unseen = [];
    session.count = 0;
    session.shown = statusLine(session.state, room, 0, session.away);
    $.ui.status(session.shown);
    return { drop: 'sub-human: news is open; Esc closes it.' };
  });
  on('ui.render', { component: 'Pane', requestId: NEWS_PANE }, () => ({
    type: 'Box', props: { flexDirection: 'column' },
    children: shown.map(line => ({ type: 'Text', ...(line === shown[0] && { props: { bold: true } }), children: [line] })),
  }));
}
