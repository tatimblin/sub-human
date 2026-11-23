// plans: the room's plan rules (R17, R20–R22c), pure. Each takes the RoomState and one request and returns the entries
// the host appends, or a refusal written as what didn't happen. Plan text is a content-addressed blob: the caller
// hashes a new text, and passes `texts` to read a stored one when a decision needs its parts. The rules agree with
// fold: a version is the previous one plus 1, the first version's scope is the plan's, and only the latest version
// takes asks and answers (R22).
import type { PlanAct } from './api.js';
import type { Acceptance, Answer, Draft, Plan, PlanAnswerRecord, PlanScope, PlanVersion, RoomState, Task } from './entries.js';
import { err, ok, type Result } from './result.js';
import { LIMITS } from './entries.js';
import { entry, nextN, unclaimed } from './tasks.js';

/** Reads a stored plan text by its hash. */
export type Texts = (hash: string) => string;

/** A plan's latest version, which an edit's `base` must name; a refused edit reads it here to merge. */
export function latestVersion(s: RoomState, name: string): { readonly version: number; readonly hash: string } | null {
  const v = s.plans.find(p => p.name === name)?.versions.at(-1);
  return v ? { version: v.version, hash: v.hash } : null;
}

export interface Edit { readonly name: string; readonly base: number; readonly hash: string; readonly from: string; readonly scope?: PlanScope }

/** Compare-and-swap on `base`, the version the edit was made on (0 for a new plan): a stale base is refused (R17). */
export function edit(s: RoomState, e: Edit): Result<Draft[]> {
  const { name } = e;
  if (!name.trim() || name.length > LIMITS.name) return err(`No plan was stored: a plan's name is 1 to ${LIMITS.name} characters.`);
  if (!e.hash || e.hash.length > LIMITS.short) return err(`Plan ${name} was not stored: its text has no valid hash.`);
  const plan = s.plans.find(p => p.name === name);
  const at = latestVersion(s, name);
  const base = at?.version ?? 0;
  if (e.base !== base) {
    return err(at ? `Plan ${name} was not stored: it is at v${base}, not v${e.base}; merge your edit into v${base} and edit on base ${base}.` : `Plan ${name} was not stored: it is new, so edit it on base 0.`);
  }
  if (e.hash === at?.hash) return err(`Plan ${name} was not stored: v${base} already has this text.`);
  return ok([{ kind: 'plan', from: e.from, by: 'system', name, version: base + 1, hash: e.hash, base, scope: plan?.scope ?? e.scope ?? 'group' }]);
}

export interface Ask { readonly name: string; readonly version: number; readonly people: readonly string[]; readonly from: string }

/** Ask named members to agree to one exact version, the latest. Asking oneself is dropped. */
export function ask(s: RoomState, a: Ask): Result<Draft[]> {
  const what = 'Nobody was asked';
  const at = open(s, a.name, a.version, what);
  if (!at.ok) return at;
  const people = [...new Set(a.people)].filter(p => p !== a.from);
  const strangers = people.filter(p => !isMember(s, p));
  if (strangers.length) return err(`${what}: ${strangers.join(', ')} ${strangers.length > 1 ? 'are' : 'is'} not in the room.`);
  if (!people.length) return err(`${what}: name the people to ask.`);
  if (new Set([...at.value.version.asked, ...people]).size > LIMITS.names) return err(`${what}: a version can ask at most ${LIMITS.names} people.`);
  return ok([{ kind: 'plan_ask', from: a.from, by: 'claude', name: a.name, version: a.version, people }]);
}

export interface AnswerIn { readonly name: string; readonly version: number; readonly from: string; readonly answer: Answer; readonly note?: string }

/** A person's answer, for that version only; a second answer before the decision replaces the first. */
export function answer(s: RoomState, a: AnswerIn, texts: Texts): Result<Draft[]> {
  const what = 'Your answer was not recorded';
  const at = open(s, a.name, a.version, what);
  if (!at.ok) return at;
  const { plan, version } = at.value;
  if (!version.asked.includes(a.from) || !isMember(s, a.from)) return err(`${what}: you were not asked about ${a.name} v${a.version}.`);
  const bad = checkNote(what, a.answer, a.note);
  if (bad) return err(bad);
  const mine: Draft = { kind: 'plan_answer', from: a.from, by: 'person', name: a.name, version: a.version, answer: a.answer, ...noted(a.note) };
  const answers = [...version.answers.filter(x => x.name !== a.from), { name: a.from, answer: a.answer }];
  return ok([mine, ...decision(s, plan, version, answers, a.from, texts)]);
}

/**
 * The decision on a plan's latest version once everyone named who is still a member has answered, else nothing. The
 * last answer calls it; the host calls it after a kick, since a kicked member who was asked never blocks a decision.
 * A version nobody answered is never decided, even when everyone asked was kicked: no work is handed out on nobody's
 * agreement (R27), and its writer can ask someone else about it or write the next version.
 */
