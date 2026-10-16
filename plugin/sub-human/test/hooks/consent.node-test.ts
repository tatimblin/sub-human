// hooks/consent.ts (and its entry, hooks/handlers/consent.ts) and lib/proposal.ts: the hash-gated card rewrite, what Post records and drops, decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { World, PLUGIN, hso, decision, reason, ctx } from './helpers.ts';
import type { HookInput, HookRun } from './helpers.ts';
import type { Identity } from '../../lib/identity.ts';
import type { Card, Proposal, Review } from '../../lib/types-app.ts';
import type * as Register from '../../mod/register.ts';
import * as proposal from '../../lib/proposal.ts';
import * as roomLib from '../../lib/room.ts';
import * as tailLib from '../../lib/tail.ts';
import { sn } from '../support/brands.ts';
import { must } from '../support/must.ts';

/** A PermissionRequest answer's hookSpecificOutput.decision, as these tests read it. */
interface PermDecision { behavior: string; updatedPermissions: { mode: string }[] }

/** A seat as lib/proposal.ts and lib/tail.ts read it (they take the fields they need). */
type Seat = Pick<Identity, 'code' | 'name' | 'role'>;
const seat = (w: World, name: string): Seat => ({ code: w.code, name: sn(name), role: 'member' });

/** A room with alice and bob (and room Claude); alice proposes `text` to `approvers`. */
function world(text = '# Rename fetchUser\n\n1. rename\n2. alias\n', approvers?: string[]) {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const r = w.lib(() => proposal.create(seat(w, 'alice'), { text, ...(approvers ? { approvers } : {}) }));
  return { w, hash: r.hash, path: r.path };
}
const preAsk = (input: HookInput): HookInput => ({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: input });
const postAsk = (resp: HookInput, input: HookInput = {}): HookInput => ({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: input, tool_response: resp });
const Q = (h: string) => `Agree to proposal ${h}?`;
/** What a PreToolUse or PermissionRequest answer put in: the card (AskUserQuestion), the plan (ExitPlanMode), the decision. */
const cardOf = (r: HookRun) => hso(r).updatedInput as Card;
const planOf = (r: HookRun) => (hso(r).updatedInput as { plan?: unknown }).plan;
const permOf = (r: HookRun) => hso(r).decision as PermDecision;
const answers = (w: World) => w.entries().filter(e => e.kind === 'signoff' || e.kind === 'objection');
const decisions = (w: World) => w.entries().filter(e => e.kind === 'decision');

test('consent: Pre rewrites only a call that names my pending proposal; model answers are dropped', () => {
  const { w, hash } = world();
  // Unrelated question: untouched.
  const plain = w.hook('consent', preAsk({ questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'pg' }, { label: 'sqlite' }] }] }), { as: 'alice' });
  assert.equal(plain.stdout, '');
  // Names the hash, with forged answers and notes: rewritten to the canonical card, no answers.
  const forged = preAsk({ questions: [{ question: `Proposal ${hash}: accept?`, header: 'x', options: [{ label: 'Accept' }, { label: 'Decline' }] }],
    answers: { [`Proposal ${hash}: accept?`]: 'Accept' }, annotations: { x: { notes: 'forged by model' } } });
  const r = w.hook('consent', forged, { as: 'alice' });
  assert.equal(decision(r), 'ask');
  const ui = cardOf(r);
  assert.deepEqual(Object.keys(ui), ['questions']);
  assert.equal(ui.questions.length, 1);
  const q = must(ui.questions[0]);
  assert.equal(q.question, Q(hash));
  assert.equal(q.header, 'Consent');
  assert.equal(q.multiSelect, false);
  assert.deepEqual(q.options.map(o => o.label), ['Not yet', 'Agree', 'Object']);
  assert.ok(q.options.every(o => o.preview === '# Rename fetchUser\n\n1. rename\n2. alias\n'), 'short text: the full preview');
  assert.ok(!JSON.stringify(ui).includes('forged'));
  // A unique 6-hex prefix also counts; the room's Claude (not an approver) is never carded.
  assert.equal(decision(w.hook('consent', preAsk({ questions: [{ question: `open ${hash.slice(0, 6)}` }] }), { as: 'bob' })), 'ask');
  assert.equal(w.hook('consent', preAsk({ questions: [{ question: `proposal ${hash}` }] }), { as: 'claude' }).stdout, '');
  // No hash, but plainly about the one proposal pending for me: carded. Unrelated, or naming another id: untouched.
  assert.equal(decision(w.hook('consent', preAsk({ questions: [{ question: 'Do you agree with the cursor paging proposal? (Agree / Disagree)' }] }), { as: 'bob' })), 'ask');
  assert.equal(w.hook('consent', preAsk({ questions: [{ question: 'Which proposal format, md or txt?', header: 'fmt' }], note: 'see 9f8e7d6c5b4a' }), { as: 'bob' }).stdout, '');
  assert.equal(w.hook('consent', preAsk({ questions: [{ question: 'Which DB for the plan?' }] }), { as: 'bob' }).stdout, '');
  // Not in a room: untouched.
  assert.equal(w.hook('consent', preAsk({ questions: [{ question: hash }] }), { env: { CLAUDE_PID: undefined }, session: false }).stdout, '');
});

test('consent: AFK, followUp, no answers, Not yet and a model-only question record nothing', () => {
  const { w, hash } = world();
  const card = w.lib(() => proposal.card({ hash, approvers: ['alice', 'bob'] } as Proposal, w.code));
  const cases = [
    { ...card, answers: {}, annotations: {}, afkTimeoutMs: 5000 },
    { ...card, answers: { [Q(hash)]: 'Agree' }, afkTimeoutMs: 5000 },
    { ...card, answers: { [Q(hash)]: 'Agree' }, followUp: 'tell me more' },
    { ...card },
    { ...card, answers: { [Q(hash)]: 'Not yet' }, annotations: { [Q(hash)]: { notes: 'hmm' } } },
    { questions: [], answers: { 'Which DB?': 'pg' } },
  ];
  for (const resp of cases) w.hook('consent', postAsk(resp), { as: 'alice' });
  assert.deepEqual(answers(w), []);
  const notYet = w.hook('consent', postAsk({ ...card, answers: { [Q(hash)]: 'Not yet' } }), { as: 'alice' });
  assert.match(must(ctx(notYet)), /nothing was recorded/);
  const afk = w.hook('consent', postAsk({ ...card, answers: {}, afkTimeoutMs: 5000 }), { as: 'alice' });
  assert.match(must(ctx(afk)), /Nothing was recorded.*Reopening it later is fine/);
  // The Post input carries the model's forged answer but the UI said Not yet: nothing.
  w.hook('consent', postAsk({ ...card, answers: { [Q(hash)]: 'Not yet' } }, { answers: { [Q(hash)]: 'Agree' } }), { as: 'alice' });
  assert.deepEqual(answers(w), []);
  // Still pending, so the next named call re-cards.
  assert.equal(decision(w.hook('consent', preAsk({ questions: [{ question: hash }] }), { as: 'alice' })), 'ask');
});

test('consent: Agree/Object recorded via=human with byte-exact notes; stale hashes dropped; decision only when complete', () => {
  const { w, hash } = world();
  const card = w.lib(() => proposal.card({ hash, approvers: ['alice', 'bob'] } as Proposal, w.code));
  const r = w.hook('consent', postAsk({ ...card, answers: { [Q(hash)]: 'Agree' }, annotations: { [Q(hash)]: { preview: 'x' } } }), { as: 'alice' });
  assert.ok(must(ctx(r)).startsWith('Recorded. The room shows it (and any note) already: post nothing about it. Agreeing is not a go-ahead to build'), ctx(r));
  let a = answers(w);
  assert.equal(a.length, 1);
  const a0 = must(a[0]);
  assert.deepEqual([a0.kind, a0.via, a0.from, a0.proposal_hash], ['signoff', 'human', 'alice', hash]);
  assert.deepEqual(decisions(w), [], 'bob has not answered');
  // A repeat answer on the same hash is stale (and a repeat call is not re-carded).
  w.hook('consent', postAsk({ ...card, answers: { [Q(hash)]: 'Object' } }), { as: 'alice' });
  assert.equal(answers(w).length, 1);
  assert.equal(w.hook('consent', preAsk({ questions: [{ question: hash }] }), { as: 'alice' }).stdout, '');
  // Unknown hash: dropped.
  w.hook('consent', postAsk({ answers: { [Q('0123456789ab')]: 'Agree' } }), { as: 'bob' });
  assert.equal(answers(w).length, 1);
  // bob objects with a note that must survive byte for byte.
  const note = 'clamp, don\'t 400 — use "max=100" & keep `alias` <2 rels>\n  ünïcode ✓ ';
  w.hook('consent', postAsk({ ...card, answers: { [Q(hash)]: 'Object' }, annotations: { [Q(hash)]: { notes: note } } }), { as: 'bob' });
  a = answers(w);
  assert.equal(a.length, 2);
  const a1 = must(a[1]);
  assert.deepEqual([a1.kind, a1.via, a1.from, a1.text], ['objection', 'human', 'bob', note]);
  const d = decisions(w);
  assert.equal(d.length, 1);
  const d0 = must(d[0]);
  assert.deepEqual([d0.via, d0.proposal_hash], ['system', hash]);
  assert.match(must(d0.text), /^objected: bob · agreed: alice/);
  assert.ok(a.every(x => must(d0.refs).includes(x.id)));
  // Decided: a late answer is stale.
  w.hook('consent', postAsk({ ...card, answers: { [Q(hash)]: 'Agree' } }), { as: 'bob' });
  assert.equal(answers(w).length, 2);
  assert.equal(decisions(w).length, 1);
});

test('consent: all agree gives an "agreed" decision; matrix and pendingFor follow the log', () => {
  const { w, hash } = world('# x\n', ['bob']);
  const me = { code: w.code, name: sn('bob') };
  assert.deepEqual(w.lib(() => proposal.pendingFor(me)).map(p => p.hash), [hash]);
  assert.deepEqual(w.lib(() => proposal.pendingFor({ code: w.code, name: sn('alice') })), []);
  w.hook('consent', postAsk({ answers: { [Q(hash)]: 'Agree' } }), { as: 'bob' });
  assert.match(must(decisions(w)[0]?.text), /^agreed: bob/);
  const m = w.lib(() => proposal.matrix({ hash, approvers: ['bob'] }, w.entries()));
  assert.equal(m.complete, true);
  assert.deepEqual(m.agreed, ['bob']);
  assert.deepEqual(w.lib(() => proposal.pendingFor(me)), []);
});

test('consent: preview is the full text up to 2000 chars and 20 lines, else a summary plus the path', () => {
  const w = new World({ alice: 'act', bob: 'sleep' });
  const me = { code: w.code, name: sn('alice') };
  const pv = (text: string) => w.lib(() => { const r = proposal.create(me, { text }); return { p: proposal.preview({ hash: r.hash, path: must(r.entry).path } as Proposal, me.code), path: r.path }; });
  const exact = 'a'.repeat(2000);
  assert.equal(pv(exact).p, exact);
  const over = pv('b'.repeat(2001));
  assert.ok(over.p.length <= 2000 && over.p.endsWith(`Full text: ${over.path}`), over.p.slice(-80));
  const tall = Array.from({ length: 21 }, (_, i) => `line ${i}`).join('\n');
  const t = pv(tall);
  assert.match(t.p, /^line 0\n/);
  assert.match(t.p, /more lines\)\n\nFull text: /);
  const twenty = Array.from({ length: 20 }, (_, i) => `row ${i}`).join('\n');
  assert.equal(pv(twenty).p, twenty);
});

