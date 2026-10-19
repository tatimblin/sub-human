// The author first (0.5.0-beta.24): a version a person's Claude writes is that person's to check before anyone else is
// asked (lib/proposal.ts check, a draft request addressed to them alone). Their plan view's Yes is their sign-off and
// sends it out (sendOut: everyone present asked); "Tell Claude what to change" asks for another version, recording and
// sending nothing; nobody else can ask for sign-off on it before that Yes. The hooks' path end to end (hooks/consent.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { World, hso, decision, reason, ctx } from './helpers.ts';
import type { HookInput, HookRun } from './helpers.ts';
import * as proposal from '../../lib/proposal.ts';
import * as plans from '../../lib/plans.ts';
import * as review from '../../lib/consent/review.ts';
import * as edit from '../../lib/consent/edit.ts';
import { sn } from '../support/brands.ts';
import { must } from '../support/must.ts';

const ev = (event: string, tool?: string | null, extra: HookInput = {}): HookInput => ({ hook_event_name: event, ...(tool ? { tool_name: tool } : {}), ...extra });
const seat = (w: World, name: string) => ({ code: w.code, name: sn(name) });
const answers = (w: World) => w.entries().filter(e => e.kind === 'signoff' || e.kind === 'objection');
const requests = (w: World) => w.entries().filter(e => e.kind === 'proposal');
const said = (text: string) => `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n${text}\n\nNote: x`;
function transcript(w: World, planFile: string): string {
  const f = path.join(w.cwd, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, `${JSON.stringify({ type: 'attachment', attachment: { type: 'plan_mode', reminderType: 'full', planFilePath: planFile, planExists: false } })}\n`);
  return f;
}

/** alice's Claude writes room plan v1 in plan mode (the edit's hooks), and leaves plan mode: returns the receipt, the
 * closing context and alice's plan file. In bypass-permissions mode (one the plan view opens no review in), so the
 * closing call only leaves plan mode and her check opens later (aliceReviews); test/hooks/consent-edit.node-test.ts
 * has the closing call that shows it at once. */
function aliceWrites(w: World): { pre: HookRun; post: HookRun; file: string } {
  const file = path.join(w.userHome, '.claude', 'plans', 'alice-plan.md');
  fs.writeFileSync(file, '# my own plan\n');
  w.lib(() => proposal.writeEdit(seat(w, 'alice'), { phase: 'open', plan: 'room', base: 0, at: Date.now() }));
  const as = { as: 'alice' };
  w.enterPlan(ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'bypassPermissions', tool_input: {} }), as);
  w.hook('consent', ev('PlanAttachment', null, { permission_mode: 'plan', plan_file_path: file }), { ...as, env: { SUB_HUMAN_SHIM: '1' } });
  const t = fs.readFileSync(file, 'utf8');
  const at = t.indexOf('-->', t.indexOf('<!-- sub-human plan room v', 10)) + 3;
  fs.writeFileSync(file, `${t.slice(0, at).replace('Summary of this edit: ', 'Summary of this edit: paging')}\n\n# Paging\n\n1. cursor\n`);
  const text = fs.readFileSync(file, 'utf8');
  const pre = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: text, planFilePath: file }, tool_use_id: 'e1' }), as);
  const leave = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: text }, tool_use_id: 'e2' }), as);
  assert.deepEqual([decision(leave), hso(leave).updatedInput], ['ask', { plan: '' }], 'Claude Code\'s own "exit plan mode?": she leaves it');
  const post = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'bypassPermissions', tool_input: {}, tool_use_id: 'e2', tool_response: { plan: '', filePath: file } }), as);
  return { pre, post, file };
}

/** alice's review of her own new version: EnterPlanMode, then the plan view (ExitPlanMode "proposal HASH"). */
function aliceReviews(w: World, hash: string, file: string): { tp: string; shown: HookRun } {
  const tp = transcript(w, file);
  const as = { as: 'alice' };
  const enter = w.enterPlan(ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {}, transcript_path: tp }), as);
  assert.equal(enter.opened, true);
  const shown = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: `proposal ${hash}` }, tool_use_id: 'r1', transcript_path: tp }), as);
  return { tp, shown };
}

