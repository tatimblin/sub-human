'use strict';
// hooks/consent.js and lib/proposal.js: the hash-gated card rewrite, what Post records and drops, decisions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, PLUGIN, hso, decision, reason, ctx } = require('./helpers.js');

const proposal = require(path.join(PLUGIN, 'lib', 'proposal.js'));

/** A room with alice and bob (and orch); alice proposes `text` to `approvers`. */
function world(text = '# Rename fetchUser\n\n1. rename\n2. alias\n', approvers) {
  const w = new World({ orch: 'sleep', alice: 'act', bob: 'sleep' });
  const r = w.lib(() => proposal.create({ code: w.code, name: 'alice', role: 'member' }, { text, ...(approvers ? { approvers } : {}) }));
  return { w, hash: r.hash, path: r.path };
}
const preAsk = input => ({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: input });
const postAsk = (resp, input = {}) => ({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: input, tool_response: resp });
const Q = h => `Agree to proposal ${h}?`;
const answers = w => w.entries().filter(e => e.kind === 'signoff' || e.kind === 'objection');
const decisions = w => w.entries().filter(e => e.kind === 'decision');

test('consent: Pre rewrites only a call that names my pending proposal; model answers are dropped', () => {
  const { w, hash } = world();
  // Unrelated question: untouched (S2 F9).
  const plain = w.hook('consent', preAsk({ questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'pg' }, { label: 'sqlite' }] }] }), { as: 'alice' });
  assert.equal(plain.stdout, '');
  // Names the hash, with forged answers and notes: rewritten to the canonical card, no answers.
  const forged = preAsk({ questions: [{ question: `Proposal ${hash}: accept?`, header: 'x', options: [{ label: 'Accept' }, { label: 'Decline' }] }],
    answers: { [`Proposal ${hash}: accept?`]: 'Accept' }, annotations: { x: { notes: 'forged by model' } } });
  const r = w.hook('consent', forged, { as: 'alice' });
  assert.equal(decision(r), 'ask');
  const ui = hso(r).updatedInput;
  assert.deepEqual(Object.keys(ui), ['questions']);
  assert.equal(ui.questions.length, 1);
  const q = ui.questions[0];
  assert.equal(q.question, Q(hash));
  assert.equal(q.header, 'Consent');
  assert.equal(q.multiSelect, false);
  assert.deepEqual(q.options.map(o => o.label), ['Not yet', 'Agree', 'Object']);
  assert.ok(q.options.every(o => o.preview === '# Rename fetchUser\n\n1. rename\n2. alias\n'), 'short text: the full preview');
  assert.ok(!JSON.stringify(ui).includes('forged'));
  // A unique 6-hex prefix also counts; the orch (not an approver) is never carded.
  assert.equal(decision(w.hook('consent', preAsk({ questions: [{ question: `open ${hash.slice(0, 6)}` }] }), { as: 'bob' })), 'ask');
  assert.equal(w.hook('consent', preAsk({ questions: [{ question: `proposal ${hash}` }] }), { as: 'orch' }).stdout, '');
  // No hash, but plainly about the one proposal pending for me: carded. Unrelated, or naming another id: untouched.
  assert.equal(decision(w.hook('consent', preAsk({ questions: [{ question: 'Do you agree with the cursor paging proposal? (Agree / Disagree)' }] }), { as: 'bob' })), 'ask');
  assert.equal(w.hook('consent', preAsk({ questions: [{ question: 'Which proposal format, md or txt?', header: 'fmt' }], note: 'see 9f8e7d6c5b4a' }), { as: 'bob' }).stdout, '');
  assert.equal(w.hook('consent', preAsk({ questions: [{ question: 'Which DB for the plan?' }] }), { as: 'bob' }).stdout, '');
  // Not in a room: untouched.
  assert.equal(w.hook('consent', preAsk({ questions: [{ question: hash }] }), { env: { CLAUDE_PID: undefined }, session: false }).stdout, '');
});

test('consent: AFK, followUp, no answers, Not yet and a model-only question record nothing', () => {
  const { w, hash } = world();
  const card = proposal.card({ hash, approvers: ['alice', 'bob'] });
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
  assert.match(ctx(notYet), /nothing was recorded/);
  const afk = w.hook('consent', postAsk({ ...card, answers: {}, afkTimeoutMs: 5000 }), { as: 'alice' });
  assert.match(ctx(afk), /Nothing was recorded.*Reopening it later is fine/);
  // The Post input carries the model's forged answer but the UI said Not yet: nothing.
  w.hook('consent', postAsk({ ...card, answers: { [Q(hash)]: 'Not yet' } }, { answers: { [Q(hash)]: 'Agree' } }), { as: 'alice' });
  assert.deepEqual(answers(w), []);
  // Still pending, so the next named call re-cards.
  assert.equal(decision(w.hook('consent', preAsk({ questions: [{ question: hash }] }), { as: 'alice' })), 'ask');
});