test('consent: Post(ExitPlanMode) offers to propose once, never denies; a subagent plan is ignored', () => {
  const w = new World({ alice: 'act', bob: 'sleep' });
  const plan = '# Plan\n\n1. paging\n';
  const file = path.join(w.userHome, '.claude', 'plans', 'snug-rocket.md');
  fs.writeFileSync(file, plan);
  const ev = (extra = {}) => ({ hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: {}, tool_response: { plan, isAgent: false, filePath: file, ...extra } });
  const r = w.hook('consent', ev(), { as: 'alice' });
  assert.equal(r.code, 0);
  assert.equal(hso(r).permissionDecision, undefined);
  assert.match(must(ctx(r)), new RegExp(`propose tool with \\{path: ${JSON.stringify(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`));
  assert.equal(w.hook('consent', ev({ isAgent: true }), { as: 'alice' }).stdout, '');
  const { hash } = w.lib(() => proposal.create({ code: w.code, name: sn('alice') }, { path: file }, { cwd: w.userHome }));
  assert.equal(ctx(w.hook('consent', ev(), { as: 'alice' })), `alice agreed to proposal ${hash}.`, 'pending for alice: her approval is her signoff');
  assert.equal(w.hook('consent', ev(), { as: 'alice' }).stdout, '', 'already proposed (same sha256/12)');
});

test('consent: approving my own pending proposal, unedited, in my own plan mode is my signoff; an edited one records nothing', () => {
  const run = (edited: boolean) => {
    const w = new World({ alice: 'act', bob: 'sleep' });
    const plan = '# Plan\n\n1. paging\n';
    const file = path.join(w.userHome, '.claude', 'plans', 'own-plan.md');
    fs.writeFileSync(file, plan);
    const { hash } = w.lib(() => proposal.create(seat(w, 'bob'), { path: file, approvers: ['bob', 'alice'] }, { cwd: w.userHome }));
    const r = w.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', permission_mode: 'default', tool_input: {},
      tool_response: { plan, isAgent: false, filePath: file, ...(edited ? { planWasEdited: true } : {}) } }, { as: 'bob' });
    return { w, hash, r };
  };
  const { w, hash, r } = run(false);
  assert.deepEqual(answers(w).map(x => [x.kind, x.via, x.from, x.proposal_hash]), [['signoff', 'human', 'bob', hash]]);
  assert.equal(ctx(r), `bob agreed to proposal ${hash}.`);
  assert.deepEqual(decisions(w), [], 'alice has not answered');
  const e = run(true);
  assert.deepEqual(answers(e.w), []);
  assert.doesNotMatch(ctx(e.r) || '', /agreed/);
});

// ---------- the review in the native plan dialog ----------
/** A session transcript with the plan_mode attachment (the plan file path) and, optionally, a dialog's tool_result. */
function transcript(w: World, planFile: string | null, result?: Record<string, unknown> | null, call?: Record<string, unknown> | null) {
  const f = path.join(w.cwd, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines: Record<string, unknown>[] = [{ type: 'attachment', attachment: { type: 'plan_mode', reminderType: 'full', planFilePath: planFile, planExists: false } }];
  if (call) lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'ExitPlanMode', ...call }] } });
  if (result) lines.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', ...result }] } });
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
const said = (text: string) => `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n${text}\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.`;
const ev = (event: string, tool?: string | null, extra: HookInput = {}): HookInput => ({ hook_event_name: event, ...(tool ? { tool_name: tool } : {}), ...extra });
/** bob's review state (his session document's review), or null. */
const review = (w: World): Review | null => w.lib(() => proposal.readReview(seat(w, 'bob')));
/** The note waiting for the person's Send (the session document's confirm), or null. */
const waiting = (w: World, name = 'bob') => w.lib(() => proposal.readConfirm(seat(w, name)));
/**
 * The confirm card for a waiting note: the model's AskUserQuestion naming `objection <hash>` (Pre asks with the
 * hooks' card), then the person's answer `label` on that card as shown. Returns {pre, post, card}.
 */
function confirm(w: World, hash: string, label: string | null | undefined, { as = 'bob', resp = {} }: { as?: string; resp?: HookInput } = {}) {
  const pre = w.hook('consent', preAsk({ questions: [{ question: `objection ${hash}`, header: 'x', options: [{ label: 'Send' }, { label: 'Discard' }] }] }), { as });
  assert.equal(decision(pre), 'ask');
  const card = cardOf(pre);
  const q = must(card.questions[0]).question;
  const post = w.hook('consent', postAsk({ ...card, answers: label == null ? {} : { [q]: label }, ...resp }), { as });
  return { pre, post, card };
}

test('review: EnterPlanMode is let through only for a pending proposal and a reviewable mode; others untouched', () => {
  const { w, hash } = world();
  const enter = (mode: string | undefined) => w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: mode, tool_input: {} }), { as: 'bob' });
  for (const m of ['plan', 'bypassPermissions', 'dontAsk', undefined]) assert.equal(enter(m).stdout, '', `mode ${m}: untouched`);
  assert.equal(review(w), null);
  assert.equal(decision(enter('acceptEdits')), 'allow');
  assert.deepEqual([must(review(w)).phase, must(review(w)).mode], ['entering', 'acceptEdits']);
  // No pending proposal for the room's Claude / for a stranger to it: untouched.
  assert.equal(w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {} }), { as: 'claude' }).stdout, '');
  // The clear-context approve option fires no PostToolUse: no review while it is on.
  const w2 = world().w;
  fs.mkdirSync(path.join(w2.cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(w2.cwd, '.claude', 'settings.local.json'), '{"showClearContextOnPlanAccept":true}');
  assert.equal(w2.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {} }), { as: 'bob' }).stdout, '');
  // In a reviewable mode the card call is sent to the plan view; otherwise the card opens as before.
  const card = (mode: string) => w.hook('consent', { ...preAsk({ questions: [{ question: `proposal ${hash}` }] }), permission_mode: mode }, { as: 'alice' });
  assert.equal(decision(card('auto')), 'deny');
  assert.match(must(reason(card('auto'))), new RegExp(`EnterPlanMode, then ExitPlanMode with plan "proposal ${hash}"`));
  assert.equal(decision(card('plan')), 'ask');
});

test('review: a planFilePath the model put in EnterPlanMode\'s input is ignored; the plan file is the transcript\'s', () => {
  const { w, hash } = world();
  const text = '# Rename fetchUser\n\n1. rename\n2. alias\n';
  const file = path.join(w.userHome, '.claude', 'plans', 'snug-rocket.md');
  const victim = path.join(w.cwd, 'victim.txt');
  fs.writeFileSync(victim, 'not a plan\n');
  const tp = transcript(w, file);
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: { planFilePath: victim } }), { as: 'bob' });
  const post = w.hook('consent', ev('PostToolUse', 'EnterPlanMode', { permission_mode: 'plan', tool_input: { planFilePath: victim }, tool_response: {}, transcript_path: tp }), { as: 'bob' });
  assert.match(must(ctx(post)), new RegExp(`only to show bob room proposal ${hash}`));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'not a plan\n', 'a path the model chose is never written');
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'the session\'s plan file (its plan_mode attachment) shows the proposal');
  assert.equal(must(review(w)).file, file);
});

test('review: the dialog shows the canonical text from the plan file; a person\'s "Yes" records Agree and restores the file', () => {
  const { w, hash } = world();
  const text = '# Rename fetchUser\n\n1. rename\n2. alias\n';
  const file = path.join(w.userHome, '.claude', 'plans', 'snug-rocket.md');
  fs.writeFileSync(file, 'bob\'s own plan\n');
  const tp = transcript(w, file);
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {} }), { as: 'bob' });
  assert.match(must(ctx(w.hook('consent', ev('PostToolUse', 'EnterPlanMode', { permission_mode: 'plan', tool_input: {}, tool_response: {} }), { as: 'bob' }))), new RegExp(`only to show bob room proposal ${hash}\\. Call ExitPlanMode now with plan "proposal ${hash}"`));
  const pre = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: `proposal ${hash}` }, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' });
  assert.equal(decision(pre), 'ask');
  assert.equal(reason(pre), `room proposal ${hash} from alice, for bob (PgUp/PgDn scroll). Agree: "Yes, manually approve edits" keeps your mode. Object: "Tell Claude what to change" + why. Esc: decide later.`);
  assert.equal(planOf(pre), text);
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'the dialog renders the file');
  // The same call again (a retried hook): the same dialog, not an exit.
  assert.equal(decision(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' })), 'ask');
  // The dialog is a person's: the PermissionRequest hook leaves it alone.
  assert.equal(w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: text } }), { as: 'bob' }).stdout, '');
  assert.deepEqual(answers(w), []);
  // "Yes, manually approve edits": back in default, Agree recorded via=human, bob's own plan back in the file.
  const post = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_use_id: 'tu1', tool_response: { plan: text, isAgent: false, filePath: file } }), { as: 'bob' });
  assert.match(must(ctx(post)), /^Recorded\. .*bob agreed to proposal [0-9a-f]{12}\. This was a room review/);
  assert.doesNotMatch(must(ctx(post)), /#\d/);
  const a = answers(w);
  assert.deepEqual(a.map(x => [x.kind, x.via, x.from, x.proposal_hash]), [['signoff', 'human', 'bob', hash]]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'bob\'s own plan\n');
  assert.equal(review(w), null);
  assert.deepEqual(decisions(w), [], 'alice has not answered');
});

test('review: a "Yes" that changed the mode is set back silently; an edited plan records nothing; no plan file is left behind', () => {
  const { w, hash } = world();
  const text = '# Rename fetchUser\n\n1. rename\n2. alias\n';
  const file = path.join(w.userHome, '.claude', 'plans', 'new-slug.md');
  const tp = transcript(w, file, null, { id: 'tu1', input: { plan: `proposal ${hash}` } });
  const open = () => {
    w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {} }), { as: 'bob' });
    return w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: 'stub' }, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' });
  };
  open();
  // Ctrl+G edit, then "Yes, and use auto mode": nothing recorded, and the mode must come back.
  const post = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'auto', tool_input: { plan: text + 'x' }, tool_use_id: 'tu1', tool_response: { plan: text + 'x', planWasEdited: true, filePath: file } }), { as: 'bob' });
  assert.match(must(ctx(post)), /edited proposal .* nothing was recorded.*call EnterPlanMode, then ExitPlanMode/);
  assert.deepEqual(answers(w), []);
  assert.equal(fs.existsSync(file), false, 'the file did not exist before: removed');
  assert.equal(must(review(w)).phase, 'restore');
  // Stop before the restore: the turn goes on once with the how (context, not a block: no red "Stop hook error").
  const stop = w.hook('consent', ev('Stop', null, { permission_mode: 'auto', stop_hook_active: false }), { as: 'bob' });
  assert.equal(must(stop.json).decision, undefined);
  assert.equal(stop.json?.hookSpecificOutput?.hookEventName, 'Stop');
  assert.match(must(ctx(stop)), /restore bob's default mode/);
  assert.equal(w.hook('consent', ev('Stop', null, { permission_mode: 'auto', stop_hook_active: true }), { as: 'bob' }).stdout, '');
  assert.equal(decision(w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'auto', tool_input: {} }), { as: 'bob' })), 'allow');
  assert.equal(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu2', transcript_path: tp }), { as: 'bob' }).stdout, '', 'no dialog');
  const perm = w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' });
  assert.deepEqual(hso(perm).decision, { behavior: 'allow', updatedInput: {}, updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] });
  const done = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_use_id: 'tu2', tool_response: { plan: null, filePath: file } }), { as: 'bob' });
  assert.match(must(ctx(done)), /review is closed and the mode is restored/);
  assert.deepEqual(answers(w), [], 'the silent exit records nothing');
  assert.equal(review(w), null);
  // Still pending: the next review opens again.
  assert.equal(decision(open()), 'ask');
  void hash;
});