test('author first: a stored version asks its author alone (a draft); nobody else can ask before their Yes; the Yes is their sign-off and sends it out to everyone', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const { pre, post, file } = aliceWrites(w);
  // the receipt: saved, not sent out; the next step is alice's own check
  assert.equal(reason(pre), edit.EDIT_SAY.storedCheck('room', 1));
  const [draft] = requests(w);
  const hash = String(must(draft).hash);
  assert.deepEqual([draft?.from, draft?.to, draft?.approvers, draft?.via], ['alice', 'alice', ['alice'], 'agent']);
  assert.match(must(hso(pre).additionalContext), new RegExp(`^Nobody else is asked yet: your person checks it first\\. .*Then ${review.NEXT.open(hash).replace(/[()]/g, '\\$&')}`));
  assert.equal(must(ctx(post)), edit.EDIT_SAY.leftCheck('room', 1, hash) + ' The session plan file is back as it was before the edit (the person\'s own plan, unchanged).');
  assert.equal(fs.readFileSync(file, 'utf8'), '# my own plan\n');
  // nobody else is asked, nothing is decided; the plan reads as not sent out; asking for sign-off is refused
  assert.deepEqual(w.lib(() => proposal.pendingFor(seat(w, 'bob'))), []);
  assert.deepEqual(w.lib(() => proposal.pendingFor(seat(w, 'alice'))).map(p => [p.hash, p.draft]), [[hash, true]]);
  assert.match(w.lib(() => plans.describe(w.code, 'room')), /^plan room v1 · not sent out yet \(alice checks it first\)/);
  assert.throws(() => w.lib(() => proposal.ask(seat(w, 'bob'), { plan: 'room' })), /not sent out yet: its author alice checks it first/);
  assert.throws(() => w.lib(() => proposal.ask(seat(w, 'alice'), { plan: 'room' })), /not sent out yet: alice checks it first \(call EnterPlanMode/);
  // alice's review opens her own version, with its own line
  const { tp, shown } = aliceReviews(w, hash, file);
  assert.equal(decision(shown), 'ask');
  assert.match(must(reason(shown)), /^your new version, plan room v1, for alice: nobody else is asked until you send it out .*Send it out \(your own sign-off\): "Yes, manually approve edits" keeps your mode\. Keep editing: "Tell Claude what to change" \+ what\./);
  // her Yes: her sign-off, and the request to everyone present (bob); no decision yet
  const yes = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_use_id: 'r1', transcript_path: tp,
    tool_response: { plan: '# Paging\n\n1. cursor\n', isAgent: false, filePath: file } }), { as: 'alice' });
  assert.match(must(ctx(yes)), /^alice sent plan room v1 out: bob asked to sign off; alice's Yes is their own sign-off\. The room shows it: post nothing about it\. This was a room review/);
  assert.deepEqual(answers(w).map(a => [a.kind, a.via, a.from, a.proposal_hash]), [['signoff', 'human', 'alice', hash]]);
  const sent = must(requests(w).at(-1));
  assert.deepEqual([sent.hash, sent.to, sent.approvers], [hash, 'room', ['alice', 'bob']]);
  assert.deepEqual(w.entries().filter(e => e.kind === 'decision'), []);
  assert.deepEqual(w.lib(() => proposal.pendingFor(seat(w, 'bob'))).map(p => p.hash), [hash], 'bob is asked now');
  assert.deepEqual(w.lib(() => proposal.pendingFor(seat(w, 'alice'))), [], 'alice is not asked again');
  assert.match(w.lib(() => plans.describe(w.code, 'room')), /^plan room v1 · waiting on bob/);
  // bob agrees: agreed by both
  w.lib(() => proposal.answer(seat(w, 'bob'), { hash }, { choice: 'Agree' }));
  assert.match(String(must(w.lib(() => proposal.decide(w.code, hash))).text), /^agreed: alice, bob/);
});

