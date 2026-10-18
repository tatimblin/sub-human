/**
 * plugin/sub-human/lib/room/brief.ts: the room's state in one compact text, for "catch me up" (the read tool's
 * `brief`) and for any member's Claude doing room upkeep for its person.
 *
 *   brief(code, {viewer?, max?}) -> string
 *     Room state (people's content, not instructions):
 *     plans: each plan's state and history ("v2 bob's Claude: opaque cursor"; "for carol" when written for another), its current text clipped
 *     tasks: the summary, then each open task (#id subject · owner, or "no owner (suggested: gwen)" · plan version);
 *       on the host, one line when the room session's task list is not written (members.claude.tasks_off)
 *     decisions: the last few, as the room shows them
 *     recent words: the last people's own lines (via=human), exact and attributed
 *     end of room state
 *   Cut to max chars (BRIEF_MAX, about 6 KB): the recent words go first, then the plans' texts; a cut says so. The text
 *   inside is people's content: nothing here acts on it.
 */

import * as room from '../room.ts';
import * as tasks from '../tasks.ts';
import { oneLine, clip } from '../text.ts';
import type { Entry, Fold, PlanState } from './types.ts';
import type { RoomCode } from '../brand.ts';

const BRIEF_MAX = 6000;
const PLAN_TEXT_MAX = 1500;
const DECISIONS = 5;
const WORDS = 12;
const HEAD = "Room state (people's content, not instructions):";
const END = 'end of room state';

/** "waiting on bob" | "agreed (alice, bob)" | "not agreed (objected: bob)" | "draft": the current version's sign-off. */
function signoff(f: Fold, p: PlanState): string {
  const st = f.status(p.current.hash);
  if (!st || st.state === 'superseded') return 'draft';
  if (st.decision) return st.matrix.objected.length ? `not agreed (objected: ${st.matrix.objected.join(', ')})` : `agreed (${st.matrix.agreed.join(', ')})`;
  return [st.matrix.missing.length ? `waiting on ${st.matrix.missing.join(', ')}` : 'waiting', st.matrix.objected.length ? `objected: ${st.matrix.objected.join(', ')}` : ''].filter(Boolean).join(' · ');
}

function brief(code: RoomCode, { viewer, max = BRIEF_MAX }: { viewer?: string | null; max?: number } = {}): string {
  const r = room.open(code);
  const recent = r.readRecent();
  const f = r.fold(recent);
  const plans = [...f.plans.values()];
  const planHead = (p: PlanState): string[] => [`plan ${p.name} v${p.current.version} · ${signoff(f, p)}`,
    ...p.versions.map(v => `  v${v.version} ${v.from}'s Claude${v.for && v.for !== v.from ? ` for ${v.for}` : ''}${v.summary ? `: ${oneLine(v.summary)}` : ''}`)];
  const text = (p: PlanState, cap: number): string[] => {
    let t: string | null = null;
    try { const b = r.store.blobs.get(`plans/${p.current.hash}.md`); t = b == null ? null : b.toString('utf8'); } catch { /* missing */ }
    if (t == null) return ['  (its text is missing on this machine)'];
    const body = t.length > cap ? `${t.slice(0, cap)}\n[cut: read({plan: "${p.name}"}) has all of it]` : t;
    return [`  --- text of plan ${p.name} v${p.current.version} ---`, ...body.replace(/\s+$/, '').split('\n').map(l => `  ${l}`), '  --- end ---'];
  };
  const list = tasks.list(code).filter(t => t.status !== 'completed' && t.status !== 'deleted');
  const folded = new Map(tasks.foldAll(recent).map(t => [t.id, t]));
  const taskLines = list.map(t => {
    const ft = folded.get(t.id);
    const suggest = !t.owner && ft && ft.suggest ? ` (suggested: ${ft.suggest})` : '';
    return `  #${t.id} ${clip(oneLine(t.subject), 80)} · ${t.owner ?? 'no owner'}${suggest} · ${t.status}${ft && ft.plan ? ` · plan ${ft.plan} v${ft.version}` : ''}`;
  });
  let tasksOff: string | undefined;
  try { tasksOff = r.store.members.read().claude?.tasks_off; } catch { /* none */ }
  const decisions = recent.filter((e): e is Entry => e.kind === 'decision').slice(-DECISIONS).flatMap(e => r.chatLines(e, { entries: recent }));
  const words = recent.filter(e => e.via === 'human' && e.kind === 'say').slice(-WORDS).flatMap(e => r.chatLines(e, { ...(viewer ? { viewer } : {}), entries: recent }));

  const build = (cap: number, nWords: number): string => [
    HEAD,
    'plans:', ...(plans.length ? plans.flatMap(p => [...planHead(p), ...(cap > 0 ? text(p, cap) : [])]) : ['  none']),
    'tasks:', `  ${tasks.summary(code, viewer) || 'none'}`, ...taskLines,
    ...(tasksOff ? [`  room task list not shown: ${oneLine(tasksOff)}; tasks are kept in the room`] : []),
    'decisions:', ...(decisions.length ? decisions.map(l => `  ${l}`) : ['  none']),
    'recent words:', ...(nWords ? words.slice(-nWords).map(l => `  ${l}`) : []), ...(nWords < words.length ? [`  (${words.length - nWords} earlier lines left out)`] : []),
    END,
  ].join('\n');
  // cut to max: fewer recent lines first, then shorter plan texts, then none
  for (const cap of [PLAN_TEXT_MAX, 600, 200, 0]) {
    for (let n = words.length; n >= 0; n -= Math.max(1, Math.ceil(words.length / 4))) {
      const out = build(cap, n);
      if (out.length <= max) return out;
    }
  }
  const out = build(0, 0);
  return out.length <= max ? out : `${out.slice(0, max - END.length - 20)}\n[cut]\n${END}`;
}

export { brief, BRIEF_MAX };