test('review: "Tell Claude what to change" records an objection with the note byte-exact; Esc records nothing; both exit silently', () => {
  const { w, hash } = world();
  const file = path.join(w.userHome, '.claude', 'plans', 'obj.md');
  const note = 'clamp, don\'t 400 — use "max=100" & keep `alias` <2 rels>\n  ünïcode ✓';
  const run = (result: string, viaStop: boolean) => {
    const tp0 = transcript(w, file, null, { id: 'tu1', input: { plan: `proposal ${hash.slice(0, 6)}` } });
    w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'auto', tool_input: {} }), { as: 'bob' });
    w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp0 }), { as: 'bob' });
    const tp = transcript(w, file, { tool_use_id: 'tu1', is_error: true, content: result });
    let r: HookRun;
    if (viaStop) {
      r = w.hook('consent', ev('Stop', null, { permission_mode: 'plan', stop_hook_active: false, transcript_path: tp }), { as: 'bob' });
      assert.equal(must(r.json).decision, undefined);
      assert.match(must(ctx(r)), /call ExitPlanMode now/);
    } else {
      r = w.hook('consent', ev('UserPromptSubmit', null, { permission_mode: 'plan', prompt: 'hi', transcript_path: tp }), { as: 'bob' });
      assert.match(must(ctx(r)), /Before anything else, call ExitPlanMode now/);
    }
    // The exit: no dialog, back to auto, the plan file removed.
    assert.equal(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu9', transcript_path: tp }), { as: 'bob' }).stdout, '');
    const perm = w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' });
    assert.equal(permOf(perm).updatedPermissions[0]?.mode, 'auto');
    assert.equal(fs.existsSync(file), false);
    return ctx(w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'auto', tool_input: {}, tool_use_id: 'tu9', tool_response: { plan: null } }), { as: 'bob' }));
  };
  // Esc: "rejected… STOP" with no "the user said": nothing recorded (the next prompt brings the exit).
  const esc = run('The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.', false);
  assert.match(must(esc), /closed the review .* without answering; nothing was recorded/);
  assert.deepEqual(answers(w), []);
  // Feedback: nothing recorded yet; the note waits for bob's Send on the confirm card.
  const obj = run(said(note), true);
  assert.match(must(obj), /note on [0-9a-f]{12} waits for Send or Discard.*call AskUserQuestion with "objection /);
  assert.deepEqual(answers(w), []);
  assert.equal(must(waiting(w)).note, note);
  assert.equal(review(w), null);
  // Send: the objection, the note byte for byte.
  const { post } = confirm(w, hash, 'Send');
  assert.match(must(ctx(post)), /bob objected to proposal/);
  const a = answers(w);
  assert.deepEqual(a.map(x => [x.kind, x.via, x.from, x.proposal_hash, x.text]), [['objection', 'human', 'bob', hash, note]]);
  assert.equal(waiting(w), null);
});

test('review: a room tool call after "Tell Claude what to change" records the objection now and is denied with the exit', () => {
  const { w, hash } = world();
  const file = path.join(w.userHome, '.claude', 'plans', 'obj2.md');
  const note = 'add a test for a cursor past the end — `after=zzz` must 400, not 500';
  const tp0 = transcript(w, file, null, { id: 'tu1', input: { plan: `proposal ${hash}` } });
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'auto', tool_input: {} }), { as: 'bob' });
  w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp0 }), { as: 'bob' });
  const tp = transcript(w, file, { tool_use_id: 'tu1', is_error: true, content: said(note) });
  // With no review open (alice), a room tool call is untouched; a read outside plan mode exits before loading.
  assert.equal(w.hook('consent', ev('PreToolUse', 'mcp__plugin_sub-human_room__post', { permission_mode: 'plan', tool_input: { text: note }, transcript_path: tp }), { as: 'alice' }).stdout, '');
  assert.equal(w.hook('consent', ev('PreToolUse', 'mcp__plugin_sub-human_room__read', { permission_mode: 'auto', tool_input: {}, transcript_path: tp }), { as: 'bob' }).stdout, '');
  // bob's Claude tries to post his note itself: denied, the note waits for bob's Send (nothing recorded), exit next.
  const r = w.hook('consent', ev('PreToolUse', 'mcp__plugin_sub-human_room__post', { permission_mode: 'plan', tool_input: { kind: 'say', text: note }, transcript_path: tp }), { as: 'bob' });
  assert.equal(decision(r), 'deny');
  assert.match(must(reason(r)), /Nothing is recorded yet: bob's note on .* waits for Send or Discard.*Post nothing about the review\. First call ExitPlanMode now/);
  assert.doesNotMatch(must(reason(r)), /#\d/);
  assert.deepEqual(answers(w), []);
  assert.equal(must(waiting(w)).note, note);
  assert.equal(must(review(w)).phase, 'exiting');
  // The exit: silent, back to auto, the plan file removed; still nothing recorded.
  assert.equal(permOf(w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' })).updatedPermissions[0]?.mode, 'auto');
  assert.equal(fs.existsSync(file), false);
  assert.match(must(ctx(w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'auto', tool_input: {}, tool_response: { plan: null } }), { as: 'bob' }))), /review is closed and the mode is restored/);
  assert.deepEqual(answers(w), []);
  assert.equal(review(w), null);
  // bob's Send on the card: recorded once, byte-exact (via=human).
  confirm(w, hash, 'Send');
  assert.deepEqual(answers(w).map(x => [x.kind, x.via, x.text]), [['objection', 'human', note]]);
});

/**
 * The rejection line of the live round-4 trial (2.1.296, proposal 471cf694a6b9, bob's "Tell Claude what to change"),
 * field for field, then the metadata rows Claude Code appends after it; for tool use `id`.
 */
function rejectionRows(id: string, note: string) {
  const content = said(note);
  return [
    { parentUuid: 'c30cb4f4-638d-4681-91d5-6de50f162c19', isSidechain: false, promptId: '995c57e1-0420-4bcb-b79b-8b76a65d98ff', type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content, is_error: true, tool_use_id: id }] },
      uuid: '31fdfd59-5dea-4d10-b027-25b1318a6a1d', timestamp: '2026-10-15T05:26:27.696Z', toolUseResult: `Error: ${content}`,
      toolDenialKind: 'user-rejected', userFeedback: note, sourceToolAssistantUUID: 'c30cb4f4-638d-4681-91d5-6de50f162c19',
      permissionDecision: { decision: 'reject', source: 'user_reject' }, userType: 'external', entrypoint: 'cli', version: '2.1.296' },
    { type: 'last-prompt', lastPrompt: 'The sub-human plugin sent a message: …', leafUuid: '31fdfd59-5dea-4d10-b027-25b1318a6a1d' },
    { type: 'custom-title', customTitle: 'bob.shrew-6338' },
    { type: 'mode', mode: 'normal' },
    { type: 'permission-mode', permissionMode: 'plan' },
  ].map(l => JSON.stringify(l)).join('\n') + '\n';
}

test('review: a hook that runs while the dialog is open (no rejection line yet) settles nothing; the 2.1.296 note is read when the review closes and waits for Send', () => {
  const { w, hash } = world();
  const file = path.join(w.userHome, '.claude', 'plans', 'r4.md');
  const note = 'Keep the old heading as a subtitle under the new one';
  const tp = transcript(w, file, null, { id: 'tu1', input: { plan: `proposal ${hash}` } });
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'auto', tool_input: {} }), { as: 'bob' });
  assert.equal(decision(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' })), 'ask');
  // The dialog is still open: a prompt hook in plan mode reads no rejection line. Before, this settled the review as
  // "closed without answering" and the note typed a moment later was never read.
  const early = w.hook('consent', ev('UserPromptSubmit', null, { permission_mode: 'plan', prompt: 'x', transcript_path: tp }), { as: 'bob' });
  assert.match(must(ctx(early)), /bob's answer in the review of proposal [0-9a-f]{12} is not on record yet; nothing was recorded/);
  assert.doesNotMatch(must(ctx(early)), /without answering/);
  assert.deepEqual([must(review(w)).phase, must(review(w)).unread], ['exiting', true]);
  assert.equal(waiting(w), null);
  // bob answers "Tell Claude what to change" with his note: the line as the trial wrote it.
  fs.appendFileSync(tp, rejectionRows('tu1', note));
  // The model's closing ExitPlanMode (it passes the plan back, as in the trial): no dialog, and the note is read now.
  assert.equal(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: TEXT, planFilePath: file }, tool_use_id: 'tu2', transcript_path: tp }), { as: 'bob' }).stdout, '');
  assert.equal(must(waiting(w)).note, note, 'the note waits byte-exact (confirm)');
  assert.equal(permOf(w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' })).behavior, 'allow');
  const post = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'auto', tool_input: {}, tool_use_id: 'tu2', tool_response: { plan: null, filePath: file }, transcript_path: tp }), { as: 'bob' });
  assert.match(must(ctx(post)), new RegExp(`Nothing is recorded yet: bob's note on ${hash} waits for Send or Discard on its card\\. Next, call AskUserQuestion with "objection ${hash}"`));
  assert.deepEqual(answers(w), [], 'a note alone records nothing');
  assert.equal(review(w), null);
  // The card: bob's Send records the objection with his note.
  confirm(w, hash, 'Send');
  assert.deepEqual(answers(w).map(x => [x.kind, x.via, x.text]), [['objection', 'human', note]]);
});

test('review: the closing ExitPlanMode waits for a rejection line Claude Code has not written yet; Post reads it last; none at all is no answer', () => {
  const { w, hash } = world();
  const note = 'Keep the old heading as a subtitle under the new one';
  const open = (name: string) => {
    const file = path.join(w.userHome, '.claude', 'plans', `${name}.md`);
    const tp = transcript(w, file, null, { id: 'tu1', input: { plan: `proposal ${hash}` } });
    w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'auto', tool_input: {} }), { as: 'bob' });
    assert.equal(decision(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' })), 'ask');
    return { file, tp };
  };
  const close = (tp: string, file: string, env: Record<string, string>) => {
    w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu2', transcript_path: tp }), { as: 'bob', env });
    w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' });
    return ctx(w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'auto', tool_input: {}, tool_use_id: 'tu2', tool_response: { plan: null, filePath: file }, transcript_path: tp }), { as: 'bob', env }));
  };
  // The line lands while Pre(ExitPlanMode) polls for it.
  const a = open('late');
  const rows = path.join(w.cwd, 'rows.jsonl');
  fs.writeFileSync(rows, rejectionRows('tu1', note));
  const writer = spawn('sh', ['-c', `sleep 0.3; cat "${rows}" >> "${a.tp}"`], { stdio: 'ignore' });
  const late = close(a.tp, a.file, { SUB_HUMAN_EXIT_INPUT_WAIT_MS: '5000' });
  assert.match(must(late), /note on [0-9a-f]{12} waits for Send or Discard/);
  assert.equal(must(waiting(w)).note, note);
  writer.kill();
  confirm(w, hash, 'Discard');
  // No line ever: Pre leaves it unread, Post settles it as closed without answering.
  const b = open('none');
  const none = close(b.tp, b.file, { SUB_HUMAN_EXIT_INPUT_WAIT_MS: '100' });
  assert.match(must(none), /bob closed the review of proposal [0-9a-f]{12} without answering; nothing was recorded/);
  assert.equal(waiting(w), null);
  assert.equal(review(w), null);
  assert.deepEqual(answers(w), []);
});

test('review: 2.1.292 runs Pre(ExitPlanMode) before the call\'s transcript line is written, with a blank plan: the only pending proposal is shown; the line is waited for', () => {
  const { w, hash } = world();
  const file = path.join(w.userHome, '.claude', 'plans', 'late-line.md');
  const tp = transcript(w, file); // the plan_mode attachment only: the ExitPlanMode line is not there yet
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'auto', tool_input: {} }), { as: 'bob' });
  const t0 = Date.now();
  const pre = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: '' }, tool_use_id: 'tu5', transcript_path: tp }), { as: 'bob', env: { SUB_HUMAN_EXIT_INPUT_WAIT_MS: '200' } });
  assert.equal(decision(pre), 'ask', pre.stderr);
  assert.match(must(reason(pre)), new RegExp(`^room proposal ${hash} `));
  assert.ok(Date.now() - t0 >= 200, 'it polled the transcript first');
  assert.equal(must(review(w)).phase, 'shown');
  assert.ok(fs.readFileSync(file, 'utf8').length > 0, 'the proposal is in the plan file the dialog renders');
});