test('author first: "Tell Claude what to change" on your own version records and sends nothing, and asks for the next version; Esc leaves it unsent', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const { file } = aliceWrites(w);
  const hash = String(must(requests(w)[0]).hash);
  const { tp } = aliceReviews(w, hash, file);
  const r = w.hook('consent', ev('PostToolUseFailure', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'r1', transcript_path: tp, error: said('cap pages at 100') }), { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  const told = must(ctx(r));
  assert.match(told, /^sub-human: First call ExitPlanMode now \(no plan needed: the hooks close the review; your person leaves plan mode\)\. Then: Nothing was sent or recorded: alice wants changes to their own new version \(plan room v1\)\. Write them as the plan's next version \(the plan tool, op edit, name room\); it comes back to alice before anyone else is asked\.$/);
  assert.equal(w.lib(() => proposal.readConfirm(seat(w, 'alice'))), null, 'no note card: the note is for alice\'s own Claude');
  assert.deepEqual(answers(w), []);
  assert.equal(requests(w).length, 1, 'nothing sent out');
  // the closing call leaves plan mode (Claude Code's own question, which she answers); its Post does not tell the model
  // to return to what it was doing
  const leave = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'r2', transcript_path: tp }), { as: 'alice' });
  assert.deepEqual([decision(leave), hso(leave).updatedInput], ['ask', { plan: '' }]);
  const closed = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_response: { plan: null } }), { as: 'alice' });
  assert.doesNotMatch(String(ctx(closed)), /Return to what you were doing/);
  assert.deepEqual(w.lib(() => proposal.pendingFor(seat(w, 'alice'))).map(p => p.hash), [hash], 'still alice\'s to send out or replace');
  assert.deepEqual(w.lib(() => proposal.pendingFor(seat(w, 'bob'))), []);
});

test('author first: the card fallback: Agree sends it out, Object records nothing and asks for the next version', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  aliceWrites(w);
  const hash = String(must(requests(w)[0]).hash);
  const as = { as: 'alice' };
  const ask = (label: string) => {
    const pre = w.hook('consent', ev('PreToolUse', 'AskUserQuestion', { permission_mode: 'bypassPermissions', tool_input: { questions: [{ question: `proposal ${hash}`, header: 'x', options: [] }] } }), as);
    assert.equal(decision(pre), 'ask');
    // the card the hooks put in the call (lib/proposal.ts cardFor over alice's pending request)
    const card = w.lib(() => proposal.cardFor(proposal.pendingFor(seat(w, 'alice')), w.code));
    assert.deepEqual(hso(pre).updatedInput, card);
    const q = must(card.questions[0]);
    return { q, post: w.hook('consent', ev('PostToolUse', 'AskUserQuestion', { tool_input: card, tool_response: { ...card, answers: { [q.question]: label } } }), as) };
  };
  // a mode with no plan view for a review (bypass permissions): the card itself
  const object = ask('Object');
  assert.equal(must(object.q.options.find(o => o.label === 'Agree')).description, 'Send it out: the others are asked to sign off (this is your sign-off)');
  assert.match(must(ctx(object.post)), /^Nothing was sent or recorded: alice wants changes to their own new version/);
  assert.deepEqual(answers(w), []);
  const agree = ask('Agree');
  assert.match(must(ctx(agree.post)), /^alice sent plan room v1 out: bob asked to sign off/);
  assert.deepEqual(answers(w).map(a => [a.kind, a.from]), [['signoff', 'alice']]);
  assert.deepEqual(must(requests(w).at(-1)).approvers, ['alice', 'bob']);
});

test('author first: in a room of one the Yes sends it out and decides it', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  const { file } = aliceWrites(w);
  const hash = String(must(requests(w)[0]).hash);
  const { tp } = aliceReviews(w, hash, file);
  const yes = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_use_id: 'r1', transcript_path: tp,
    tool_response: { plan: '# Paging\n\n1. cursor\n', isAgent: false, filePath: file } }), { as: 'alice' });
  assert.match(must(ctx(yes)), /^alice sent plan room v1 out; alice's Yes is their own sign-off; the room decided: agreed: alice/);
});
