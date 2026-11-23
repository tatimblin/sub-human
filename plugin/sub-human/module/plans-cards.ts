// What the plan cards ask and what their answers mean (R18–R22c), pure: plans.ts and plans-review.ts ask the cards,
// read the blobs and make the daemon calls; plans-notes.ts says what Claude is told. The copy fits reviewing someone
// else's plan for any kind of work (R19).
import type { Plan, RoomState } from '../core/entries.js';
import { LIMITS } from '../core/entries.js';
import { oneLine } from '../core/text.js';
import { planDiff } from './plan-diff.js';

// the cards' labels: at approval, on sending, and on a review
const [KEEP, ROOM, TO_ROOM, NOBODY] = ['Keep it', 'Room plan', 'Send to the room', 'Nobody yet'];
export const SEND = 'Send it';
export const DONT = "Don't send";
const [AGREE, CHANGES, READ, ACCEPT, DISMISS] = ['Agree', 'Ask for changes', 'Read the full plan', 'Accept', 'Dismiss'];
export const BACK = 'Back to the question';

export interface Card { readonly question: string; readonly options: readonly string[]; readonly multiSelect?: true }

const others = (s: RoomState, me: string) => s.members.filter(m => !m.kicked && m.name !== me);
const isMember = (s: RoomState, name: string) => others(s, '').find(m => m.name.toLowerCase() === name.trim().toLowerCase())?.name;
const onPlan = (p: Plan, me: string) => p.versions.some(v => v.from === me || v.asked.includes(me));