test('review: no plan path closes the review silently and falls back to the card; the person\'s own plan is never shown and comes back', () => {
  const { w, hash } = world();
  const empty = path.join(w.cwd, 'empty.jsonl');
  fs.writeFileSync(empty, '');
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {} }), { as: 'bob' });
  assert.equal(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: `proposal ${hash}` }, tool_use_id: 'tu1', transcript_path: empty }), { as: 'bob' }).stdout, '');
  assert.equal(permOf(w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' })).behavior, 'allow');
  const r = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_response: { plan: null } }), { as: 'bob' });
  assert.match(must(ctx(r)), new RegExp(`call AskUserQuestion with "proposal ${hash}"`));
  assert.deepEqual(answers(w), []);
  // Plan mode entered while a proposal waits: the hook opened a review, so the dialog is the proposal's; the
  // model's own plan is not shown, its file comes back after, and the model is told.
  const mine = path.join(w.userHome, '.claude', 'plans', 'mine.md');
  fs.writeFileSync(mine, '# Refactor auth\n\n1. split\n');
  const own = transcript(w, mine, null, { id: 'tu7', input: { plan: '# Refactor auth\n\n1. split\n' } });
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {} }), { as: 'bob' });
  const shown = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: '# Refactor auth\n\n1. split\n', planFilePath: mine }, tool_use_id: 'tu7', transcript_path: own }), { as: 'bob' });
  assert.equal(planOf(shown), TEXT);
  assert.equal(fs.readFileSync(mine, 'utf8'), TEXT);
  const back = w.hook('consent', ev('Stop', null, { permission_mode: 'plan', stop_hook_active: false, transcript_path: transcript(w, mine, { tool_use_id: 'tu7', is_error: true, content: 'rejected. STOP what you are doing' }) }), { as: 'bob' });
  assert.match(must(ctx(back)), /review is still open/);
  w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' });
  assert.equal(fs.readFileSync(mine, 'utf8'), '# Refactor auth\n\n1. split\n');
  assert.match(must(ctx(w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_response: { plan: null } }), { as: 'bob' }))), /The plan you passed was not shown/);
  assert.equal(review(w), null);
  assert.deepEqual(answers(w), []);
  // No review open: ExitPlanMode is the person's own; Pre and PermissionRequest say nothing.
  assert.equal(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: '# mine' } }), { as: 'bob' }).stdout, '');
  assert.equal(w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: '# mine' } }), { as: 'bob' }).stdout, '');
  assert.equal(w.hook('consent', ev('Stop', null, { permission_mode: 'plan' }), { as: 'bob' }).stdout, '');
  // A Shift+Tab out of plan mode after Esc: the next prompt just tidies up.
  const file = path.join(w.userHome, '.claude', 'plans', 'tidy.md');
  const tp = transcript(w, file, null, { id: 'tu3', input: { plan: 'the room proposal for bob' } });
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {} }), { as: 'bob' });
  w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu3', transcript_path: tp }), { as: 'bob' });
  assert.ok(fs.existsSync(file));
  assert.equal(w.hook('consent', ev('UserPromptSubmit', null, { permission_mode: 'default', prompt: 'x' }), { as: 'bob' }).stdout, '');
  assert.equal(fs.existsSync(file), false);
  assert.equal(review(w), null);
});

test('review: the note comes from the structured userFeedback field; the backup is in the review state before the overwrite', () => {
  const { w, hash } = world();
  const file = path.join(w.userHome, '.claude', 'plans', 'fb.md');
  fs.writeFileSync(file, 'bob\'s own plan\n');
  const note = 'no "the user said:" prose here — keep `alias`\n  ✓';
  const tp0 = transcript(w, file, null, { id: 'tu1', input: { plan: `proposal ${hash}` } });
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'auto', tool_input: {} }), { as: 'bob' });
  w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp0 }), { as: 'bob' });
  const st = must(review(w));
  assert.deepEqual([st.phase, st.file, st.backup, st.restored], ['shown', file, 'bob\'s own plan\n', false]);
  assert.equal(fs.readFileSync(file, 'utf8'), '# Rename fetchUser\n\n1. rename\n2. alias\n');
  // The rejection line carries the raw note at the top level; its text has no "the user said:" at all.
  const tp = path.join(w.cwd, 'fb.jsonl');
  fs.writeFileSync(tp, [
    { type: 'attachment', attachment: { type: 'plan_mode', planFilePath: file } },
    { type: 'user', userFeedback: note, toolDenialKind: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'rejected' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  const r = w.hook('consent', ev('Stop', null, { permission_mode: 'plan', stop_hook_active: false, transcript_path: tp }), { as: 'bob' });
  assert.match(must(ctx(r)), /review is still open/);
  assert.deepEqual(answers(w), [], 'a note alone records nothing');
  assert.equal(must(waiting(w)).note, note, 'the note waits byte-exact');
  w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'bob\'s own plan\n', 'restored');
  assert.ok(!fs.existsSync(path.join(w.memberDir('bob'), 'review.json.lock')), 'the lock is released');
});

test('shim mode (SUB_HUMAN_SHIM=1, mod/consent.ts): Stop always reports subHuman {reviewOpen, noteWaits} beside its usual output', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const shim = { as: 'bob', env: { SUB_HUMAN_SHIM: '1' } };
  const stop = (extra: HookInput) => w.hook('consent', ev('Stop', null, { stop_hook_active: false, ...extra }), shim);
  // no review: nothing to say but the report
  let r = stop({ permission_mode: 'default' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { subHuman: { reviewOpen: false, noteWaits: false } });
  // a review still in restore: the nudge, and the report says it is open
  w.lib(() => proposal.writeReview(seat(w, 'bob'), { phase: 'restore', mode: 'default', at: Date.now() }));
  r = stop({ permission_mode: 'auto' });
  assert.match(must(ctx(r)), /restore bob's default mode/);
  assert.deepEqual(must(r.json).subHuman, { reviewOpen: true, noteWaits: false });
  // the restore done (mode back): consent clears the review, and says so
  r = stop({ permission_mode: 'default' });
  assert.deepEqual(r.json, { subHuman: { reviewOpen: false, noteWaits: false } });
  // unseated session: no review possible
  const u = new World({}, { room: false });
  const n = u.hook('consent', ev('Stop', null, { permission_mode: 'default' }), { env: { CLAUDE_PID: undefined, SUB_HUMAN_SHIM: '1' }, session: false });
  assert.deepEqual(n.json, { subHuman: { reviewOpen: false, noteWaits: false } });
  // without shim mode: unchanged (no output)
  assert.equal(w.hook('consent', ev('Stop', null, { permission_mode: 'default' }), { as: 'bob' }).stdout, '');
});

test('hooks.json: consent is the module\'s (mod/consent.ts); its classic.PreToolUse always calls next(e), so every other PreToolUse hook sees each call', async () => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, { matcher: string }[] | undefined> };
  for (const ev of ['Stop', 'PostToolUse', 'PermissionRequest']) assert.equal(hooks[ev], undefined, ev);
  // the one PreToolUse command hook only notes EnterPlanMode's mode (no node, no answer); consent itself is the module's
  assert.deepEqual(must(hooks.PreToolUse).map(x => x.matcher), ['EnterPlanMode']);
  const { HOOKS: MOD } = await import(path.join(PLUGIN, 'mod', 'register.ts')) as typeof Register;
  for (const ev of ['classic.Stop', 'tool.call', 'classic.PreToolUse', 'classic.PostToolUse', 'classic.PermissionRequest']) assert.ok(MOD.some(h => h.event === ev && h.file === 'mod/consent.ts'), ev);
  // a module hook answering classic.PreToolUse without next(e) would skip every non-managed settings hook there (cc
  // CONTRACT classic-chain-order): each one's body calls next(e) on every path, ours merged above it
  for (const f of ['consent.ts', 'rows.ts']) {
    const src = fs.readFileSync(path.join(PLUGIN, 'mod', f), 'utf8');
    const body = src.slice(src.indexOf("on('classic.PreToolUse'"), src.indexOf('}).catch(', src.indexOf("on('classic.PreToolUse'")));
    assert.match(body, /return mergePre\([^;]*await next\(e\)\)/, f);
    for (const ret of body.match(/return [^;]+;/g) || []) assert.match(ret, /next\(e\)/, `${f}: ${ret}`);
  }
});

test('consent: a room tool call other than post outside plan mode exits at once, loading nothing but its entry; in plan mode, or a post, it loads the rest', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-consent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'loaded.js');
  // every file a require or an import loads (require.cache lists no ES module)
  fs.writeFileSync(preload, [
    'const seen = [];',
    "require('node:module').registerHooks({ load(url, ctx, next) { if (url.startsWith('file:')) seen.push(require('node:url').fileURLToPath(url)); return next(url, ctx); } });",
    "process.on('exit', () => process.stderr.write('LOADED ' + JSON.stringify(seen) + '\\n'));",
  ].join('\n') + '\n');
  const w = new World({ claude: 'sleep', alice: 'act' }, { t });
  const run = (mode: string | undefined, tool: string) => {
    const r = w.hook('consent', ev('PreToolUse', `mcp__plugin_sub-human_room__${tool}`, { permission_mode: mode, tool_input: { text: 'hi' } }), { as: 'alice', env: { NODE_OPTIONS: `--require ${preload}` } });
    assert.equal(r.code, 0, r.stderr);
    const line = r.stderr.split('\n').find(l => l.startsWith('LOADED '));
    return { stdout: r.stdout, loaded: (JSON.parse(must(line).slice(7)) as string[]).map(f => path.relative(PLUGIN, f)).filter(f => !f.startsWith('..')) };
  };
  for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions', undefined]) {
    const q = run(mode, 'read');
    assert.equal(q.stdout, '', String(mode));
    assert.deepEqual(q.loaded.sort(), ['hooks/handlers/consent.ts', 'hooks/reply.ts', 'hooks/run.ts'], String(mode));
  }
  assert.ok(run('plan', 'read').loaded.includes('hooks/seat.ts'), 'plan mode: the review check runs');
  assert.ok(run('auto', 'post').loaded.includes('hooks/seat.ts'), 'a post in any mode: a note may wait for its card (M)');
});

// ---------- the transcript race: the model's call is not on disk yet, and Claude Code dropped plan ----------
const TEXT = '# Rename fetchUser\n\n1. rename\n2. alias\n';
const enter = (w: World, mode = 'default', extra: HookInput = {}) => {
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: mode, tool_input: {} }), { as: 'bob' });
  return w.hook('consent', ev('PostToolUse', 'EnterPlanMode', { permission_mode: 'plan', tool_input: {}, tool_response: {}, ...extra }), { as: 'bob' });
};

test('race: ExitPlanMode with input {} and no tool_use line yet still asks with the full text (the review\'s own hash)', () => {
  const { w, hash } = world();
  const file = path.join(w.userHome, '.claude', 'plans', 'race.md');
  enter(w);
  assert.equal(must(review(w)).hash, hash, 'recorded at Pre(EnterPlanMode)');
  const tp = transcript(w, file); // the plan_mode attachment only: the call is still in the flush queue
  const pre = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' });
  assert.equal(decision(pre), 'ask');
  assert.equal(planOf(pre), TEXT);
  assert.equal(fs.readFileSync(file, 'utf8'), TEXT);
  const post = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_use_id: 'tu1', tool_response: { plan: TEXT, filePath: file } }), { as: 'bob' });
  assert.match(must(ctx(post)), /bob agreed to proposal/);
  assert.deepEqual(answers(w).map(x => [x.kind, x.via, x.proposal_hash]), [['signoff', 'human', hash]]);
  assert.equal(fs.existsSync(file), false, 'did not exist before: removed');
});

test('race: no plan and nothing to show is never dropped silently; a real plan of the model\'s passes untouched', () => {
  const { w, hash } = world();
  const file = path.join(w.userHome, '.claude', 'plans', 'gone.md');
  enter(w);
  // bob answers on the card meanwhile: the proposal is no longer pending for him.
  w.lib(() => proposal.answer(seat(w, 'bob'), { hash }, { choice: 'Agree' }));
  const tp = transcript(w, file);
  assert.equal(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' }).stdout, '');
  assert.equal(must(review(w)).phase, 'exiting');
  assert.equal(permOf(w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' })).behavior, 'allow');
  const post = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_response: { plan: null } }), { as: 'bob' });
  assert.match(must(ctx(post)), new RegExp(`proposal ${hash}: nothing to show .*nothing was recorded\\. The room review is closed`));
  assert.equal(review(w), null);
});

