// hooks/handlers/prompt.ts: the one UserPromptSubmit process (at-room.ts handle, then consent.ts onPrompt) and how their
// outputs merge: a stopped prompt (@room post, refusal) goes out alone; otherwise one output with both contexts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { World, PLUGIN, HOOKS, hso, ctx, identity } from './helpers.ts';
import { merge } from '../../hooks/handlers/prompt.ts';
import type { HookOutput } from '../../hooks/types.ts';
import type * as Register from '../../mod/register.ts';
import type { Review } from '../../lib/types-app.ts';
import * as proposal from '../../lib/proposal.ts';
import { sn } from '../support/brands.ts';

const NONCE = 'abcdef01'.repeat(4);
const ev = (extra = {}) => ({ hook_event_name: 'UserPromptSubmit', sub_human_origin: 'composer', sub_human_nonce: NONCE, prompt_id: 'p1', ...extra });
/** The module's lease for `as`'s session, holding the nonce ev() carries (hooks/handlers/mod-hello.ts writes the real one). */
const lease = (w: World, as: string) => w.lib(() => identity.writeModLease(w.sid[as], { nonce: NONCE }));
const ctxOut = (text: string): HookOutput => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });

test('prompt: merge keeps a stopping output alone and otherwise joins the contexts, the first output\'s fields winning', () => {
  const sent: HookOutput = { continue: false, stopReason: "✓ sent to room otter-4821 (Claude wasn't asked)", hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'bob.x' } };
  const block: HookOutput = { decision: 'block', reason: 'no', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true } };
  assert.deepEqual(merge([sent, ctxOut('exit plan mode first')]), sent);
  assert.deepEqual(merge([block, ctxOut('exit plan mode first')]), block);
  assert.equal(merge([]), null);
  const a: HookOutput = { systemMessage: 'carol joined', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Room since…', sessionTitle: 'bob.x' } };
  assert.deepEqual(merge([a, ctxOut('Before anything else…')]), {
    systemMessage: 'carol joined',
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'bob.x', additionalContext: 'Room since…\n\nBefore anything else…' },
  });
  assert.deepEqual(merge([null, ctxOut('only consent')]), ctxOut('only consent'));
  // consent's systemMessage (an answer not recorded) reaches the person beside at-room's, also on a stopped prompt
  const unsent = { ...ctxOut('NOT recorded'), systemMessage: 'sub-human: ✗ not recorded' };
  assert.equal(merge([a, unsent])!.systemMessage, 'carol joined\nsub-human: ✗ not recorded');
  assert.deepEqual(merge([sent, unsent]), { ...sent, systemMessage: 'sub-human: ✗ not recorded' });
});

test('prompt: no hooks.json UserPromptSubmit entry; the module runs prompt.ts (mod/prompt.ts)', async () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8')).hooks.UserPromptSubmit, undefined);
  const { HOOKS: MOD } = await import(path.join(PLUGIN, 'mod', 'register.ts')) as typeof Register;
  assert.ok(MOD.some(h => h.event === 'classic.UserPromptSubmit' && h.file === 'mod/prompt.ts'));
  assert.match(fs.readFileSync(path.join(PLUGIN, 'mod', 'prompt.ts'), 'utf8'), /shimArgv\(root, 'prompt'\)/);
});

test('prompt: consent\'s subHuman {reviewOpen} rides on the one output (only the mod runs prompt.ts)', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const shim = { as: 'bob' };
  lease(w, 'bob');
  const r = w.hook('prompt', ev({ prompt: 'hi', permission_mode: 'default' }), shim);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json!.subHuman, { reviewOpen: false });
  w.lib(() => proposal.writeReview({ code: w.code, name: sn('bob') }, { phase: 'shown', mode: 'auto', at: Date.now(), hash: 'abcdef012345' }));
  const p = w.hook('prompt', ev({ prompt: 'still here', permission_mode: 'plan' }), shim);
  assert.deepEqual(p.json!.subHuman, { reviewOpen: true });
  assert.match(ctx(p)!, /ExitPlanMode/);
  const s = w.hook('prompt', ev({ prompt: '@room posted', permission_mode: 'plan' }), shim);
  assert.equal(s.json!.continue, false);
  assert.deepEqual(s.json!.subHuman, { reviewOpen: true });
  // unseated: only the report
  const u = new World({}, { room: false });
  const n = u.hook('prompt', ev({ prompt: 'hello' }), { env: { CLAUDE_PID: undefined }, session: false });
  assert.deepEqual(n.json, { subHuman: { reviewOpen: false } });
});