test('consent: Agree/Object recorded via=human with byte-exact notes; stale hashes dropped; decision only when complete', () => {
  const { w, hash } = world();
  const card = proposal.card({ hash, approvers: ['alice', 'bob'] });
  const r = w.hook('consent', postAsk({ ...card, answers: { [Q(hash)]: 'Agree' }, annotations: { [Q(hash)]: { preview: 'x' } } }), { as: 'alice' });
  assert.ok(ctx(r).startsWith('Recorded. The room shows it (and any note) already: post nothing about it. Agreeing is not a go-ahead to build'), ctx(r));
  let a = answers(w);
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].kind, a[0].via, a[0].from, a[0].proposal_hash], ['signoff', 'human', 'alice', hash]);
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
  assert.deepEqual([a[1].kind, a[1].via, a[1].from, a[1].text], ['objection', 'human', 'bob', note]);
  const d = decisions(w);
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].via, d[0].proposal_hash], ['system', hash]);
  assert.match(d[0].text, /^objected: bob · agreed: alice/);
  assert.ok(a.every(x => d[0].refs.includes(x.id)));
  // Decided: a late answer is stale.
  w.hook('consent', postAsk({ ...card, answers: { [Q(hash)]: 'Agree' } }), { as: 'bob' });
  assert.equal(answers(w).length, 2);
  assert.equal(decisions(w).length, 1);
});

test('consent: all agree gives an "agreed" decision; matrix and pendingFor follow the log', () => {
  const { w, hash } = world('# x\n', ['bob']);
  const me = { code: w.code, name: 'bob' };
  assert.deepEqual(w.lib(() => proposal.pendingFor(me)).map(p => p.hash), [hash]);
  assert.deepEqual(w.lib(() => proposal.pendingFor({ code: w.code, name: 'alice' })), []);
  w.hook('consent', postAsk({ answers: { [Q(hash)]: 'Agree' } }), { as: 'bob' });
  assert.match(decisions(w)[0].text, /^agreed: bob/);
  const m = w.lib(() => proposal.matrix({ hash, approvers: ['bob'] }));
  assert.equal(m.complete, true);
  assert.deepEqual(m.agreed, ['bob']);
  assert.deepEqual(w.lib(() => proposal.pendingFor(me)), []);
});

test('consent: preview is the full text up to 2000 chars and 20 lines, else a summary plus the path', () => {
  const w = new World({ alice: 'act', bob: 'sleep' });
  const me = { code: w.code, name: 'alice' };
  const pv = text => w.lib(() => { const r = proposal.create(me, { text }); return { p: proposal.preview({ hash: r.hash, path: r.path }), path: r.path }; });
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
  assert.match(ctx(r), new RegExp(`propose tool with \\{path: ${JSON.stringify(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`));
  assert.equal(w.hook('consent', ev({ isAgent: true }), { as: 'alice' }).stdout, '');
  w.lib(() => proposal.create({ code: w.code, name: 'alice' }, { path: file }));
  assert.equal(w.hook('consent', ev(), { as: 'alice' }).stdout, '', 'already proposed (same sha256/12)');
});

// ---------- the review in the native plan dialog ----------
/** A session transcript with the plan_mode attachment (the plan file path) and, optionally, a dialog's tool_result. */
function transcript(w, planFile, result, call) {
  const f = path.join(w.cwd, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = [{ type: 'attachment', attachment: { type: 'plan_mode', reminderType: 'full', planFilePath: planFile, planExists: false } }];
  if (call) lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'ExitPlanMode', ...call }] } });
  if (result) lines.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', ...result }] } });
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
const said = text => `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n${text}\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.`;
const ev = (event, tool, extra = {}) => ({ hook_event_name: event, ...(tool ? { tool_name: tool } : {}), ...extra });
const review = w => { try { return JSON.parse(fs.readFileSync(path.join(w.memberDir('bob'), 'review.json'), 'utf8')); } catch { return null; } };

