'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, fixture, plan, room, ctx, hso, roomPlan } = require('./helpers.js');

const postExit = (planText, extra = {}, mode = 'default') => {
  const b = fixture('post-exitplan');
  return { ...b, permission_mode: mode, tool_response: { ...b.tool_response, plan: planText, ...extra } };
};
const pendingFile = (w, name) => path.join(w.memberDir(name), 'pending_review.json');
function pend(w, name, hash) {
  fs.mkdirSync(w.memberDir(name), { recursive: true });
  fs.writeFileSync(pendingFile(w, name), JSON.stringify({ hash, pid: w.pid[name], tool_use_id: 'toolu_01WLVs4qSF2Sv9jXW5MyoDoo' }));
}
function member() {
  const w = new World({ orch: 'sleep', alice: 'act', bob: 'sleep' });
  const canonical = roomPlan(w.code, ['alice', 'bob'], '# CANONICAL PLAN\n\n- step one\n- step two\n');
  const h = w.publish(canonical, ['alice', 'bob']);
  pend(w, 'alice', h);
  return { w, canonical, h };
}

test('member: unedited approval of the canonical plan logs a via=human signoff and says do not implement', () => {
  const { w, canonical, h } = member();
  const r = w.hook('plan-result', postExit(canonical), { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  const e = w.entries().at(-1);
  assert.deepEqual([e.kind, e.from, e.via, e.plan_hash], ['signoff', 'alice', 'human', h]);
  assert.equal(hso(r).hookEventName, 'PostToolUse');
  assert.equal(ctx(r), `Recorded alice's sign-off on room plan ${h} (#${e.id}). Do NOT implement this plan; wait for an assignment from the room.`);
  assert.equal(fs.existsSync(pendingFile(w, 'alice')), false, 'pending_review cleared');
  assert.deepEqual(w.lib(() => room.signoffMatrix(h)).missing, ['bob']);
});

test('member: planWasEdited -> objection with the stored edit and a summary; the sign-off is not counted', () => {
  const { w, canonical, h } = member();
  const edited = canonical + '\n- EDITED BY BOB: add step three\n';
  const r = w.hook('plan-result', postExit(edited, { planWasEdited: true }), { as: 'alice' });
  const e = w.entries().at(-1);
  assert.deepEqual([e.kind, e.from, e.via, e.plan_hash], ['objection', 'alice', 'human', h]);
  assert.match(e.text, /EDITED BY BOB: add step three/);
  assert.ok(e.edit_path.startsWith(path.join(w.home, 'rooms', w.code, 'plans', 'edits', 'alice-')), e.edit_path);
  assert.equal(fs.readFileSync(e.edit_path, 'utf8'), edited);
  assert.match(ctx(r), new RegExp(`^Recorded alice's objection on room plan ${h} \\(#${e.id}\\).*Do NOT implement this plan; wait for an assignment from the room\\.$`));
  assert.deepEqual(w.lib(() => room.signoffMatrix(h)).missing, ['alice', 'bob']);
});

test('member: a hash mismatch without planWasEdited is also an objection', () => {
  const { w, h } = member();
  w.hook('plan-result', postExit('something else entirely\n'), { as: 'alice' });
  const e = w.entries().at(-1);
  assert.deepEqual([e.kind, e.plan_hash], ['objection', h]);
});

test('member: planWasEdited:true with identical bytes still counts as an objection', () => {
  const { w, canonical } = member();
  w.hook('plan-result', postExit(canonical, { planWasEdited: true }), { as: 'alice' });
  assert.equal(w.entries().at(-1).kind, 'objection');
});

test('member: dontAsk never signs off', () => {
  const { w, canonical, h } = member();
  const r = w.hook('plan-result', postExit(canonical, {}, 'dontAsk'), { as: 'alice' });
  const es = w.entries();
  assert.equal(es.filter(e => e.kind === 'signoff').length, 0);
  const s = es.at(-1);
  assert.equal(s.kind, 'status');
  assert.match(s.text, /dontAsk mode/);
  assert.match(ctx(r), /REFUSED alice's sign-off/);
  assert.match(ctx(r), /Do NOT implement this plan/);
  assert.deepEqual(w.lib(() => room.signoffMatrix(h)).missing, ['alice', 'bob']);
});

test('member: manual modes sign off with no mode warning and no extra status', () => {
  for (const mode of ['default', 'plan']) {
    const { w, canonical, h } = member();
    const r = w.hook('plan-result', postExit(canonical, {}, mode), { as: 'alice' });
    const es = w.entries();
    const e = es.at(-1);
    assert.deepEqual([e.kind, e.via, e.plan_hash], ['signoff', 'human', h], mode);
    assert.equal(es.filter(x => x.kind === 'status').length, 0, mode);
    assert.equal(ctx(r), `Recorded alice's sign-off on room plan ${h} (#${e.id}). Do NOT implement this plan; wait for an assignment from the room.`);
  }
});

test('member: auto / acceptEdits / bypassPermissions still sign off, log a status and tell the Claude not to act', () => {
  for (const mode of ['auto', 'acceptEdits', 'bypassPermissions']) {
    const { w, canonical, h } = member();
    const r = w.hook('plan-result', postExit(canonical, {}, mode), { as: 'alice' });
    assert.equal(r.code, 0, r.stderr);
    const es = w.entries();
    const so = es.find(e => e.kind === 'signoff');
    assert.deepEqual([so.from, so.via, so.plan_hash], ['alice', 'human', h], mode);
    assert.deepEqual(w.lib(() => room.signoffMatrix(h)).missing, ['bob'], mode);
    const st = es.at(-1);
    assert.deepEqual([st.kind, st.via, st.from, st.to, st.plan_hash, st.refs], ['status', 'system', 'alice', 'alice', h, [so.id]], mode);
    assert.equal(st.text, `alice approved with ${mode} mode on; their Claude was told not to act`);
    const c = ctx(r);
    assert.ok(c.startsWith(`Recorded alice's sign-off on room plan ${h} (#${so.id}). Do NOT implement this plan`), c);
    assert.match(c, new RegExp(`You are now in ${mode} mode\\. Do NOT implement the room plan or edit files for it`));
    assert.match(c, /Tell alice in one line: press Shift\+Tab to return to manual mode if they didn't mean to switch\./);
  }
});

test('member: an unknown or missing mode signs off with the strongest do-not-act wording', () => {
  for (const mode of [undefined, 'somethingNew']) {
    const { w, canonical, h } = member();
    const input = postExit(canonical, {}, mode);
    if (mode === undefined) delete input.permission_mode;
    const r = w.hook('plan-result', input, { as: 'alice' });
    const es = w.entries();
    assert.equal(es.at(-1).kind, 'signoff', String(mode));
    assert.equal(es.filter(x => x.kind === 'status').length, 0);
    const c = ctx(r);
    assert.match(c, /mode is unknown here/);
    assert.match(c, /Whatever your mode, do NOT implement the room plan, edit files, or run commands for it/);
    assert.match(c, /Shift\+Tab/);
    assert.deepEqual(w.lib(() => room.signoffMatrix(h)).missing, ['bob']);
  }
});

test('member: an edited approval in auto mode is an objection and still carries the mode warning', () => {
  const { w, canonical } = member();
  const r = w.hook('plan-result', postExit(canonical + '\n- extra\n', { planWasEdited: true }, 'auto'), { as: 'alice' });
  assert.equal(w.entries().at(-1).kind, 'objection');
  assert.match(ctx(r), /You are now in auto mode\./);
});

test('member: no pending_review (a local plan) -> no opinion, nothing logged', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const r = w.hook('plan-result', postExit('# my plan\n'), { as: 'alice' });
  assert.equal(r.stdout, '');
  assert.equal(w.entries().length, 0);
});

test('orch: decision once per hash with refs to the sign-offs; otherwise a status', () => {
  const w = new World({ orch: 'act', alice: 'sleep', bob: 'sleep' });
  const text = roomPlan(w.code, ['alice', 'bob']);
  const h = w.publish(text, ['alice', 'bob']);
  // not yet signed: status
  w.hook('plan-result', postExit(text), { as: 'orch' });
  let e = w.entries().at(-1);
  assert.equal(e.kind, 'status');
  assert.match(e.text, /lacks sign-off from alice and bob/);

  const a = w.sign('alice', h), b = w.sign('bob', h);
  let r = w.hook('plan-result', postExit(text), { as: 'orch' });
  e = w.entries().at(-1);
  assert.deepEqual([e.kind, e.via, e.plan_hash, e.refs], ['decision', 'system', h, [a.id, b.id]]);
  // The hook hands over the next step directly; the orch must not wait for its own decision notice.
  const ctx = (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
  assert.match(ctx, new RegExp(`Decision #${e.id} .*Post the assignments`));
  const n = w.entries().length;
  r = w.hook('plan-result', postExit(text), { as: 'orch' });
  assert.equal(w.entries().length, n, 'at most one decision per hash');
  assert.match(r.json.hookSpecificOutput.additionalContext, new RegExp(`Decision #${e.id} `), 'a repeat exit still names the existing decision');
  assert.ok(w.lib(() => room.decided(h)));

  w.hook('plan-result', postExit('# other\n'), { as: 'orch' });
  assert.match(w.entries().at(-1).text, /does not match the current plan_rev/);
});