export function decide(s: RoomState, name: string, from: string, texts: Texts): Draft[] {
  const plan = s.plans.find(p => p.name === name);
  const v = plan?.versions.at(-1);
  return plan && v && !v.decision ? decision(s, plan, v, v.answers, from, texts) : [];
}

export interface Send {
  readonly name: string;
  readonly version?: number;
  readonly from: string;
  readonly to?: string;
  readonly note?: string;
  readonly branch?: string;
  readonly files?: readonly string[];
}

/** Send a version (the latest by default) to one member, or with no `to`, to the room (R22b). */
export function send(s: RoomState, m: Send): Result<Draft[]> {
  const what = 'No plan was sent';
  const latest = latestVersion(s, m.name)?.version;
  if (latest === undefined) return err(`${what}: there is no plan ${m.name}.`);
  const version = m.version ?? latest;
  if (version < 1 || version > latest) return err(`${what}: plan ${m.name} has no v${version}.`);
  if (m.to === m.from) return err(`${what}: you can't send a plan to yourself.`);
  if (m.to !== undefined && !isMember(s, m.to)) return err(`${what}: ${m.to} is not in the room.`);
  const files = [...new Set(m.files ?? [])];
  if (files.length > LIMITS.files || files.some(f => f.length > LIMITS.short)) return err(`${what}: it can name at most ${LIMITS.files} files of ${LIMITS.short} characters.`);
  if (m.branch && m.branch.length > LIMITS.short) return err(`${what}: the branch name is over ${LIMITS.short} characters.`);
  const bad = checkNote(what, 'accept', m.note);
  if (bad) return err(bad);
  return ok([{
    kind: 'plan_sent', from: m.from, by: 'person', name: m.name, version, files,
    ...(m.to !== undefined && { to: m.to }), ...(m.branch ? { branch: m.branch } : {}), ...noted(m.note),
  }]);
}

export interface Accept { readonly name: string; readonly version: number; readonly from: string; readonly answer: Acceptance; readonly note?: string }

/** The recipient's accept, dismiss, or ask for changes (with a note) on a plan sent to them or the room (R22c). */
export function accept(s: RoomState, a: Accept): Result<Draft[]> {
  const what = 'Your answer was not recorded';
  const mine = s.sent.some(x => x.name === a.name && x.version === a.version && x.from !== a.from && (x.to ?? a.from) === a.from);
  if (!mine) return err(`${what}: nobody sent you ${a.name} v${a.version}.`);
  const bad = checkNote(what, a.answer, a.note);
  if (bad) return err(bad);
  return ok([{ kind: 'plan_accept', from: a.from, by: 'person', name: a.name, version: a.version, answer: a.answer, ...noted(a.note) }]);
}

/**
 * What the host appends for one member's plan act (net/daemon/rooms.ts, and the kit's daemon), or a stale edit's
 * refusal, which is an answer and not an error. `hash` is an edit's text hashed; `texts` reads a stored text.
 */
export function applyPlan(s: RoomState, req: { readonly code: string; readonly from: string } & PlanAct, hash: string, texts: Texts): Result<{ readonly drafts: Draft[] } | { readonly refused: string }> {
  if (!isMember(s, req.from)) return err(`${req.from} is not in ${req.code}; nothing was written`);
  let drafts: Result<Draft[]>;
  switch (req.act) {
    case 'edit': {
      const d = edit(s, { ...req, hash });
      return d.ok ? ok({ drafts: d.value }) : ok({ refused: d.error });
    }
    case 'ask': drafts = ask(s, req); break;
    case 'answer': drafts = answer(s, req, texts); break;
    case 'send': drafts = send(s, req); break;
    case 'accept': drafts = accept(s, req); break;
  }
  return drafts.ok ? ok({ drafts: drafts.value }) : drafts;
}

/** A part of a plan with its owner. `title` is the line without the owner's name, `line` the line as written. */
export interface Part { readonly title: string; readonly line: string; readonly owner: string }

