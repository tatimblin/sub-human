// What the plan cards ask and what their answers mean (R18–R22c), pure: plans.ts and plans-review.ts ask the cards,
// read the blobs and make the daemon calls; plans-notes.ts says what Claude is told. The copy fits reviewing someone
// else's plan for any kind of work (R19). plans-pending.ts finds the plan waiting on my answer and draws its pane.
import type { Plan, RoomState } from '../core/entries.js';
import { LIMITS, isHere } from '../core/entries.js';
import { oneLine } from '../core/text.js';
import type { Pending } from './plans-pending.js';
import { summary } from './plans-pending.js';

// the cards' labels: at approval, on sending, and on a review
const [KEEP, ROOM, TO_ROOM, NOBODY, EVERYONE] = ['No', 'Get agreement', 'Send to the room', 'Nobody yet', 'Everyone in the room'];
/** The approval card's question; plans.ts finds the card by it to put each option's line under it. */
export const SHARE_QUESTION = 'Share this plan?';
export const SEND = 'Send it';
export const DONT = "Don't send";
const [AGREE, CHANGES, READ, ACCEPT, DISMISS] = ['Agree', 'Ask for changes', 'Read the full plan', 'Accept', 'Dismiss'];
export const BACK = 'Back to the question';

export interface Card { readonly question: string; readonly options: readonly string[]; readonly multiSelect?: true }

const others = (s: RoomState, me: string) => s.members.filter(m => !m.kicked && m.name !== me);
const memberNamed = (s: RoomState, name: string) => others(s, '').find(m => m.name.toLowerCase() === name.trim().toLowerCase())?.name;
const onPlan = (p: Plan, me: string) => p.versions.some(v => v.from === me || v.asked.includes(me));

/** The words a plan's name leaves out. */
const STOP = new Set('a an the and or of to for in on at by with from into onto via as is are be it its this that these those our my your we plan'.split(' '));
const NAME_MAX = 24;

/**
 * A plan's short name from its first heading or line: its first three meaningful words, at most NAME_MAX characters
 * (`## Finish webography: click a row to expand` → `finish-webography-click`).
 */