test('plan file: Post(EnterPlanMode) writes the proposal text there (backup first); Claude Code\'s own plan matches by hash12; restored after', () => {
  const { w } = world();
  const file = path.join(w.userHome, '.claude', 'plans', 'early.md');
  fs.writeFileSync(file, 'bob\'s own plan\n');
  const tp = transcript(w, file); // an earlier plan mode in this session: the path is known already
  enter(w, 'auto', { transcript_path: tp });
  assert.equal(fs.readFileSync(file, 'utf8'), TEXT, 'the dialog has the text even if Pre loses the race');
  assert.deepEqual([must(review(w)).phase, must(review(w)).file, must(review(w)).backup], ['entering', file, 'bob\'s own plan\n']);
  // Claude Code filled plan from the file; the model's call is not in the transcript yet.
  const pre = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: TEXT, planFilePath: file }, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' });
  assert.equal(decision(pre), 'ask');
  assert.equal(planOf(pre), TEXT);
  assert.equal(must(review(w)).backup, 'bob\'s own plan\n', 'the person\'s backup survives the second write');
  const post = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'auto', tool_input: {}, tool_use_id: 'tu1', tool_response: { plan: TEXT, filePath: file } }), { as: 'bob' });
  assert.match(must(ctx(post)), /bob agreed to proposal/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'bob\'s own plan\n', 'restored');
  // Left in plan mode and then Shift+Tab out: the next prompt restores the file.
  const w2 = world();
  const f2 = path.join(w2.w.userHome, '.claude', 'plans', 'left.md');
  enter(w2.w, 'default', { transcript_path: transcript(w2.w, f2) });
  assert.equal(fs.readFileSync(f2, 'utf8'), TEXT);
  w2.w.hook('consent', ev('UserPromptSubmit', null, { permission_mode: 'default', prompt: 'x' }), { as: 'bob' });
  assert.equal(fs.existsSync(f2), false);
  assert.equal(review(w2.w), null);
});

test('plan file: the model rewrote the plan file during a review: the dialog still shows the proposal; the backup is the person\'s', () => {
  const { w, hash } = world();
  const file = path.join(w.userHome, '.claude', 'plans', 'edit.md');
  const tp = transcript(w, file);
  enter(w, 'default', { transcript_path: tp });
  fs.writeFileSync(file, '# Refactor auth\n');
  const pre = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: '# Refactor auth\n', planFilePath: file }, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' });
  assert.equal(decision(pre), 'ask');
  assert.equal(planOf(pre), TEXT);
  assert.equal(fs.readFileSync(file, 'utf8'), TEXT);
  assert.deepEqual([must(review(w)).phase, must(review(w)).backup, must(review(w)).foreign], ['shown', null, true], 'no file before the review: nothing to keep');
  const post = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_use_id: 'tu1', tool_response: { plan: TEXT, filePath: file } }), { as: 'bob' });
  assert.match(must(ctx(post)), new RegExp(`bob agreed to proposal ${hash}.*The plan you passed was not shown`));
  assert.equal(fs.existsSync(file), false);
});

test('plan file: a review of a proposal made from the session plan file leaves it byte for byte', () => {
  const { w, hash } = world();
  const file = path.join(w.userHome, '.claude', 'plans', 'proposed.md');
  fs.writeFileSync(file, TEXT); // the plan bob's session proposed: the file already holds the proposal's text
  const tp = transcript(w, file);
  enter(w, 'default', { transcript_path: tp });
  assert.equal(must(review(w)).backup, TEXT, 'a file that existed is backed up, even when it holds the proposal');
  const pre = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: `proposal ${hash}` }, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' });
  assert.equal(decision(pre), 'ask');
  assert.equal(must(review(w)).backup, TEXT);
  const post = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_use_id: 'tu1', tool_response: { plan: TEXT, filePath: file } }), { as: 'bob' });
  assert.match(must(ctx(post)), /bob agreed to proposal/);
  assert.deepEqual(answers(w).map(x => [x.kind, x.via, x.from, x.proposal_hash]), [['signoff', 'human', 'bob', hash]]);
  assert.equal(fs.readFileSync(file, 'utf8'), TEXT, 'not deleted');
  assert.equal(review(w), null);
  // The path first known at Pre(ExitPlanMode) (no transcript at enter): the same.
  const w2 = world();
  const f2 = path.join(w2.w.userHome, '.claude', 'plans', 'late.md');
  fs.writeFileSync(f2, TEXT);
  enter(w2.w);
  assert.equal(must(review(w2.w)).file, undefined, 'no path yet');
  const tp2 = transcript(w2.w, f2);
  const pre2 = w2.w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: `proposal ${w2.hash}` }, tool_use_id: 'tu1', transcript_path: tp2 }), { as: 'bob' });
  assert.equal(decision(pre2), 'ask');
  assert.deepEqual([must(review(w2.w)).file, must(review(w2.w)).backup], [f2, TEXT]);
  w2.w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_use_id: 'tu1', tool_response: { plan: TEXT, filePath: f2 } }), { as: 'bob' });
  assert.deepEqual(answers(w2.w).map(x => [x.kind, x.from, x.proposal_hash]), [['signoff', 'bob', w2.hash]]);
  assert.equal(fs.readFileSync(f2, 'utf8'), TEXT, 'not deleted');
});

test('Post(ExitPlanMode) with no review shown for a pending proposal: the model is told nothing was recorded', () => {
  const { w, hash } = world();
  // No review at all (Pre cleared it, or a pre-fix hook): Claude Code's own empty dialog, then "Yes".
  const r = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_response: { plan: null } }), { as: 'bob' });
  assert.match(must(ctx(r)), new RegExp(`Nothing recorded for ${hash}: no review opened, so bob did not answer \\(don't say they did\\)\\. Ask again \\(call EnterPlanMode, then ExitPlanMode with plan "proposal ${hash}"\\)`));
  // The review never left 'entering' (Pre did not run): same, and the plan file Post(EnterPlanMode) wrote is restored.
  const file = path.join(w.userHome, '.claude', 'plans', 'skip.md');
  enter(w, 'default', { transcript_path: transcript(w, file) });
  assert.ok(fs.existsSync(file));
  const r2 = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_response: { plan: TEXT, filePath: file } }), { as: 'bob' });
  assert.match(must(ctx(r2)), /Nothing recorded for [0-9a-f]{12}: no review opened, so bob did not answer \(don't say they did\)/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(review(w), null);
  assert.deepEqual(answers(w), []);
  // A plan of bob's own that names no proposal: the propose offer, as before.
  assert.match(must(ctx(w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_response: { plan: '# Refactor auth\n' } }), { as: 'bob' }))), /room propose tool/);
});

// ---------- the hook picks and shows the proposal (the live run: two pending, a stale hello-world plan file) ----------
const HELLO = '# Hello-world script\n\n1. create hello.sh\n2. chmod +x\n3. run it\n';
/** alice proposes "Ship v2 Friday" then "Ship v3 Monday" to bob; bob's session plan file holds an unrelated plan. */
function two() {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const me = seat(w, 'alice');
  const v2 = w.lib(() => proposal.create(me, { text: 'Ship v2 Friday', approvers: ['bob'] })).hash;
  const v3 = w.lib(() => proposal.create(me, { text: 'Ship v3 Monday', approvers: ['bob'] })).hash;
  const file = path.join(w.userHome, '.claude', 'plans', 'adaptive-shimmying-clover.md');
  fs.writeFileSync(file, HELLO);
  return { w, v2, v3, file, tp: transcript(w, file) };
}
/** bob types a prompt: its transcript line (no origin: the person's own words), then the prompt hook. */
const say = (w: World, prompt: string, tp: string) => {
  fs.appendFileSync(tp, JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, timestamp: new Date().toISOString() }) + '\n');
  return w.hook('prompt', ev('UserPromptSubmit', null, { permission_mode: 'default', prompt, transcript_path: tp }), { as: 'bob' });
};
/** What bob's tail holds for his next prompt about the proposals awaiting him (lib/tail.ts remindersText). */
// remindersText reads the seat's code, name and role only
const reminders = (w: World) => w.lib(() => tailLib.remindersText({ code: w.code, name: sn('bob'), role: 'member' } as Identity, roomLib.open(w.code)));
/** The live tool_result line of a Remote Control deny (2.1.292), with or without a note. */
function phoneDeny(w: World, file: string, toolUseId: string, note: string | null) {
  const head = 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). ';
  const tail = '\n\nNote: The user\'s next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they\'d prefer you to work, consider saving that to memory for future sessions.';
  const content = note == null ? `${head}STOP what you are doing and wait for the user to tell you how to proceed.${tail}` : `${head}To tell you how to proceed, the user said:\n${note}${tail}`;
  const f = path.join(w.cwd, `phone-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, [
    { type: 'attachment', attachment: { type: 'plan_mode', reminderType: 'full', isSubAgent: false, planFilePath: file, planExists: true } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content, is_error: true, tool_use_id: toolUseId }] },
      toolUseResult: note == null ? 'User rejected tool use' : `Error: ${content}`, toolDenialKind: 'user-rejected', ...(note == null ? {} : { userFeedback: note }) },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

test('pick: the person\'s words name the proposal (hash, else words only its title has); else none', () => {
  const { w, v2, v3 } = two();
  const ps = w.lib(() => proposal.pendingFor({ code: w.code, name: sn('bob') }));
  const pick = (s: string) => { const p = w.lib(() => proposal.namedIn(ps, s, w.code)); return p && p.hash; };
  assert.equal(pick('Open v3'), v3);
  assert.equal(pick('show me the monday one'), v3);
  assert.equal(pick('friday please'), v2);
  assert.equal(pick(`review ${v3.slice(0, 6)}`), v3);
  assert.equal(pick('ship it'), null, 'both titles have "ship": ambiguous');
  assert.equal(pick('open the proposal'), null);
  assert.equal(pick(''), null);
});

test('pick: two pending and bob says "Open v2": the review opens v2 whatever the model passes, and the reminder opens only v2', () => {
  const { w, v2, v3, file, tp } = two();
  const first = must(reminders(w));
  assert.match(first, new RegExp(`proposal ${v3} still awaits bob's answer`), 'nothing named yet: the newest');
  // the others are listed by short hash and title, so bob can name one; only the newest is to be opened
  assert.match(first, new RegExp(`1 more await bob's answer: ${v2.slice(0, 6)} "Ship v2 Friday"; the hooks open whichever bob names next, else the newest`));
  assert.doesNotMatch(first, new RegExp(`"proposal ${v2}"`));
  say(w, 'Open v2', tp);
  // Pre(EnterPlanMode): the review is v2's (bob's latest words in the transcript), and the plan file (known from an
  // earlier plan mode) holds v2 now, the unrelated plan backed up first.
  assert.equal(decision(w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {}, transcript_path: tp }), { as: 'bob' })), 'allow');
  assert.deepEqual([must(review(w)).phase, must(review(w)).hash, must(review(w)).backup], ['entering', v2, HELLO]);
  const c = must(reminders(w));
  assert.match(c, new RegExp(`proposal ${v2} still awaits bob's answer.*"proposal ${v2}"`));
  assert.doesNotMatch(c, new RegExp(`"proposal ${v3}"`), 'the other one is only listed');
  assert.match(c, new RegExp(`1 more await bob's answer: ${v3.slice(0, 6)} "Ship v3 Monday"`));
  assert.equal(fs.readFileSync(file, 'utf8'), 'Ship v2 Friday');
  // The model names the newest (as the old context told it): the dialog is still v2's.
  const pre = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: `proposal ${v3}` }, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' });
  assert.equal(decision(pre), 'ask');
  assert.equal(planOf(pre), 'Ship v2 Friday');
  assert.match(must(reason(pre)), new RegExp(`room proposal ${v2} from alice`));
  const post = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_use_id: 'tu1', tool_response: { plan: 'Ship v2 Friday', filePath: file } }), { as: 'bob' });
  assert.match(must(ctx(post)), new RegExp(`bob agreed to proposal ${v2}`));
  assert.deepEqual(answers(w).map(x => [x.kind, x.proposal_hash]), [['signoff', v2]]);
  assert.equal(fs.readFileSync(file, 'utf8'), HELLO, 'the unrelated plan is back');
  // Nothing named next time: the newest still pending (v3), and no others to list.
  say(w, 'what now?', tp);
  assert.match(must(reminders(w)), new RegExp(`proposal ${v3} still awaits`));
  assert.doesNotMatch(must(reminders(w)), /more await/);
});

