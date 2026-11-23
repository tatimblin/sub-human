// A plan waiting on my answer (R21, R22c), pure: which one comes next, what changed since the version I last saw, and
// the plan pane's lines. plans-review.ts asks the cards (plans-cards.ts) and shows the pane.
import type { RoomState } from '../core/entries.js';
import { oneLine } from '../core/text.js';
import { planDiff } from './plan-diff.js';

/** A plan waiting on my answer: a version I was asked to agree on, or a plan sent to me or the room. */
export interface Pending {
  readonly kind: 'review' | 'sent';
  readonly key: string;
  readonly name: string;
  readonly version: number;
  readonly from: string;
  readonly hash: string;
  /** The version I last saw (authored, was asked on or answered), to summarize and diff against. */
  readonly before?: { readonly version: number; readonly hash: string };
  readonly note?: string;
  readonly branch?: string;
  readonly files: readonly string[];
}

export function nextPending(s: RoomState, me: string, skip: ReadonlySet<string>): Pending | null {
  for (const p of s.plans) {
    const v = p.versions.at(-1);
    if (!v || v.decision || v.from === me || !v.asked.includes(me) || v.answers.some(a => a.name === me)) continue;
    const key = `review:${p.name}:${v.version}`;
    if (skip.has(key)) continue;
    const seen = p.versions.filter(x => x.version < v.version && (x.from === me || x.asked.includes(me))).at(-1);
    return { kind: 'review', key, name: p.name, version: v.version, from: v.from, hash: v.hash, files: [], ...(seen && { before: { version: seen.version, hash: seen.hash } }) };
  }
  for (const x of s.sent) {
    const key = `sent:${x.from}:${x.name}:${x.version}`;
    const v = s.plans.find(p => p.name === x.name)?.versions.find(y => y.version === x.version);
    if (x.from === me || (x.to ?? me) !== me || x.answers.some(a => a.name === me) || skip.has(key) || !v) continue;
    return { kind: 'sent', key, name: x.name, version: x.version, from: x.from, hash: v.hash, files: x.files, ...(x.note && { note: x.note }), ...(x.branch && { branch: x.branch }) };
  }
  return null;
}

/** What changed since the version I last saw, in a few words. */
export function summary(p: Pending, before: string | null, after: string): string {
  if (before === null) return `${after.split('\n').filter(l => l.trim()).length} lines, new to you`;
  const diff = planDiff(p.name, before, after).split('\n');
  const added = diff.filter(l => l.startsWith('+')).map(l => l.slice(1));
  const removed = diff.filter(l => l.startsWith('-')).length;
  if (!added.length && !removed) return `no change since v${p.before?.version ?? 0}`;
  const first = added.find(l => l.trim());
  return `since v${p.before?.version ?? 0}: ${added.length} line${added.length === 1 ? '' : 's'} added, ${removed} removed${first ? `, first "${oneLine(first, 80)}"` : ''}`;
}

/** The pane's lines: who and which version, the diff since the version I last saw, then the whole text. */
export function paneLines(p: Pending, before: string | null, after: string): string[] {
  const head = `Plan ${p.name} v${p.version} by ${p.from}`;
  const diff = before === null ? ['New to you: no earlier version to compare.'] : [`Changes since v${p.before?.version ?? 0}:`, ...planDiff(p.name, before, after).split('\n').filter(l => l)];
  return [head, '', ...diff, '', 'The full plan:', ...after.split('\n')];
}