// A part is a heading or list item that names a room member as `@NAME`, `owner: NAME` or `(owner: NAME)`, in any case:
// `## Store (owner: tristan)`, `- @jess the HTTP handler`. The first member named owns it. With one name, the title is
// the line without it (and without a leading `Part:`); with more (`@ann and @bob`) the line stays whole. Names inside
// inline code or a code fence, names that aren't members, and ticked `[x]` items don't count.
const ITEM = /^\s{0,3}(?:#{1,6}|[-*+](?:\s+\[([ xX])\])?|\d+[.)])\s+(.+)$/;
const OWNER = /\(\s*owner:\s*@?([\w.-]+?)\s*\)|\bowner:\s*@?([\w.-]+)|(?<![\w@])@([\w.-]+)/gi;

export function parts(text: string, members: readonly string[]): readonly Part[] {
  const out: Part[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : ITEM.exec(line);
    const body = m?.[2];
    if (body === undefined || m?.[1]?.toLowerCase() === 'x') continue;
    let owner: string | undefined;
    let named = 0;
    const rest = body.split(/(`[^`]*`)/).map((seg, i) => (i % 2 ? seg : seg.replace(OWNER, (all: string, ...groups: unknown[]) => {
      const said = groups.slice(0, 3).find((g): g is string => typeof g === 'string')?.replace(/\.+$/, '').toLowerCase();
      const who = members.find(n => n.toLowerCase() === said);
      if (!who) return all;
      named++;
      owner ??= who;
      return ' ';
    }))).join('');
    if (!owner) continue;
    const title = clean(named === 1 ? rest : body) || `${owner}'s part`;
    if (!out.some(p => p.title === title)) out.push({ title, line: clean(body), owner });
  }
  return out;
}

function clean(s: string): string {
  return s.replace(/^\s*part\s*:\s*/i, '').replace(/[*`]/g, '').replace(/\s+/g, ' ').replace(/^[\s:,–—-]+|[\s:,–—-]+$/g, '').slice(0, LIMITS.short);
}

function decision(s: RoomState, plan: Plan, v: PlanVersion, answers: readonly Pick<PlanAnswerRecord, 'name' | 'answer'>[], from: string, texts: Texts): Draft[] {
  const of = (p: string) => answers.find(x => x.name === p)?.answer;
  if (!answers.length || v.asked.some(p => isMember(s, p) && !of(p))) return [];
  const agreed = v.asked.filter(p => of(p) === 'agree');
  const changes = v.asked.filter(p => of(p) === 'changes');
  const d: Draft = { kind: 'decision', from, by: 'system', name: plan.name, version: v.version, agreed, changes };
  return [d, ...(changes.length ? [] : partTasks(s, plan, v, texts(v.hash), from))];
}

/**
 * Owned parts as tasks linked to the agreed version (R20). An owner who wrote or was asked about it gets the task
 * claimed; anyone else gets it open with their name left in the title, since work isn't handed to someone who never
 * agreed (R27). A part already on the list (same plan, same title) moves to this version, and a claim is never moved
 * to someone else. A task whose part is gone leaves the plan, an ordinary room task now: released when its owner
 * wrote or was asked about this version, and left with an owner who never was, since their claim isn't undone on an
 * agreement they had no say in.
 */
function partTasks(s: RoomState, plan: Plan, v: PlanVersion, text: string, from: string): Draft[] {
  const members = s.members.filter(m => !m.kicked).map(m => m.name);
  const agreed = new Set([v.from, ...v.asked].filter(p => isMember(s, p)));
  const link = { name: plan.name, version: v.version };
  const mine = s.tasks.filter(t => t.plan?.name === plan.name);
  const kept = new Set<number>();
  let n = nextN(s.tasks);
  const out = parts(text, members).flatMap((part): Draft[] => {
    const ours = agreed.has(part.owner);
    const old = mine.find(t => !kept.has(t.n) && (t.title === part.title || t.title === part.line));
    if (old) kept.add(old.n);
    if (old?.status === 'done') return [];
    const title = ours ? part.title : part.line;
    const claimed: Pick<Task, 'status' | 'owner'> = { status: 'claimed', owner: part.owner };
    const task: Task = old
      ? { ...old, title, plan: link, ...(ours && !old.owner && claimed) }
      : { n: n++, title, addedBy: v.from, blockedBy: [], plan: link, ...(ours ? claimed : { status: 'open' }) };
    return [entry(from, task)];
  });
  const gone = mine.filter(t => !kept.has(t.n) && t.status !== 'done' && !(t.owner && !agreed.has(t.owner)))
    .map(({ plan: _p, ...t }) => entry(from, unclaimed(t)));
  return [...out, ...gone];
}

/** The latest version of a plan when it is `version` and still open for answers. */
function open(s: RoomState, name: string, version: number, what: string): Result<{ plan: Plan; version: PlanVersion }> {
  const plan = s.plans.find(p => p.name === name);
  const latest = plan?.versions.at(-1);
  if (!plan || !latest) return err(`${what}: there is no plan ${name}.`);
  if (version > latest.version || version < 1) return err(`${what}: plan ${name} has no v${version}.`);
  if (version < latest.version) return err(`${what}: ${name} v${version} is superseded by v${latest.version}.`);
  if (latest.decision) return err(`${what}: ${name} v${version} is already decided.`);
  return ok({ plan, version: latest });
}

/** Why a note is refused, or '' when it is fine: asking for changes needs one, and none may outgrow the log's cap. */
function checkNote(what: string, answer: Acceptance | Answer, note: string | undefined): string {
  if (answer === 'changes' && !note?.trim()) return `${what}: asking for changes needs a note.`;
  return note && note.length > LIMITS.text ? `${what}: the note is over ${LIMITS.text} characters.` : '';
}

/** A note, kept word for word (R22), when it says anything. */
function noted(note: string | undefined): { note?: string } {
  return note?.trim() ? { note } : {};
}

function isMember(s: RoomState, name: string): boolean {
  return s.members.some(m => m.name === name && !m.kicked);
}