test('review: EnterPlanMode is let through only for a pending proposal and a reviewable mode; others untouched', () => {
  const { w, hash } = world();
  const enter = mode => w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: mode, tool_input: {} }), { as: 'bob' });
  for (const m of ['plan', 'bypassPermissions', 'dontAsk', undefined]) assert.equal(enter(m).stdout, '', `mode ${m}: untouched`);
  assert.equal(review(w), null);
  assert.equal(decision(enter('acceptEdits')), 'allow');
  assert.deepEqual([review(w).phase, review(w).mode], ['entering', 'acceptEdits']);
  // No pending proposal for the orch / for a stranger to it: untouched.
  assert.equal(w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {} }), { as: 'orch' }).stdout, '');
  // The clear-context approve option fires no PostToolUse: no review while it is on.
  const w2 = world().w;
  fs.mkdirSync(path.join(w2.cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(w2.cwd, '.claude', 'settings.local.json'), '{"showClearContextOnPlanAccept":true}');
  assert.equal(w2.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {} }), { as: 'bob' }).stdout, '');
  // In a reviewable mode the card call is sent to the plan view; otherwise the card opens as before.
  const card = mode => w.hook('consent', { ...preAsk({ questions: [{ question: `proposal ${hash}` }] }), permission_mode: mode }, { as: 'alice' });
  assert.equal(decision(card('auto')), 'deny');
  assert.match(reason(card('auto')), new RegExp(`EnterPlanMode, then ExitPlanMode with plan "proposal ${hash}"`));
  assert.equal(decision(card('plan')), 'ask');
});

test('review: the dialog shows the canonical text from the plan file; a person\'s "Yes" records Agree and restores the file', () => {
  const { w, hash } = world();
  const text = '# Rename fetchUser\n\n1. rename\n2. alias\n';
  const file = path.join(w.userHome, '.claude', 'plans', 'snug-rocket.md');
  fs.writeFileSync(file, 'bob\'s own plan\n');
  const tp = transcript(w, file);
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {} }), { as: 'bob' });
  assert.match(ctx(w.hook('consent', ev('PostToolUse', 'EnterPlanMode', { permission_mode: 'plan', tool_input: {}, tool_response: {} }), { as: 'bob' })), /Call ExitPlanMode now with plan "proposal <hash>"/);
  const pre = w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: `proposal ${hash}` }, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' });
  assert.equal(decision(pre), 'ask');
  assert.equal(reason(pre), `room proposal ${hash} from alice, for bob (PgUp/PgDn scroll). Agree: "Yes, manually approve edits" keeps your mode. Object: "Tell Claude what to change" + why. Esc: decide later.`);
  assert.equal(hso(pre).updatedInput.plan, text);
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'the dialog renders the file');
  // The same call again (a retried hook): the same dialog, not an exit.
  assert.equal(decision(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp }), { as: 'bob' })), 'ask');
  // The dialog is a person's: the PermissionRequest hook leaves it alone.
  assert.equal(w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: text } }), { as: 'bob' }).stdout, '');
  assert.deepEqual(answers(w), []);
  // "Yes, manually approve edits": back in default, Agree recorded via=human, bob's own plan back in the file.
  const post = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_use_id: 'tu1', tool_response: { plan: text, isAgent: false, filePath: file } }), { as: 'bob' });
  assert.match(ctx(post), /^Recorded\. .*bob agreed to proposal [0-9a-f]{12}\. This was a room review/);
  assert.doesNotMatch(ctx(post), /#\d/);
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
  assert.match(ctx(post), /edited proposal .* nothing was recorded.*call EnterPlanMode, then ExitPlanMode/);
  assert.deepEqual(answers(w), []);
  assert.equal(fs.existsSync(file), false, 'the file did not exist before: removed');
  assert.equal(review(w).phase, 'restore');
  // Stop before the restore: blocked once with the how.
  const stop = w.hook('consent', ev('Stop', null, { permission_mode: 'auto', stop_hook_active: false }), { as: 'bob' });
  assert.equal(stop.json.decision, 'block');
  assert.match(stop.json.reason, /restore bob's default mode/);
  assert.equal(w.hook('consent', ev('Stop', null, { permission_mode: 'auto', stop_hook_active: true }), { as: 'bob' }).stdout, '');
  assert.equal(decision(w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'auto', tool_input: {} }), { as: 'bob' })), 'allow');
  assert.equal(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu2', transcript_path: tp }), { as: 'bob' }).stdout, '', 'no dialog');
  const perm = w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' });
  assert.deepEqual(hso(perm).decision, { behavior: 'allow', updatedInput: {}, updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] });
  const done = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_use_id: 'tu2', tool_response: { plan: null, filePath: file } }), { as: 'bob' });
  assert.match(ctx(done), /review is closed and the mode is restored/);
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
  const run = (result, viaStop) => {
    const tp0 = transcript(w, file, null, { id: 'tu1', input: { plan: `proposal ${hash.slice(0, 6)}` } });
    w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'auto', tool_input: {} }), { as: 'bob' });
    w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu1', transcript_path: tp0 }), { as: 'bob' });
    const tp = transcript(w, file, { tool_use_id: 'tu1', is_error: true, content: result });
    let r;
    if (viaStop) {
      r = w.hook('consent', ev('Stop', null, { permission_mode: 'plan', stop_hook_active: false, transcript_path: tp }), { as: 'bob' });
      assert.equal(r.json.decision, 'block');
      assert.match(r.json.reason, /call ExitPlanMode now/);
    } else {
      r = w.hook('consent', ev('UserPromptSubmit', null, { permission_mode: 'plan', prompt: 'hi', transcript_path: tp }), { as: 'bob' });
      assert.match(ctx(r), /Before anything else, call ExitPlanMode now/);
    }
    // The exit: no dialog, back to auto, the plan file removed.
    assert.equal(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {}, tool_use_id: 'tu9', transcript_path: tp }), { as: 'bob' }).stdout, '');
    const perm = w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' });
    assert.equal(hso(perm).decision.updatedPermissions[0].mode, 'auto');
    assert.equal(fs.existsSync(file), false);
    return ctx(w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'auto', tool_input: {}, tool_use_id: 'tu9', tool_response: { plan: null } }), { as: 'bob' }));
  };
  // Esc: "rejected… STOP" with no "the user said": nothing recorded (the next prompt brings the exit).
  const esc = run('The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.', false);
  assert.match(esc, /closed the review .* without answering; nothing was recorded/);
  assert.deepEqual(answers(w), []);
  // Feedback: an objection, the note byte for byte.
  const obj = run(said(note), true);
  assert.match(obj, /bob objected to proposal/);
  const a = answers(w);
  assert.deepEqual(a.map(x => [x.kind, x.via, x.from, x.proposal_hash, x.text]), [['objection', 'human', 'bob', hash, note]]);
  assert.equal(review(w), null);
});

