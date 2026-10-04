'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, fixture, plan, decision, reason, hso, roomPlan } = require('./helpers.js');

function exitPlan(w, text, { file = true, planArg } = {}) {
  const f = path.join(w.userHome, '.claude', 'plans', 'task-snug-rocket.md');
  if (file) fs.writeFileSync(f, text);
  const base = fixture('pre-exitplan');
  return { ...base, tool_input: { plan: planArg ?? text, ...(file ? { planFilePath: f } : {}) } };
}

// ---------- orchestrator ----------

test('orch: publishes plan_rev from the plan FILE bytes, then denies naming every missing approver', () => {
  const w = new World({ orch: 'act', alice: 'sleep', bob: 'sleep' });
  const text = roomPlan(w.code, ['alice', 'bob']);
  const input = exitPlan(w, text, { planArg: 'stale model text' });
  const r = w.hook('plan-gate', input, { as: 'orch' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(decision(r), 'deny');
  const h = plan.hash12(text);
  assert.ok(reason(r).startsWith(`ROOM-GATE: plan ${h} lacks sign-off from alice and bob. Ask them by name; stay in plan mode.`), reason(r));
  assert.match(reason(r), /Published as plan_rev #1/);
  const es = w.entries();
  assert.deepEqual([es[0].kind, es[0].via, es[0].plan_hash, es[0].approvers], ['plan_rev', 'system', h, ['alice', 'bob']]);
  assert.equal(w.lib(() => plan.canonical(w.code, h)).toString('utf8'), text, 'stored bytes equal the plan file');
  assert.deepEqual([es[1].kind, es[1].via, es[1].text], ['status', 'system', `plan ${h} is waiting for sign-off from alice and bob`]);

  // same hash again: no new plan_rev, no repeated notice
  const r2 = w.hook('plan-gate', input, { as: 'orch' });
  assert.equal(decision(r2), 'deny');
  assert.doesNotMatch(reason(r2), /Published/);
  assert.equal(w.entries().length, 2);

  // alice signs: the deny names only bob, and a new notice is posted
  w.sign('alice', h);
  const r3 = w.hook('plan-gate', input, { as: 'orch' });
  assert.ok(reason(r3).startsWith(`ROOM-GATE: plan ${h} lacks sign-off from bob.`), reason(r3));
  assert.equal(w.entries().at(-1).text, `plan ${h} is waiting for sign-off from bob`);
});

test('orch: allows with updatedInput once every approver signed; an objection voids a sign-off', () => {
  const w = new World({ orch: 'act', alice: 'sleep', bob: 'sleep' });
  const text = roomPlan(w.code, ['alice', 'bob']);
  const input = exitPlan(w, text);
  w.hook('plan-gate', input, { as: 'orch' });
  const h = plan.hash12(text);
  w.sign('alice', h); w.sign('bob', h);
  let r = w.hook('plan-gate', input, { as: 'orch' });
  assert.equal(decision(r), 'allow', r.stdout);
  assert.deepEqual(hso(r).updatedInput, input.tool_input);
  w.sign('bob', h, 'objection');
  r = w.hook('plan-gate', input, { as: 'orch' });
  assert.equal(decision(r), 'deny');
  assert.match(reason(r), /lacks sign-off from bob\./);
});

test('orch: a revised plan gets a new plan_rev and earlier sign-offs no longer count', () => {
  const w = new World({ orch: 'act', alice: 'sleep', bob: 'sleep' });
  const v1 = roomPlan(w.code, ['alice', 'bob']);
  w.hook('plan-gate', exitPlan(w, v1), { as: 'orch' });
  const h1 = plan.hash12(v1);
  w.sign('alice', h1); w.sign('bob', h1);
  const v2 = roomPlan(w.code, ['alice', 'bob'], '# Plan\n\n1. add pagination\n2. and tests\n');
  const r = w.hook('plan-gate', exitPlan(w, v2), { as: 'orch' });
  const h2 = plan.hash12(v2);
  assert.ok(reason(r).startsWith(`ROOM-GATE: plan ${h2} lacks sign-off from alice and bob.`), reason(r));
  assert.match(reason(r), new RegExp(`replaces ${h1}`));
});

test('orch: approvers must include every joined, not-left member; a departed member stays required', () => {
  const w = new World({ orch: 'act', alice: 'sleep', bob: 'sleep' });
  let r = w.hook('plan-gate', exitPlan(w, roomPlan(w.code, ['alice'])), { as: 'orch' });
  assert.equal(decision(r), 'deny');
  assert.match(reason(r), /approvers must include every joined member; add bob/);
  assert.equal(w.entries().length, 0, 'nothing published');

  // a plan that lists bob is published; bob then leaves: still required for that plan
  const text = roomPlan(w.code, ['alice', 'bob']);
  w.hook('plan-gate', exitPlan(w, text), { as: 'orch' });
  w.lib(() => require('./helpers.js').identity.leave(w.code, 'bob'));
  w.sign('alice', plan.hash12(text));
  r = w.hook('plan-gate', exitPlan(w, text), { as: 'orch' });
  assert.match(reason(r), /lacks sign-off from bob\./);
  // a new plan may exclude bob now
  const v2 = roomPlan(w.code, ['alice'], '# Plan v2\n');
  r = w.hook('plan-gate', exitPlan(w, v2), { as: 'orch' });
  assert.match(reason(r), /lacks sign-off from alice\./);
});

test('orch: bad or missing frontmatter is denied', () => {
  const w = new World({ orch: 'act', alice: 'sleep' });
  const cases = [
    ['# no frontmatter\n', /no sub-human frontmatter/],
    [roomPlan('otter-0001', ['alice']), /names room "otter-0001"/],
    [roomPlan(w.code, ['alice'], '# P\n', 'any'), /"approval":"all"/],
    [roomPlan(w.code, ['alice', 'zed']), /zed never joined/],
  ];
  for (const [text, re] of cases) {
    const r = w.hook('plan-gate', exitPlan(w, text), { as: 'orch' });
    assert.equal(decision(r), 'deny', text);
    assert.match(reason(r), re);
  }
  // no file: falls back to tool_input.plan
  const text = roomPlan(w.code, ['alice']);
  const r = w.hook('plan-gate', exitPlan(w, text, { file: false }), { as: 'orch' });
  assert.match(reason(r), new RegExp(`plan ${plan.hash12(text)} lacks sign-off from alice`));
});

test('orch: fails closed on an internal error', () => {
  const w = new World({ orch: 'act', alice: 'sleep' });
  // a corrupt log line is skipped by the lib; make the log a directory so reads throw
  fs.mkdirSync(path.join(w.home, 'rooms', w.code, 'log.jsonl'), { recursive: true });
  const r = w.hook('plan-gate', exitPlan(w, roomPlan(w.code, ['alice'])), { as: 'orch' });
  assert.equal(r.code, 0);
  assert.equal(decision(r), 'deny');
  assert.match(reason(r), /gate hook failed/);
});

test('not in a room: no opinion', () => {
  const w = new World({ orch: 'sleep' });
  const r = w.hook('plan-gate', exitPlan(w, roomPlan(w.code, [])));
  assert.equal(r.stdout, '');
});

// ---------- member ----------

test('member: stub -> plan file overwritten with canonical bytes, ask + updatedInput, pending_review recorded', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const canonical = roomPlan(w.code, ['alice'], '# CANONICAL PLAN\n\n- step one\n');
  const h = w.publish(canonical, ['alice']);
  const stub = w.lib(() => plan.stubFor(w.code, h));
  const input = exitPlan(w, stub);
  const r = w.hook('plan-gate', input, { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(decision(r), 'ask');
  assert.match(reason(r), new RegExp(`room ${w.code}'s plan ${h}`));
  assert.deepEqual(hso(r).updatedInput, { ...input.tool_input, plan: canonical });
  assert.equal(fs.readFileSync(input.tool_input.planFilePath, 'utf8'), canonical);
  const pending = JSON.parse(fs.readFileSync(path.join(w.memberDir('alice'), 'pending_review.json'), 'utf8'));
  assert.equal(pending.hash, h);
  assert.equal(pending.pid, process.pid);
  assert.equal(pending.tool_use_id, input.tool_use_id);
  assert.equal(w.entries().length, 1, 'the member gate logs nothing');
});

test('member: drifted file text still shows the canonical plan', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const canonical = roomPlan(w.code, ['alice'], '# CANONICAL\n');
  w.publish(canonical, ['alice']);
  const input = exitPlan(w, roomPlan(w.code, ['alice'], '# CANONICAL\n- sneaky extra line\n'));
  const r = w.hook('plan-gate', input, { as: 'alice' });
  assert.equal(decision(r), 'ask');
  assert.equal(fs.readFileSync(input.tool_input.planFilePath, 'utf8'), canonical);
});

test('member: a local plan without frontmatter passes through untouched', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  w.publish(roomPlan(w.code, ['alice']), ['alice']);
  const input = exitPlan(w, '# My own plan\n1. refactor\n');
  const r = w.hook('plan-gate', input, { as: 'alice' });
  assert.equal(r.stdout, '');
  assert.equal(fs.readFileSync(input.tool_input.planFilePath, 'utf8'), '# My own plan\n1. refactor\n');
  assert.equal(fs.existsSync(path.join(w.memberDir('alice'), 'pending_review.json')), false);
});

test('member: denied while showClearContextOnPlanAccept is on (user or project settings)', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const h = w.publish(roomPlan(w.code, ['alice']), ['alice']);
  const stub = w.lib(() => plan.stubFor(w.code, h));
  for (const f of [path.join(w.userHome, '.claude', 'settings.json'), path.join(w.cwd, '.claude', 'settings.local.json')]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ showClearContextOnPlanAccept: true }));
    const input = exitPlan(w, stub);
    const r = w.hook('plan-gate', input, { as: 'alice' });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /turn off clear-context-on-accept to review room plans/);
    assert.match(reason(r), /"showClearContextOnPlanAccept": false/);
    assert.equal(fs.readFileSync(input.tool_input.planFilePath, 'utf8'), stub, 'file not overwritten');
    fs.unlinkSync(f);
  }
});

test('member: nothing to review without a plan_rev', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const r = w.hook('plan-gate', exitPlan(w, `---\nsub-human: {"room":"${w.code}"}\n---\n`), { as: 'alice' });
  assert.equal(decision(r), 'deny');
  assert.match(reason(r), /nothing to review/);
});
