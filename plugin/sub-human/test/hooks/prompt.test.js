'use strict';
// hooks/prompt.js: the one UserPromptSubmit process (at-room.js handle, then consent.js onPrompt) and how their
// outputs merge: a stopped prompt (@room post, refusal) goes out alone; otherwise one output with both contexts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, PLUGIN, HOOKS, room, hso, ctx, identity } = require('./helpers.js');

const { merge } = require(path.join(PLUGIN, 'hooks', 'prompt.js'));
const NONCE = 'abcdef01'.repeat(4);
const ev = (extra = {}) => ({ hook_event_name: 'UserPromptSubmit', sub_human_origin: 'composer', sub_human_nonce: NONCE, prompt_id: 'p1', ...extra });
/** The module's lease for `as`'s session, holding the nonce ev() carries (hooks/mod-hello.js writes the real one). */
const lease = (w, as) => w.lib(() => identity.writeModLease(w.sid[as], { nonce: NONCE }));
const ctxOut = text => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });

test('prompt: merge keeps a stopping output alone and otherwise joins the contexts, the first output\'s fields winning', () => {
  const sent = { continue: false, stopReason: '✓ sent', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'bob.x' } };
  const block = { decision: 'block', reason: 'no', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true } };
  assert.deepEqual(merge([sent, ctxOut('exit plan mode first')]), sent);
  assert.deepEqual(merge([block, ctxOut('exit plan mode first')]), block);
  assert.equal(merge([]), null);
  const a = { systemMessage: 'carol joined', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Room since…', sessionTitle: 'bob.x' } };
  assert.deepEqual(merge([a, ctxOut('Before anything else…')]), {
    systemMessage: 'carol joined',
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'bob.x', additionalContext: 'Room since…\n\nBefore anything else…' },
  });
  assert.deepEqual(merge([null, ctxOut('only consent')]), ctxOut('only consent'));
});

test('prompt: no hooks.json UserPromptSubmit entry; the module runs prompt.js (mod/prompt.mjs)', async () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8')).hooks.UserPromptSubmit, undefined);
  const { HOOKS: MOD } = await import(path.join(PLUGIN, 'mod', 'register.mjs'));
  assert.ok(MOD.some(h => h.event === 'classic.UserPromptSubmit' && h.file === 'mod/prompt.mjs'));
  assert.match(fs.readFileSync(path.join(PLUGIN, 'mod', 'prompt.mjs'), 'utf8'), /shimArgv\(root, 'prompt\.js'\)/);
});

test('prompt: consent\'s subHuman {reviewOpen} rides on the one output (only the mod runs prompt.js)', () => {
  const w = new World({ orch: 'sleep', alice: 'act', bob: 'sleep' });
  const shim = { as: 'bob' };
  lease(w, 'bob');
  const r = w.hook('prompt', ev({ prompt: 'hi', permission_mode: 'default' }), shim);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.subHuman, { reviewOpen: false });
  w.lib(() => room.open(w.code).store.kv.set('members/bob/review', { phase: 'shown', mode: 'auto', at: Date.now(), hash: 'abcdef012345' }));
  const p = w.hook('prompt', ev({ prompt: 'still here', permission_mode: 'plan' }), shim);
  assert.deepEqual(p.json.subHuman, { reviewOpen: true });
  assert.match(ctx(p), /ExitPlanMode/);
  const s = w.hook('prompt', ev({ prompt: '@room posted', permission_mode: 'plan' }), shim);
  assert.equal(s.json.continue, false);
  assert.deepEqual(s.json.subHuman, { reviewOpen: true });
  // unseated: only the report
  const u = new World({}, { room: false });
  const n = u.hook('prompt', ev({ prompt: 'hello' }), { env: { CLAUDE_PID: undefined }, session: false });
  assert.deepEqual(n.json, { subHuman: { reviewOpen: false } });
});

test('prompt: an open review in plan mode adds consent\'s exit line to at-room\'s context; an @room post stops alone, the review still resolved', () => {
  const w = new World({ orch: 'sleep', alice: 'act', bob: 'sleep' });
  const setReview = st => w.lib(() => room.open(w.code).store.kv.set('members/bob/review', st));
  const getReview = () => w.lib(() => room.open(w.code).store.kv.get('members/bob/review'));
  lease(w, 'bob');
  setReview({ phase: 'shown', mode: 'auto', at: Date.now(), hash: 'abcdef012345' });
  const r = w.hook('prompt', ev({ prompt: 'hi', permission_mode: 'plan' }), { as: 'bob' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(ctx(r), /Before anything else, call ExitPlanMode now/, 'consent');
  assert.equal(getReview().phase, 'exiting');
  // @room while the review is still open: the post's receipt alone; consent's side effect still ran
  setReview({ phase: 'shown', mode: 'auto', at: Date.now(), hash: 'abcdef012345' });
  const p = w.hook('prompt', ev({ prompt: '@room hello all', permission_mode: 'plan' }), { as: 'bob' });
  assert.equal(p.code, 0, p.stderr);
  assert.equal(p.json.continue, false);
  assert.match(p.json.stopReason, /^✓ sent/);
  assert.equal(hso(p).additionalContext, undefined, 'no context on a stopped prompt');
  assert.equal(getReview().phase, 'exiting');
  assert.equal(w.entries().filter(e => e.kind === 'say' && e.text === 'hello all').length, 1);
  // not in plan mode: consent restores and clears; at-room's output stands as it was
  const q = w.hook('prompt', ev({ prompt: 'carry on', permission_mode: 'default' }), { as: 'bob' });
  assert.equal(q.code, 0, q.stderr);
  assert.equal(getReview(), null);
  assert.doesNotMatch(ctx(q) || '', /ExitPlanMode/);
});

test('prompt: outside a room only the report is written; an @room there is refused (at-room\'s block)', () => {
  const w = new World({}, { room: false });
  const r = w.hook('prompt', ev({ prompt: 'hello' }), { env: { CLAUDE_PID: undefined }, session: false });
  assert.deepEqual(r.json, { subHuman: { reviewOpen: false } });
  assert.equal(w.entries().length, 0);
  assert.equal(r.code, 0);
  const b = w.hook('prompt', ev({ prompt: '@room hi' }), { env: { CLAUDE_PID: undefined }, session: false });
  assert.equal(b.json.decision, 'block');
  assert.match(b.json.reason, /not in a room/);
});