test('supersede: alice re-proposes with the same title: the old one is not pending, its answer is stale, decide is null', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const alice = seat(w, 'alice'), bob = seat(w, 'bob');
  const a = w.lib(() => proposal.create(alice, { text: '# Rate limits\n\n100 a minute', approvers: ['bob'] }));
  assert.deepEqual(a.retired, []);
  const b = w.lib(() => proposal.create(alice, { text: '# Rate limits\n\n60 a minute, burst 10', approvers: ['bob'] }));
  assert.deepEqual(b.retired, [a.hash], 'the revision says what it retired');
  assert.deepEqual(w.lib(() => proposal.pendingFor(bob)).map(p => p.hash), [b.hash], 'only the revision is pending');
  assert.deepEqual(w.lib(() => proposal.answer(bob, { hash: a.hash }, { choice: 'Agree' })), { stale: true, why: 'answered, decided, superseded or unknown' });
  assert.deepEqual(answers(w), [], 'nothing recorded on the old one');
  const f = w.lib(() => roomLib.fold(w.entries()));
  assert.equal(f.superseded.get(a.hash), b.hash);
  assert.equal(must(f.status(a.hash)).state, 'superseded');
  assert.equal(must(f.status(b.hash)).state, 'open');
  // bob answered the old one before the revision (not decided yet): it is never decided, and the answer does not carry over
  const w2 = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const alice2 = { ...alice, code: w2.code }, bob2 = { ...bob, code: w2.code };
  const old = w2.lib(() => proposal.create(alice2, { text: 'Ship Friday\n\nv1', approvers: ['bob'] }));
  assert.ok(w2.lib(() => proposal.answer(bob2, { hash: old.hash }, { choice: 'Agree' })).entry);
  const rev = w2.lib(() => proposal.create(alice2, { text: 'Ship Friday\n\nv2', approvers: ['bob'] }));
  assert.deepEqual(rev.retired, [old.hash]);
  assert.equal(w2.lib(() => proposal.decide(w2.code, old.hash)), null, 'a superseded proposal is never decided');
  assert.deepEqual(w2.lib(() => proposal.pendingFor(bob2)).map(p => p.hash), [rev.hash], 'the old answer does not count for the revision');
  // proposing the old text again brings it back (and retires the other)
  const again = w2.lib(() => proposal.create(alice2, { text: 'Ship Friday\n\nv1', approvers: ['bob'] }));
  assert.deepEqual([again.hash, again.retired], [old.hash, [rev.hash]]);
});

test('supersede: bob names a replaced proposal: the review opens its latest revision and says so, not the newest', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const alice = seat(w, 'alice');
  const v1 = w.lib(() => proposal.create(alice, { text: '# Rate limits\n\n100 a minute', approvers: ['bob'] })).hash;
  const v2 = w.lib(() => proposal.create(alice, { text: '# Rate limits\n\n80 a minute', approvers: ['bob'] })).hash;
  const v3 = w.lib(() => proposal.create(alice, { text: '# Rate limits\n\n60 a minute, burst 10', approvers: ['bob'] })).hash;
  const other = w.lib(() => proposal.create(alice, { text: '# Ship Monday\n\nv3', approvers: ['bob'] })).hash;
  const ps = w.lib(() => proposal.pendingFor({ code: w.code, name: sn('bob') }));
  assert.deepEqual(ps.map(p => p.hash), [v3, other]);
  const was = w.lib(() => proposal.replacedIn(ps, `open ${v1.slice(0, 8)}`, w.code));
  assert.deepEqual([must(was).old, must(was).p.hash], [v1, v3], 'followed through v2 to the latest revision');
  assert.equal(w.lib(() => proposal.replacedIn(ps, `open ${v3}`, w.code)), null, 'a pending hash is not a replaced one');
  assert.equal(w.lib(() => proposal.replacedIn(ps, 'open abcdef012345', w.code)), null, 'an unknown hash');
  const file = path.join(w.userHome, '.claude', 'plans', 'adaptive-shimmying-clover.md');
  fs.writeFileSync(file, HELLO);
  const tp = transcript(w, file);
  say(w, `open proposal ${v2}`, tp);
  const pre = w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {}, transcript_path: tp }), { as: 'bob' });
  assert.equal(decision(pre), 'allow');
  assert.equal(reason(pre), `sub-human: proposal ${v2} was replaced by ${v3}; opening ${v3} for bob`);
  assert.equal(must(review(w)).hash, v3, 'not the newest pending one');
});

test('supersede: a different sender with the same title is not a revision: both stay pending', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep', carol: 'sleep' });
  const alice = seat(w, 'alice'), bob = seat(w, 'bob');
  const a = w.lib(() => proposal.create(alice, { text: '# Rate limits\n\nalice: 100', approvers: ['carol'] }));
  const b = w.lib(() => proposal.create(bob, { text: '# Rate limits\n\nbob: 60', approvers: ['carol'] }));
  assert.deepEqual(b.retired, []);
  assert.deepEqual(w.lib(() => proposal.pendingFor(seat(w, 'carol'))).map(p => p.hash), [a.hash, b.hash]);
});

test('pick: "propose to alice: …" with a proposal pending for bob opens no review; a plain prompt after it does', () => {
  const { w, v2, v3, file, tp } = two();
  const enter = () => w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {}, transcript_path: tp }), { as: 'bob' });
  for (const t of ['propose to alice: move the cron to 6am', 'please make a proposal to alice about the cron', 'can you draft a proposal for the API']) {
    say(w, t, tp);
    const r = enter();
    assert.equal(decision(r), undefined, `${t}: plan mode left alone`);
    assert.match(must(ctx(r)), /no room review now: bob asked you to propose something/);
    assert.equal(review(w), null, 'no review state');
    assert.equal(fs.readFileSync(file, 'utf8'), HELLO, 'the plan file untouched');
  }
  assert.deepEqual(answers(w), []);
  // the reminder tells the model the same; asking for it (or a plain prompt) opens the review as before
  assert.match(must(reminders(w)), /unless bob asked you to propose something: then do that, and this waits/);
  for (const t of ['open the proposal', 'what now?']) {
    say(w, t, tp);
    assert.equal(decision(enter()), 'allow', t);
    assert.equal(must(review(w)).hash, v3, `${t}: nothing named: the newest`);
    w.lib(() => proposal.clearReview({ code: w.code, name: sn('bob') }));
    fs.writeFileSync(file, HELLO);
  }
  // words of a pending title are not a pick when the person asks to propose; a hash named still is
  say(w, 'propose to alice: ship v3 Tuesday instead', tp);
  assert.equal(decision(enter()), undefined);
  say(w, `propose to alice after we answer ${v2.slice(0, 8)}`, tp);
  assert.equal(decision(enter()), 'allow');
  assert.equal(must(review(w)).hash, v2);
});

test('proposeIntent: asks to propose, not to open or answer one', () => {
  const yes = ['propose to alice: ship v3 Monday', 'Please propose X', 'ok, draft a proposal for the API', 'can you make a proposal to alice', 'post a proposal to alice'];
  const no = ['open the proposal', 'open the v3 proposal', "open alice's proposal", 'answer the proposal', 'Open v3', 'what now?', 'review the proposal', 'show me proposals', 'open the proposal from alice'];
  for (const t of yes) assert.equal(proposal.proposeIntent(t), true, t);
  for (const t of no) assert.equal(proposal.proposeIntent(t), false, t);
});

test('pick: a stale plan in the plan file, or the model\'s own copy of it, is never the dialog; the backup comes back', () => {
  const { w, v2, file, tp } = two();
  say(w, 'carry on', tp);
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'auto', tool_input: {}, transcript_path: tp }), { as: 'bob' });
  // The model writes the stale hello-world plan back over the proposal and passes it (the 12:55 call).
  fs.writeFileSync(file, HELLO);
  const tp2 = transcript(w, file, null, { id: 'tu1', input: { plan: HELLO, planFilePath: file } });
  const pre = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: HELLO, planFilePath: file }, tool_use_id: 'tu1', transcript_path: tp2 }), { as: 'bob' });
  assert.equal(decision(pre), 'ask');
  assert.equal(planOf(pre), 'Ship v3 Monday');
  assert.equal(fs.readFileSync(file, 'utf8'), 'Ship v3 Monday');
  assert.equal(must(review(w)).backup, HELLO, 'the backup taken at Pre(EnterPlanMode)');
  // No plan at all in the call: the same dialog.
  const w2 = two();
  w2.w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {}, transcript_path: w2.tp }), { as: 'bob' });
  assert.equal(planOf(w2.w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: w2.tp }), { as: 'bob' })), 'Ship v3 Monday');
  // Esc then a prompt (Shift+Tab out of plan mode): the unrelated plan is restored, nothing recorded.
  say(w, 'later', tp);
  assert.equal(fs.readFileSync(file, 'utf8'), HELLO);
  assert.equal(review(w), null);
  assert.deepEqual(answers(w), []);
  void v2;
});

test('pick: the model hand-writes the proposal into the plan file without a hook review: an approval records nothing', () => {
  const { w, v3, file } = two();
  fs.writeFileSync(file, 'Ship v3 Monday');
  // Already in plan mode, so no review opened; the model's own ExitPlanMode passes, the person says "Yes".
  assert.equal(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: 'Ship v3 Monday', planFilePath: file }, tool_use_id: 'tu5' }), { as: 'bob' }).stdout, '');
  const post = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: { plan: 'Ship v3 Monday' }, tool_use_id: 'tu5', tool_response: { plan: 'Ship v3 Monday', filePath: file } }), { as: 'bob' });
  assert.match(must(ctx(post)), new RegExp(`Nothing recorded for ${v3}: no review opened, so bob did not answer \\(don't say they did\\)`));
  assert.deepEqual(answers(w), []);
  // The next review opens the one that dialog was about.
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {} }), { as: 'bob' });
  assert.equal(must(review(w)).hash, v3);
});

test('G (live verify, verify1/04 and verify4/c2): bob asks his Claude to propose; the propose tool makes it; his EnterPlanMode then opens the review of it with its text', () => {
  const { w, file, tp } = two();
  const me = seat(w, 'bob');
  fs.appendFileSync(tp, JSON.stringify({ type: 'user', message: { role: 'user', content: "Propose this to the room with the propose tool, title 'Readme pass', text: 1. bob reviews the README. 2. alice fixes typos." }, timestamp: new Date(Date.now() - 2000).toISOString() }) + '\n');
  const mine = w.lib(() => proposal.create(me, { text: '# Readme pass\n\n1. bob reviews the README.\n2. alice fixes typos.\n', approvers: ['alice', 'bob'] })).hash;
  const pre = w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'auto', tool_input: {}, transcript_path: tp }), { as: 'bob' });
  assert.equal(decision(pre), 'allow', 'no "no room review now" once the proposal exists');
  assert.equal(must(review(w)).hash, mine, 'the proposal just made, not the newest of alice\'s');
  const exit = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: `proposal ${mine}` }, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' });
  assert.equal(decision(exit), 'ask');
  assert.match(String(planOf(exit)), /^# Readme pass/, 'the text, never a bare "proposal HASH"');
  assert.match(fs.readFileSync(file, 'utf8'), /^# Readme pass/);
  // Esc, then a prompt: the review asks the model to leave plan mode (the mode comes back), nothing recorded
  const later = say(w, 'later', tp);
  void later;
  assert.deepEqual(answers(w), []);
});