export function planName(text: string): string {
  const first = text.split('\n').find(l => /^\s*#/.test(l)) ?? text.split('\n').find(l => l.trim()) ?? '';
  const all = first.replace(/^\s*(?:#+|[-*+]|\d+[.)])\s*/, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const words = all.filter(w => !STOP.has(w));
  let name = '';
  for (const w of (words.length ? words : all).slice(0, 3)) {
    const next = name ? `${name}-${w}` : w;
    if (next.length > NAME_MAX) break;
    name = next;
  }
  return name || (words[0] ?? all[0])?.slice(0, NAME_MAX) || 'plan';
}

/** A next version of a room plan: on which base, and who is asked again. */
export interface Revision { readonly name: string; readonly base: number; readonly people: readonly string[] }
export type Approval =
  | { readonly kind: 'revision'; readonly revision: Revision }
  | { readonly kind: 'ask'; readonly name: string; readonly card: Card; readonly revision?: Revision };

/**
 * At approval (R18). The next version of a room plan this session stored (`stored`: its name → the plan file it came
 * from, '' from the plan tool) is obvious, and asks nothing. Otherwise the person picks: keep it, get agreement (a room
 * plan, then who must agree), or send it (then to whom); first, a new version of a room plan of the same name they
 * are on.
 */
export function approval(s: RoomState, me: string, text: string, file: string, stored: ReadonlyMap<string, string>): Approval {
  const name = [...stored].find(([, f]) => f && f === file)?.[0] ?? planName(text);
  const plan = s.plans.find(p => p.name === name && p.scope === 'group');
  const at = plan?.versions.at(-1);
  const revision = plan && at && onPlan(plan, me) ? { name, base: at.version, people: [...new Set([at.from, ...at.asked])].filter(p => p !== me && memberNamed(s, p)) } : undefined;
  if (revision && stored.has(name)) return { kind: 'revision', revision };
  const options = [...(revision ? [revise(name)] : []), KEEP, ROOM, TO_ROOM];
  return { kind: 'ask', name, card: { question: SHARE_QUESTION, options }, ...(revision && { revision }) };
}

/** The line under an approval option: what picking it does; none for a new version, which says it all. */
export function described(label: string): string | undefined {
  if (label === KEEP) return 'keep it local';
  if (label === ROOM) return 'share for input and approval';
  return label === TO_ROOM ? 'share without waiting on approval' : undefined;
}

const revise = (name: string): string => `New version of ${oneLine(name, 40)}`;

/** A send's `to`: the members it goes to, [] for the whole room, absent while the recipients card is still to ask. */
export type Choice = { readonly kind: 'keep'; readonly line?: string } | { readonly kind: 'room' } | { readonly kind: 'revise' } | { readonly kind: 'send'; readonly to?: readonly string[] };

/** The approval card's answer (null: dismissed, which keeps the plan). */
export function choice(picked: string | null, a: Extract<Approval, { kind: 'ask' }>, s: RoomState, me: string, code: string): Choice {
  if (picked === null || picked === KEEP) return { kind: 'keep' };
  if (picked === ROOM) return { kind: 'room' };
  if (a.revision && picked === revise(a.name)) return { kind: 'revise' };
  if (picked === TO_ROOM) return { kind: 'send' };
  // typed under Other: a member's name sends it to them
  const said = picked.replace(/^\s*send(?: it)? to\s+/i, '').trim();
  if (/^(?:the )?room$/i.test(said)) return { kind: 'send', to: [] };
  const to = memberNamed(s, said);
  if (to && to !== me) return { kind: 'send', to: [to] };
  return { kind: 'keep', line: noMember(code, said) };
}
const noMember = (code: string, said: string): string => `sub-human: ${code} has no member named ${oneLine(said, 64)}; your plan stays yours.`;

/** Who gets a plan sent to the room: each member here, or everyone; null when nobody else is here (it goes to the room). */
export function recipientsCard(s: RoomState, me: string, name: string): Card | null {
  const here = others(s, me).filter(isHere).map(m => m.name);
  if (!here.length) return null;
  return { question: `Who gets ${name}? Pick them, or type a name under Other.`, options: [...here.slice(0, 3), EVERYONE], multiSelect: true };
}

/** The recipients card's answer: the members picked or typed ([] for everyone), or keep the plan (dismissed, nobody known). */
export function recipients(picked: string | null, s: RoomState, me: string, code: string): Extract<Choice, { kind: 'keep' | 'send' }> {
  if (picked === null) return { kind: 'keep' };
  if (picked.includes(EVERYONE)) return { kind: 'send', to: [] };
  const to = [...new Set(picked.split(/[,\s]+/).flatMap(n => memberNamed(s, n) ?? []))].filter(n => n !== me);
  return to.length ? { kind: 'send', to } : { kind: 'keep', line: noMember(code, picked) };
}

/**
 * A name for a plan of mine: the plan's own while nobody's plan has it, else with a number after it, kept within
 * NAME_MAX; never another person's plan. `again` is the name this session stored this same plan file under: a
 * personal plan of mine keeps it (sending it again), so a different plan is never the next version of an old one.
 */
export function freeName(s: RoomState, name: string, me: string, scope: Plan['scope'], again?: string): { readonly name: string; readonly base: number } {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const tried = `${name.slice(0, NAME_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    const plan = s.plans.find(p => p.name === tried);
    if (!plan) return { name: tried, base: 0 };
    const mine = scope === 'personal' && tried === again && plan.scope === scope && plan.versions.every(v => v.from === me);
    if (mine) return { name: tried, base: plan.versions.at(-1)?.version ?? 0 };
  }
}

/** Who to ask to agree, members here first; null when there is nobody to ask. */
export function reviewersCard(s: RoomState, me: string, name: string, version: number): Card | null {
  const names = [...others(s, me)].sort((a, b) => Number(isHere(b)) - Number(isHere(a))).map(m => m.name);
  if (!names.length) return null;
  return { question: `Who should agree on ${name} v${version}? Pick them, or type names under Other.`, options: [...names.slice(0, 3), NOBODY], multiSelect: true };
}

/** The members a reviewers answer names, comma-joined labels or typed names. */
export function reviewers(picked: string | null, s: RoomState, me: string): string[] {
  const named = (picked ?? '').split(/[,\s]+/).flatMap(n => memberNamed(s, n) ?? []);
  return [...new Set(named)].filter(n => n !== me);
}

/** The note card before a send to `to` (names, or 'the room'). */
export function sendCard(name: string, to: string): Card {
  return { question: `Send ${name} to ${to}? Type a note for them under Other, or send it as it is.`, options: [SEND, DONT] };
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