test('prompt: an open review in plan mode adds consent\'s exit line to at-room\'s context; an @room post stops alone and leaves the review for the next prompt (stage 8e I.4)', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const bob = { code: w.code, name: sn('bob') };
  const setReview = (st: Review) => w.lib(() => proposal.writeReview(bob, st));
  const getReview = () => w.lib(() => proposal.readReview(bob));
  lease(w, 'bob');
  setReview({ phase: 'shown', mode: 'auto', at: Date.now(), hash: 'abcdef012345' });
  const r = w.hook('prompt', ev({ prompt: 'hi', permission_mode: 'plan' }), { as: 'bob' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(ctx(r)!, /Before anything else, call ExitPlanMode now/, 'consent');
  assert.equal(getReview()!.phase, 'exiting');
  // @room while the review is still open: the post's receipt alone; consent takes no step (no turn reads it)
  setReview({ phase: 'shown', mode: 'auto', at: Date.now(), hash: 'abcdef012345' });
  const p = w.hook('prompt', ev({ prompt: '@room hello all', permission_mode: 'plan' }), { as: 'bob' });
  assert.equal(p.code, 0, p.stderr);
  assert.equal(p.json!.continue, false);
  assert.match(p.json!.stopReason!, /^✓ sent/);
  assert.equal(hso(p).additionalContext, undefined, 'no context on a stopped prompt');
  assert.equal(getReview()!.phase, 'shown');
  assert.equal(w.entries().filter(e => e.kind === 'say' && e.text === 'hello all').length, 1);
  // not in plan mode: consent restores and clears; at-room's output stands as it was
  const q = w.hook('prompt', ev({ prompt: 'carry on', permission_mode: 'default' }), { as: 'bob' });
  assert.equal(q.code, 0, q.stderr);
  assert.equal(getReview(), null);
  assert.doesNotMatch(ctx(q) || '', /ExitPlanMode/);
});

test('prompt: outside a room only the report is written; an @room there is refused (at-room\'s stop)', () => {
  const w = new World({}, { room: false });
  const r = w.hook('prompt', ev({ prompt: 'hello' }), { env: { CLAUDE_PID: undefined }, session: false });
  assert.deepEqual(r.json, { subHuman: { reviewOpen: false } });
  assert.equal(w.entries().length, 0);
  assert.equal(r.code, 0);
  const b = w.hook('prompt', ev({ prompt: '@room hi' }), { env: { CLAUDE_PID: undefined }, session: false });
  assert.equal(b.json!.decision, undefined);
  assert.equal(b.json!.continue, false);
  assert.match(b.json!.stopReason!, /isn't in a room/);
});

test('stage 8e I.4: a prompt at-room stops (an @room) runs no consent step: a review left by Esc on the view stays as it was for the next prompt, which says "exit plan mode first" to a model that reads it', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep' });
  const shim = { as: 'bob' };
  lease(w, 'bob');
  const shown: Review = { phase: 'shown', mode: 'plan', at: Date.now(), hash: 'abcdef012345' };
  w.lib(() => proposal.writeReview({ code: w.code, name: sn('bob') }, shown));
  const s = w.hook('prompt', ev({ prompt: '@room back in a minute', permission_mode: 'plan' }), shim);
  assert.equal(s.json!.continue, false, s.stdout);
  assert.deepEqual(w.lib(() => proposal.readReview({ code: w.code, name: sn('bob') })), shown, 'the review did not move');
  const p = w.hook('prompt', ev({ prompt: 'ok, where were we', permission_mode: 'plan' }), shim);
  assert.match(ctx(p)!, /ExitPlanMode/);
});