test('H (live verify, verify1/08): plan mode by hand, the model skips EnterPlanMode and calls ExitPlanMode with "proposal HASH": the review opens there, and Yes records', () => {
  const { w, v3, file } = two();
  fs.writeFileSync(file, `proposal ${v3}`);
  const tp = transcript(w, file, null, { id: 'tu7', input: { plan: `proposal ${v3}` } });
  const pre = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: `proposal ${v3}`, planFilePath: file }, tool_use_id: 'tu7', transcript_path: tp }), { as: 'bob' });
  assert.equal(decision(pre), 'ask', pre.stdout);
  assert.equal(planOf(pre), 'Ship v3 Monday');
  assert.equal(must(review(w)).mode, 'plan', 'the person\'s own plan mode is the one to put back');
  const post = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'auto', tool_input: { plan: 'Ship v3 Monday' }, tool_use_id: 'tu7', tool_response: { plan: 'Ship v3 Monday', filePath: file }, transcript_path: tp }), { as: 'bob' });
  assert.match(must(ctx(post)), /bob agreed to proposal/);
  assert.match(must(ctx(post)), /call EnterPlanMode to put bob's plan mode back/, 'item 7: the Yes left plan mode; it comes back');
  assert.match(must(ctx(w.hook('consent', ev('PostToolUse', 'EnterPlanMode', { permission_mode: 'plan', tool_input: {}, tool_response: {} }), { as: 'bob' }))), /bob's plan mode is back/);
  assert.equal(review(w), null);
  assert.deepEqual(answers(w).map(x => [x.kind, x.via, x.proposal_hash]), [['signoff', 'human', v3]]);
  // stage 8e I.6: the stub the model wrote is no plan of bob's: not put back (a closing ExitPlanMode would show its old hash)
  assert.equal(fs.existsSync(file), false, 'the stub is not restored');
  // a stub for a proposal that is not bob's to answer (answered now): denied, never a bare view
  const again = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: `proposal ${v3}` }, tool_use_id: 'tu8', transcript_path: tp }), { as: 'bob' });
  assert.equal(decision(again), 'deny');
  assert.match(String(hso(again).permissionDecisionReason), /nothing was shown and nothing is recorded/);
});

test('phone: a Remote Control deny with a note is bob\'s objection with that note; a bare deny records nothing', () => {
  const run = (note: string | null) => {
    const { w, v2, file, tp } = two();
    w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {}, transcript_path: tp }), { as: 'bob' });
    w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' });
    const tpd = phoneDeny(w, file, 'tu1', note);
    const stop = w.hook('consent', ev('Stop', null, { permission_mode: 'plan', stop_hook_active: false, transcript_path: tpd }), { as: 'bob' });
    assert.match(must(ctx(stop)), /call ExitPlanMode now/);
    w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' });
    assert.equal(fs.readFileSync(file, 'utf8'), HELLO, 'restored');
    const post = ctx(w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_response: { plan: null } }), { as: 'bob' }));
    return { post, a: answers(w).map(x => [x.kind, x.via, x.from, x.proposal_hash, x.text]), v2 };
  };
  const withNote = run('This is hello world. I want v3 plan');
  assert.deepEqual(withNote.a, [], 'the note waits for bob\'s Send');
  assert.match(must(withNote.post), /note on [0-9a-f]{12} waits for Send or Discard/);
  const bare = run(null);
  assert.deepEqual(bare.a, []);
  assert.match(must(bare.post), /closed the review of proposal [0-9a-f]{12} without answering; nothing was recorded/);
});

// ---------- a deny with a note never counts on its own: the confirm card ----------
/** bob's plan view for alice's v3 is denied on the phone with `note` (or bare), and the review closes. */
function deniedOnPhone(note: string | null) {
  const t = two();
  const { w, file, tp } = t;
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {}, transcript_path: tp }), { as: 'bob' });
  w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' });
  const tpd = phoneDeny(w, file, 'tu1', note);
  const stop = w.hook('consent', ev('Stop', null, { permission_mode: 'plan', stop_hook_active: false, transcript_path: tpd }), { as: 'bob' });
  w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' });
  const post = ctx(w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_response: { plan: null } }), { as: 'bob' }));
  return { ...t, stop: ctx(stop), post };
}

test('confirm: a message typed after a phone Deny lands as the note; the card asks to send it to the proposer; Send records it (via=human, signed)', () => {
  const { w, v3, post } = deniedOnPhone('open rate limiting');
  assert.deepEqual(answers(w), [], 'the note alone records nothing');
  assert.match(must(post), new RegExp(`call AskUserQuestion with "objection ${v3}"`));
  const { pre, post: sent, card } = confirm(w, v3, 'Send');
  const q = must(card.questions[0]);
  assert.equal(q.question, 'Send to alice as changes requested on "Ship v3 Monday": "open rate limiting"?');
  assert.deepEqual(q.options.map(o => o.label), ['Send', 'Discard']);
  assert.ok(q.options.every(o => o.preview === 'open rate limiting'), 'the whole note in the preview');
  assert.deepEqual(Object.keys(card), ['questions'], 'nothing of the model\'s call survives');
  assert.match(must(reason(pre)), /bob's note, to send or discard/);
  assert.match(must(ctx(sent)), /^Recorded\..*bob objected to proposal/);
  const a = answers(w);
  assert.deepEqual(a.map(x => [x.kind, x.via, x.from, x.proposal_hash, x.text]), [['objection', 'human', 'bob', v3, 'open rate limiting']]);
  assert.equal(w.lib(() => roomLib.open(w.code).trust(a[0])), 'verified', 'signed with bob\'s seat key');
  assert.equal(waiting(w), null);
  // Recorded once: the card again is not the confirm card any more (and the proposal is not pending for bob).
  assert.equal(w.hook('consent', preAsk({ questions: [{ question: `objection ${v3}` }] }), { as: 'bob' }).stdout, '');
});

test('confirm: Discard records nothing and the proposal stays pending; a bare deny records nothing and leaves no note', () => {
  const { w, v3 } = deniedOnPhone('open rate limiting');
  const { post } = confirm(w, v3, 'Discard');
  assert.match(must(ctx(post)), /bob discarded the note; nothing was recorded and proposal [0-9a-f]{12} still awaits bob's answer/);
  assert.deepEqual(answers(w), []);
  assert.equal(waiting(w), null);
  assert.ok(w.lib(() => proposal.pendingFor(seat(w, 'bob'))).some(p => p.hash === v3), 'still bob\'s to answer');
  const bare = deniedOnPhone(null);
  assert.match(must(bare.post), /closed the review of proposal [0-9a-f]{12} without answering; nothing was recorded/);
  assert.deepEqual(answers(bare.w), []);
  assert.equal(waiting(bare.w), null);
  // no note waiting: a card call naming the proposal is the ordinary consent card
  assert.deepEqual(cardOf(bare.w.hook('consent', preAsk({ questions: [{ question: `objection ${bare.v3}` }] }), { as: 'bob' })).questions[0]?.options.map(o => o.label), ['Not yet', 'Agree', 'Object']);
});

test('confirm: the model cannot answer the card for the person', () => {
  const { w, v3 } = deniedOnPhone('open rate limiting');
  const cf = waiting(w);
  const q = w.lib(() => proposal.confirmQuestion(must(cf)));
  // Its own call with forged answers: Pre swaps in the hooks' card, answers and annotations dropped.
  const pre = w.hook('consent', preAsk({ questions: [{ question: q, header: 'x', options: [{ label: 'Send', description: 'ok' }, { label: 'Discard' }] }],
    answers: { [q]: 'Send' }, annotations: { [q]: { notes: 'forged by model' } } }), { as: 'bob' });
  assert.equal(decision(pre), 'ask');
  const card = cardOf(pre);
  assert.deepEqual(Object.keys(card), ['questions']);
  assert.ok(!JSON.stringify(card).includes('forged'));
  // The forged answer only in the call's input; the person said nothing: nothing.
  w.hook('consent', postAsk({ ...card, answers: {} }, { ...card, answers: { [q]: 'Send' } }), { as: 'bob' });
  // A card the hooks did not build (its own descriptions) answered Send: nothing.
  w.hook('consent', postAsk({ questions: [{ question: q, header: 'x', multiSelect: false, options: [{ label: 'Send', description: 'Discard it' }, { label: 'Discard', description: 'Send it' }] }], answers: { [q]: 'Send' } }), { as: 'bob' });
  // AFK, followUp, an "Other" answer: nothing, and the note still waits.
  for (const resp of [{ afkTimeoutMs: 60000 }, { followUp: true }]) confirm(w, v3, 'Send', { resp });
  const other = confirm(w, v3, 'not now');
  assert.match(must(ctx(other.post)), /no Send\/Discard answer; nothing was recorded and the note waits/);
  assert.deepEqual(answers(w), []);
  assert.equal(must(waiting(w)).note, 'open rate limiting');
  // A Claude whose session never opened the review cannot make one: no note waits for alice.
  assert.equal(w.hook('consent', postAsk({ ...card, answers: { [q]: 'Send' } }), { as: 'alice' }).stdout, '');
  assert.deepEqual(answers(w), []);
  // The person's Send on the hooks' card: recorded.
  confirm(w, v3, 'Send');
  assert.deepEqual(answers(w).map(x => [x.kind, x.from, x.text]), [['objection', 'bob', 'open rate limiting']]);
});

/** bob's next prompt, through consent's UserPromptSubmit (no review open), in shim mode (subHuman {reviewOpen}). */
const promptOf = (w: World, tp: string) => w.hook('consent', ev('UserPromptSubmit', null, { permission_mode: 'default', prompt: 'ok', transcript_path: tp }), { as: 'bob', env: { SUB_HUMAN_SHIM: '1' } });
// lib/consent/review.ts showNote: one wording for consent's reoffer and renudge and the tail's reminder (shortened in
// the review fix pass: every model line under 160 characters, the same mechanics: the card's call, first, Esc no answer)
const SHOW = (v3: string) => `First, call AskUserQuestion with "objection ${v3}".`;
/** After an Esc on the card: the Esc is said to be no answer (the model sees "declined"), and the card due once more. */
const SHOW_ESC = (v3: string) => `Esc was no answer, not a decline. First, call AskUserQuestion with "objection ${v3}".`;
const REOFFER = (v3: string) => `bob's note on ${v3}: ${SHOW_ESC(v3)} Don't post or answer it yourself.`;
const REOFFER_UNSHOWN = (v3: string) => `bob's note on ${v3}: its card was never shown. ${SHOW(v3)} Don't post or answer it yourself.`;
const RENUDGE = (v3: string) => `bob's note on ${v3} still waits; Esc was no answer. First, call AskUserQuestion with "objection ${v3}". Don't post or answer it yourself.`;
const stopOf = (w: World, tp: string, active = false) => w.hook('consent', ev('Stop', null, { permission_mode: 'default', stop_hook_active: active, transcript_path: tp }), { as: 'bob', env: { SUB_HUMAN_SHIM: '1' } });

test('confirm: Stop nudges once when the card was never shown; shim mode reports it open until then; a new review of that proposal drops the note', () => {
  const { w, v3, tp } = deniedOnPhone('open rate limiting');
  const shim = { as: 'bob', env: { SUB_HUMAN_SHIM: '1' } };
  const stop = () => w.hook('consent', ev('Stop', null, { permission_mode: 'default', stop_hook_active: false, transcript_path: tp }), shim);
  const first = stop();
  assert.match(must(ctx(first)), new RegExp(`bob's note on ${v3} waits: call AskUserQuestion with "objection ${v3}"`));
  const again = stop();
  assert.equal(ctx(again), undefined, 'once');
  assert.equal(again.json?.subHuman?.reviewOpen, true, 'the next prompt offers it again (reoffer)');
  assert.ok(waiting(w), 'still waiting for bob');
  assert.equal(must(waiting(w)).asked, undefined, 'a nudge shows no card: not asked');
  // the model ignored the nudge: the next prompt offers it again, saying the card was never shown
  assert.equal(ctx(promptOf(w, tp)), REOFFER_UNSHOWN(v3));
  assert.equal(ctx(stopOf(w, tp)), undefined, 'never shown: the Stop nudge was spent already, no renudge');
  assert.equal(ctx(promptOf(w, tp)), undefined, 'once');
  // bob opens the review again: the old note is superseded.
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {}, transcript_path: tp }), { as: 'bob' });
  assert.equal(waiting(w), null);
  assert.deepEqual(answers(w), []);
});

