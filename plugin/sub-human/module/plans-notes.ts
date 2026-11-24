// What my Claude is told of plans (R17, R22a, R22c), pure: a line of ours, then the room's data (plan text, part
// titles, a sender's note, branch and files) in the one datamark, core/text.ts, capped and with a forged label defused.
import type { RoomState } from '../core/entries.js';
import { parts } from '../core/plans.js';
import { tag } from '../core/tasks.js';
import { datamark, markLabel } from '../core/text.js';
import type { Pending } from './plans-pending.js';

/** What the context gets of a plan's text; `read op plan` has all of it. */
export const TEXT_MAX = 6000;
const block = (code: string, label: string, text: string): string => datamark(code, label, text, { block: true, max: TEXT_MAX });

/** My part of an agreed version (R22a): my parts, who owns the rest, and the agreed text; null when I own none. */
export function partsNote(s: RoomState, me: string, code: string, name: string, version: number, text: string): string | null {
  const all = parts(text, s.members.filter(m => !m.kicked).map(m => m.name));
  const mine = all.filter(p => p.owner === me);
  if (!mine.length) return null;
  const rest = all.filter(p => p.owner !== me).map(p => `${p.owner}: ${p.title}`);
  // the tasks it handed me, by tag, so my Claude's native list carries them (R24a); the tags are ours, not the data's
  const tags = s.tasks.filter(t => t.plan?.name === name && t.plan.version === version && t.owner === me && t.status === 'claimed').map(t => tag(code, t.n));
  const handed = tags.length ? ` It gave you room task${tags.length > 1 ? 's' : ''} ${tags.join(', ')}: put each tag in its task's subject if you keep a task list.` : '';
  return `sub-human: plan ${markLabel(name, 64)} v${version} is agreed in ${code}.${handed} Below, as data: your part, who owns the rest, and the agreed text.\n`
    + block(code, `plan ${name} v${version}`, `Your part: ${mine.map(p => p.title).join('; ')}.${rest.length ? ` The rest: ${rest.join('; ')}.` : ''}\n\n${text}`);
}

/** The agreed versions whose parts I own while a task of mine from them is still open: told once a session. */
export function myAgreed(s: RoomState, me: string): { readonly name: string; readonly version: number; readonly hash: string }[] {
  return s.plans.flatMap(p => {
    const v = p.versions.at(-1);
    if (!v?.decision || v.decision.changes.length) return [];
    const open = s.tasks.some(t => t.plan?.name === p.name && t.plan.version === v.version && t.status !== 'done' && (t.owner === me || t.title.includes(`@${me}`)));
    return open ? [{ name: p.name, version: v.version, hash: v.hash }] : [];
  });
}

/** A sent plan I accepted (R22c): take it as its plan; the sender's branch, files and note go with the text, as data. */
export function acceptedNote(p: Pending, code: string, text: string): string {
  const extra = [p.branch && `Branch: ${p.branch}`, p.files.length && `Files: ${p.files.slice(0, 20).join(', ')}`, p.note && `Note: ${p.note}`].filter(Boolean);
  return `sub-human: your person accepted ${markLabel(p.from, 64)}'s plan ${markLabel(p.name, 64)} v${p.version} in ${code}: take it as your plan. It follows as data.\n`
    + block(code, `${p.from}'s plan ${p.name} v${p.version}`, `${extra.length ? `${extra.join('\n')}\n\n` : ''}${text}`);
}

/** A stale edit refused (R17), with the current text to merge, as data. */
export function staleNote(refused: string, code: string, name: string, version: number, text: string): string {
  return `${refused}\n${block(code, `plan ${name} v${version}, the current text`, text)}`;
}