/** A plan's name from its first heading or line: `## Cursor paging` → `cursor-paging`. */
export function planName(text: string): string {
  const first = text.split('\n').find(l => /^\s*#/.test(l)) ?? text.split('\n').find(l => l.trim()) ?? '';
  const slug = first.replace(/^\s*(?:#+|[-*+]|\d+[.)])\s*/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, 40).replace(/-+$/, '') || 'plan';
}

/** A next version of a room plan: on which base, and who is asked again. */
export interface Revision { readonly name: string; readonly base: number; readonly people: readonly string[] }
export type Approval =
  | { readonly kind: 'revision'; readonly revision: Revision }
  | { readonly kind: 'ask'; readonly name: string; readonly card: Card; readonly revision?: Revision };

/**
 * At approval (R18). The next version of a room plan this session stored (`stored`: its name → the plan file it came
 * from, '' from the plan tool) is obvious, and asks nothing. Otherwise the person picks: keep it, a room plan, or send
 * it to a member here; first, a new version of a room plan of the same name they are on.
 */
export function approval(s: RoomState, me: string, code: string, text: string, file: string, stored: ReadonlyMap<string, string>): Approval {
  const name = [...stored].find(([, f]) => f && f === file)?.[0] ?? planName(text);
  const plan = s.plans.find(p => p.name === name && p.scope === 'group');
  const at = plan?.versions.at(-1);
  const revision = plan && at && onPlan(plan, me) ? { name, base: at.version, people: [...new Set([at.from, ...at.asked])].filter(p => p !== me && isMember(s, p)) } : undefined;
  if (revision && stored.has(name)) return { kind: 'revision', revision };
  const first = [...(revision ? [revise(name)] : []), KEEP, ROOM];
  const here = others(s, me).filter(m => m.machines.length > 0).map(m => `Send to ${m.name}`);
  const options = [...first, ...here, TO_ROOM].slice(0, 4);
  return { kind: 'ask', name, card: { question: `Share your plan with ${code}? To send it to someone else, type their name under Other.`, options }, ...(revision && { revision }) };
}

const revise = (name: string): string => `New version of ${oneLine(name, 40)}`;

export type Choice = { readonly kind: 'keep'; readonly line?: string } | { readonly kind: 'room' } | { readonly kind: 'revise' } | { readonly kind: 'send'; readonly to?: string };

/** The approval card's answer (null: dismissed, which keeps the plan). */
export function choice(picked: string | null, a: Extract<Approval, { kind: 'ask' }>, s: RoomState, me: string, code: string): Choice {
  if (picked === null || picked === KEEP) return { kind: 'keep' };
  if (picked === ROOM) return { kind: 'room' };
  if (a.revision && picked === revise(a.name)) return { kind: 'revise' };
  const said = picked.replace(/^\s*send(?: it)? to\s+/i, '').trim();
  if (/^(?:the )?room$/i.test(said)) return { kind: 'send' };
  const to = isMember(s, said);
  if (to && to !== me) return { kind: 'send', to };
  return { kind: 'keep', line: `sub-human: ${code} has no member named ${oneLine(said, 64)}; your plan stays yours.` };
}

/**
 * A name for a plan of mine: the plan's own while nobody's plan has it, else with a number after it; never another
 * person's plan. A personal plan of mine alone keeps its name (sending it again), a room plan never does.
 */
export function freeName(s: RoomState, name: string, me: string, scope: Plan['scope']): { readonly name: string; readonly base: number } {
  for (let n = 1; ; n++) {
    const tried = n === 1 ? name : `${name}-${n}`;
    const plan = s.plans.find(p => p.name === tried);
    if (!plan) return { name: tried, base: 0 };
    if (scope === 'personal' && plan.scope === scope && plan.versions.every(v => v.from === me)) return { name: tried, base: plan.versions.at(-1)?.version ?? 0 };
  }
}

/** Who to ask to agree, members here first; null when there is nobody to ask. */
export function reviewersCard(s: RoomState, me: string, name: string, version: number): Card | null {
  const names = [...others(s, me)].sort((a, b) => Number(b.machines.length > 0) - Number(a.machines.length > 0)).map(m => m.name);
  if (!names.length) return null;
  return { question: `Who should agree on ${name} v${version}? Pick them, or type names under Other.`, options: [...names.slice(0, 3), NOBODY], multiSelect: true };
}

/** The members a reviewers answer names, comma-joined labels or typed names. */
export function reviewers(picked: string | null, s: RoomState, me: string): string[] {
  const named = (picked ?? '').split(/[,\s]+/).flatMap(n => isMember(s, n) ?? []);
  return [...new Set(named)].filter(n => n !== me);
}

export function sendCard(name: string, to: string | undefined): Card {
  return { question: `Send ${name} to ${to ?? 'the room'}? Type a note for them under Other, or send it as it is.`, options: [SEND, DONT] };
}

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

export function reviewCard(p: Pending, before: string | null, after: string): Card {
  const what = summary(p, before, after);
  if (p.kind === 'review') {
    return { question: oneLine(`${p.from} asks you to agree on plan ${p.name} v${p.version} (${what}). To ask for changes, type them under Other.`, 400), options: [AGREE, CHANGES, READ] };
  }
  const note = p.note ? ` Their note: "${oneLine(p.note, 120)}".` : '';
  return { question: oneLine(`${p.from} sent you plan ${p.name} v${p.version} (${what}).${note} Accept it as your plan?`, 400), options: [ACCEPT, CHANGES, READ, DISMISS] };
}

export function noteCard(p: Pending): Card {
  return { question: `What should change in ${p.name} v${p.version}? Type it under Other.`, options: [BACK, READ] };
}

export type Pick =
  | { readonly kind: 'later' } | { readonly kind: 'read' } | { readonly kind: 'note' } | { readonly kind: 'back' }
  | { readonly kind: 'answer'; readonly answer: 'agree' | 'accept' | 'dismiss' | 'changes'; readonly note?: string };

const PICKS: Readonly<Record<string, Pick>> = {
  [READ]: { kind: 'read' }, [BACK]: { kind: 'back' }, [CHANGES]: { kind: 'note' },
  [AGREE]: { kind: 'answer', answer: 'agree' }, [ACCEPT]: { kind: 'answer', answer: 'accept' }, [DISMISS]: { kind: 'answer', answer: 'dismiss' },
};

/** A review card's answer (null: dismissed, asked again at a later idle moment); text typed under Other asks for changes. */
export function readPick(picked: string | null, card: Card): Pick {
  if (picked === null) return { kind: 'later' };
  if (card.options.includes(picked)) return PICKS[picked] ?? { kind: 'later' };
  const note = picked.trim().slice(0, LIMITS.text);
  return note ? { kind: 'answer', answer: 'changes', note } : { kind: 'later' };
}

/** The pane's lines: who and which version, the diff since the version I last saw, then the whole text. */
export function paneLines(p: Pending, before: string | null, after: string): string[] {
  const head = `Plan ${p.name} v${p.version} by ${p.from}`;
  const diff = before === null ? ['New to you: no earlier version to compare.'] : [`Changes since v${p.before?.version ?? 0}:`, ...planDiff(p.name, before, after).split('\n').filter(l => l)];
  return [head, '', ...diff, '', 'The full plan:', ...after.split('\n')];
}