test('confirm: a card interrupted before bob answered (Pre, no Post) is offered again once, at the next prompt', () => {
  const { w, v3, tp } = deniedOnPhone('open rate limiting');
  assert.equal(decision(w.hook('consent', preAsk({ questions: [{ question: `objection ${v3}` }] }), { as: 'bob' })), 'ask');
  // no Post: bob pressed Esc on the card. Shim mode reports it open, so the module still runs node for the prompt.
  const stop = w.hook('consent', ev('Stop', null, { permission_mode: 'default', stop_hook_active: false, transcript_path: tp }), { as: 'bob', env: { SUB_HUMAN_SHIM: '1' } });
  assert.equal(ctx(stop), undefined, 'the card was shown: no Stop nudge');
  assert.equal(stop.json?.subHuman?.reviewOpen, true);
  // the tail's reminder that rides the same prompt says the same, not a softer "if bob asks"
  assert.equal(reminders(w), `proposal ${v3}: bob's note is not recorded yet. ${SHOW_ESC(v3)} Don't reopen the review (that drops the note).`);
  const first = promptOf(w, tp);
  assert.equal(ctx(first), REOFFER(v3));
  assert.equal(first.stdout.split('Esc was no answer').length, 2, 'exactly once');
  assert.equal(first.json?.subHuman?.reviewOpen, true, 'the Stop of this turn may still nudge (renudge)');
  // the model shows the card this turn (bob presses Esc again): no Stop nudge, nothing due any more
  assert.equal(decision(w.hook('consent', preAsk({ questions: [{ question: `objection ${v3}` }] }), { as: 'bob' })), 'ask');
  const shown = stopOf(w, tp);
  assert.equal(ctx(shown), undefined, 'shown again: no renudge');
  assert.equal(shown.json?.subHuman?.reviewOpen, true, 'stage 8e D: open until bob hears once what Send and Discard do');
  // offered again: from the next change on, the reminder waits for bob to ask
  assert.match(must(reminders(w)), new RegExp(`^proposal ${v3}: bob's note waits to be sent or discarded; if bob asks`));
  const second = promptOf(w, tp);
  assert.equal(ctx(second), undefined, 'once');
  assert.match(must(second.json?.systemMessage), /^sub-human: your note on .* still waits, not sent\. On its card, Send posts it as your objection; Discard drops it and records nothing/);
  assert.equal(second.json?.subHuman?.reviewOpen, false, 'told the person: nothing more is due');
  assert.equal(must(promptOf(w, tp).json).systemMessage, undefined, 'the person is told once');
  assert.equal(must(waiting(w)).note, 'open rate limiting', 'the note still waits');
  assert.deepEqual(answers(w), []);
  // offered again and shown: Send still records it
  confirm(w, v3, 'Send');
  assert.deepEqual(answers(w).map(x => [x.kind, x.from, x.text]), [['objection', 'bob', 'open rate limiting']]);
});

test('confirm: an interrupted card the model does not show again after reoffer: its Stop nudges once more, then never', () => {
  const { w, v3, tp } = deniedOnPhone('open rate limiting');
  assert.equal(decision(w.hook('consent', preAsk({ questions: [{ question: `objection ${v3}` }] }), { as: 'bob' })), 'ask');
  // no Post (Esc); the model takes the "declined" for bob's choice and does not show the card on the next prompt
  assert.equal(ctx(promptOf(w, tp)), REOFFER(v3));
  assert.equal(ctx(stopOf(w, tp, true)), undefined, 'a Stop already continued: nothing');
  const st = stopOf(w, tp);
  assert.equal(ctx(st), RENUDGE(v3));
  assert.equal(st.json?.subHuman?.reviewOpen, true, 'stage 8e D: open until bob hears once what Send and Discard do');
  assert.equal(ctx(stopOf(w, tp)), undefined, 'once');
  const third = promptOf(w, tp);
  assert.equal(ctx(third), undefined, 'no third offer');
  assert.match(must(third.json?.systemMessage), /still waits, not sent/);
  assert.equal(third.json?.subHuman?.reviewOpen, false, 'nothing more is due: the module may skip node');
  assert.match(must(reminders(w)), new RegExp(`^proposal ${v3}: bob's note waits to be sent or discarded; if bob asks`));
  // shown after the nudge and interrupted again: the person's to ask for, never offered again
  assert.equal(decision(w.hook('consent', preAsk({ questions: [{ question: `objection ${v3}` }] }), { as: 'bob' })), 'ask');
  assert.equal(ctx(promptOf(w, tp)), undefined);
  assert.equal(ctx(stopOf(w, tp)), undefined);
  assert.equal(must(waiting(w)).note, 'open rate limiting', 'the note still waits');
  assert.deepEqual(answers(w), []);
});

test('confirm: a renudge due for a proposal no longer bob\'s to answer drops the note instead', () => {
  const { w, v3, tp } = deniedOnPhone('open rate limiting');
  w.hook('consent', preAsk({ questions: [{ question: `objection ${v3}` }] }), { as: 'bob' });
  promptOf(w, tp);
  const gone = 'f'.repeat(12); // decided, retired or answered elsewhere meanwhile: not pending for bob
  w.lib(() => proposal.writeConfirm(seat(w, 'bob'), { ...must(waiting(w)), hash: gone }));
  assert.equal(ctx(stopOf(w, tp)), undefined);
  assert.equal(waiting(w), null);
});

test('confirm: a card that closed with a Post (AFK, no Send/Discard) is not offered again: the model was told', () => {
  const { w, v3, tp } = deniedOnPhone('open rate limiting');
  confirm(w, v3, 'Send', { resp: { afkTimeoutMs: 60000 } });
  assert.match(must(reminders(w)), /if bob asks, call AskUserQuestion/, 'told: the reminder no longer says now');
  const p = promptOf(w, tp);
  assert.equal(ctx(p), undefined);
  assert.equal(p.json?.subHuman?.reviewOpen, false);
  assert.equal(ctx(stopOf(w, tp)), undefined, 'told: no Stop nudge either');
  confirm(w, v3, 'not now');
  assert.equal(ctx(promptOf(w, tp)), undefined);
  assert.equal(must(waiting(w)).note, 'open rate limiting');
});

test('M (live verify, verify5/M): the plan view refused with a note: the module\'s report (a PostToolUseFailure with the refusal) opens the note at once, tells the model and the person; a post while it waits is refused in any mode; Send records it', () => {
  const { w, hash } = world();
  const file = path.join(w.userHome, '.claude', 'plans', 'm.md');
  const note = 'please also add a CODE_OF_CONDUCT';
  const tp = transcript(w, file, null, { id: 'tu1', input: { plan: `proposal ${hash}` } });
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'auto', tool_input: {} }), { as: 'bob' });
  assert.equal(decision(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' })), 'ask');
  // the refusal, as the module's tool.call hook got it back (the transcript line not written yet)
  const r = w.hook('consent', ev('PostToolUseFailure', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp, error: said(note) }), { as: 'bob' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(hso(r).hookEventName, 'PostToolUseFailure');
  assert.match(must(ctx(r)), new RegExp(`^sub-human: nothing is recorded yet: bob's note on ${hash} waits for its card \\(Send or Discard\\)`));
  assert.match(must(r.json?.systemMessage), /^sub-human: your note on "Rename fetchUser" is not sent yet: Send or Discard on the card that follows decides$/);
  assert.equal(must(waiting(w)).note, note);
  assert.deepEqual(answers(w), []);
  // the model tries to post its paraphrase: refused while the note waits, whatever mode the module last saw
  for (const mode of ['plan', 'auto']) {
    const p = w.hook('consent', ev('PreToolUse', 'mcp__plugin_sub-human_room__post', { permission_mode: mode, tool_input: { kind: 'say', text: 'dave declined it' }, transcript_path: tp }), { as: 'bob' });
    assert.equal(decision(p), 'deny', mode);
  }
  // the review closes as before (back to auto), the note still waiting; a post is still refused, a read is not
  assert.equal(permOf(w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' })).updatedPermissions[0]?.mode, 'auto');
  w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'auto', tool_input: {}, tool_response: { plan: null } }), { as: 'bob' });
  assert.equal(review(w), null);
  const p = w.hook('consent', ev('PreToolUse', 'mcp__plugin_sub-human_room__post', { permission_mode: 'auto', tool_input: { kind: 'say', text: 'x' } }), { as: 'bob' });
  assert.match(must(reason(p)), /^sub-human: refused: bob's note on proposal [0-9a-f]{12} waits for Send or Discard on its card/);
  assert.equal(w.hook('consent', ev('PreToolUse', 'mcp__plugin_sub-human_room__read', { permission_mode: 'auto', tool_input: {} }), { as: 'bob' }).stdout, '');
  confirm(w, hash, 'Send');
  assert.deepEqual(answers(w).map(x => [x.kind, x.via, x.text]), [['objection', 'human', note]]);
  assert.equal(w.hook('consent', ev('PreToolUse', 'mcp__plugin_sub-human_room__post', { permission_mode: 'auto', tool_input: { kind: 'say', text: 'x' } }), { as: 'bob' }).stdout, '', 'sent: posts pass again');
});

test('H3 (live verify, verify5/H3): the person switched to plan mode mid-turn; the mode the EnterPlanMode call was made in (noted by the hooks.json hook) wins over the module\'s stale one: no review there, the stub opens it and the Yes puts plan mode back', () => {
  const { w, v3, file } = two();
  const dir = path.join(w.home, 'sessions', 'mode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, must(w.sid.bob)), 'plan\n');
  const tp = transcript(w, file, null, { id: 'tu9', input: { plan: `proposal ${v3}` } });
  // the module last saw "auto" (the wake's prompt); the call was made in plan mode
  const enter = w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'auto', tool_input: {}, transcript_path: tp }), { as: 'bob' });
  assert.equal(enter.stdout, '', 'plan mode is the person\'s own: no review opens at EnterPlanMode');
  assert.equal(review(w), null);
  assert.equal(fs.existsSync(path.join(dir, must(w.sid.bob))), false, 'the note is taken once');
  const pre = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: `proposal ${v3}`, planFilePath: file }, tool_use_id: 'tu9', transcript_path: tp }), { as: 'bob' });
  assert.equal(decision(pre), 'ask');
  assert.match(String(hso(pre).permissionDecisionReason), /Agree: any "Yes" \(your plan mode comes back\)/);
  assert.equal(must(review(w)).mode, 'plan');
});

test('8 (live verify): a plan-view Yes that came as the view opened (or while bob was typing) records nothing; the card asks once, and only its Agree records', () => {
  const { w, hash } = world();
  const file = path.join(w.userHome, '.claude', 'plans', 'quick.md');
  const tp = transcript(w, file, null, { id: 'tu1', input: { plan: `proposal ${hash}` } });
  const guard = { as: 'bob', env: { SUB_HUMAN_YES_GUARD_MS: '60000' } };
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'auto', tool_input: {} }), guard);
  assert.equal(decision(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp }), guard)), 'ask');
  const yes = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'auto', tool_input: {}, tool_use_id: 'tu1', tool_response: { plan: fs.readFileSync(file, 'utf8'), filePath: file }, transcript_path: tp }), guard);
  assert.match(must(ctx(yes)), /^Nothing recorded yet: bob's Yes came as the view opened/);
  assert.match(must(yes.json?.systemMessage), /your Yes on "Rename fetchUser" came right as the review opened, so it is not recorded yet/);
  assert.deepEqual(answers(w), []);
  // the card for it (not the plan view again), then Agree there: recorded via=human, once
  const pre = w.hook('consent', preAsk({ questions: [{ question: `proposal ${hash}`, header: 'x', options: [{ label: 'Agree' }] }] }), guard);
  assert.equal(decision(pre), 'ask');
  const card = cardOf(pre);
  w.hook('consent', postAsk({ ...card, answers: { [must(card.questions[0]).question]: 'Agree' } }), guard);
  assert.deepEqual(answers(w).map(x => [x.kind, x.via]), [['signoff', 'human']]);
});