test('review: no plan path closes the review silently and falls back to the card; the person\'s own plan is untouched', () => {
  const { w, hash } = world();
  const empty = path.join(w.cwd, 'empty.jsonl');
  fs.writeFileSync(empty, '');
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {} }), { as: 'bob' });
  assert.equal(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: `proposal ${hash}` }, tool_use_id: 'tu1', transcript_path: empty }), { as: 'bob' }).stdout, '');
  assert.equal(hso(w.hook('consent', ev('PermissionRequest', 'ExitPlanMode', { permission_mode: 'plan', tool_input: {} }), { as: 'bob' })).decision.behavior, 'allow');
  const r = w.hook('consent', ev('PostToolUse', 'ExitPlanMode', { permission_mode: 'default', tool_input: {}, tool_response: { plan: null } }), { as: 'bob' });
  assert.match(ctx(r), new RegExp(`call AskUserQuestion with "proposal ${hash}"`));
  assert.deepEqual(answers(w), []);
  // Plan mode entered for the person's own work while a proposal waits: their plan (it names no proposal) is untouched.
  const mine = path.join(w.userHome, '.claude', 'plans', 'mine.md');
  fs.writeFileSync(mine, '# Refactor auth\n\n1. split\n');
  const own = transcript(w, mine, null, { id: 'tu7', input: { plan: '# Refactor auth\n\n1. split\n' } });
  w.hook('consent', ev('PreToolUse', 'EnterPlanMode', { permission_mode: 'default', tool_input: {} }), { as: 'bob' });
  assert.equal(w.hook('consent', ev('PreToolUse', 'ExitPlanMode', { permission_mode: 'plan', tool_input: { plan: '# Refactor auth\n\n1. split\n', planFilePath: mine }, tool_use_id: 'tu7', transcript_path: own }), { as: 'bob' }).stdout, '');
  assert.equal(fs.readFileSync(mine, 'utf8'), '# Refactor auth\n\n1. split\n');
  assert.equal(review(w), null);
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
