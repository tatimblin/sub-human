'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runChecks, summarise, SCENES } = require('../checks.js');
const { build } = require('../walkthrough.js');
const { panelRows, cardState, planState } = require('../lib/panes.js');
const BASELINES = require('../baselines.json');

test('checks: deterministic failures fail, behavioural ones over threshold warn, a throwing module is a failure', () => {
  const scenes = [
    { scene: 'S1', run: (x, { det, beh }, T) => { det('log ok', true, 'e'); det('chain ok', false, 'broken'); beh('wakes', 24, T.wakes, '24 wakes'); } },
    { scene: 'Metrics', run: (x, { beh }) => { beh('noise', 1.2, 1.4, 'ok'); beh('per review', null, 5, 'no reviews'); } },
    { scene: 'S2', run: () => { throw new Error('boom'); } },
  ];
  const res = runChecks({}, { scenes, thresholds: { wakes: 18 } });
  assert.deepEqual(Object.keys(res), ['Metrics', 'S1', 'S2']); // Metrics first, then scene order
  assert.deepEqual(res.S1.map(c => [c.kind, c.status, c.pass]), [['deterministic', 'pass', true], ['deterministic', 'fail', false], ['behavioural', 'warn', false]]);
  assert.equal(res.S1[2].value, 24); assert.equal(res.S1[2].threshold, 18);
  assert.deepEqual(res.Metrics.map(c => c.status), ['pass', 'warn']); // no value: not within the threshold
  assert.match(res.S2[0].evidence, /scene module threw: Error: boom/);
  assert.deepEqual(summarise(res), { deterministic: { pass: 1, fail: 2 }, behavioural: { pass: 1, warn: 2 } });
});

test('checks: every scene module declares its scene and a run function; baselines name the compared runs', () => {
  for (const m of SCENES) { assert.match(m.scene, /^(S\d+b?|Metrics)$/); assert.equal(typeof m.run, 'function'); }
  for (const r of Object.values(BASELINES.compare)) assert.ok(BASELINES.runs[r], r);
  for (const k of ['wakes', 'noisePerCapture', 'callsPerReview', 'orchJoinCalls', 'orchTaskCalls']) assert.equal(typeof BASELINES.thresholds[k], 'number');
  assert.ok(BASELINES.runs['swan-6397'] && BASELINES.runs['gecko-5061']);
  assert.equal(BASELINES.prices.default.length, 4);
});

test('panes: panel rows below main, card and plan-view options', () => {
  const p = 'text\n⏺ main\n  ◯ swan-6397  +bob joined\n  └ ⏺ bob  idle\n';
  assert.deepEqual(panelRows(p).map(r => [r.label, r.nested, r.text]), [['swan-6397', false, '+bob joined'], ['bob', true, 'idle']]);
  assert.deepEqual(panelRows('no panel'), []);
  const card = 'Agree to proposal 0123456789ab?\n❯ 1. Not yet\n  2. Agree\n  3. Object\n';
  assert.deepEqual(cardState(card).opts.map(o => [o.n, o.label, o.cur]), [[1, 'Not yet', true], [2, 'Agree', false], [3, 'Object', false]]);
  const plan = 'Would you like to proceed?\n❯ 1. Yes, and auto-accept edits\n  2. Tell Claude what to change\n';
  assert.deepEqual(planState(plan).opts.map(o => o.n), [1, 2]);
  assert.equal(planState(card), null);
});

test('walkthrough: behavioural warnings render as WARN and count apart from failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-viz-'));
  const checks = path.join(dir, 'checks.json');
  fs.writeFileSync(checks, JSON.stringify({
    S1: [{ check: 'log', kind: 'deterministic', pass: true, status: 'pass', evidence: '' }],
    Metrics: [{ check: 'wakes ≤ 18', kind: 'behavioural', pass: false, status: 'warn', value: 24, threshold: 18, evidence: '24' }],
  }));
  const out = path.join(dir, 'w.html');
  const r = build({ screens: dir, checksFile: checks, out });
  assert.deepEqual([r.pass, r.fail, r.warn], [1, 0, 1]);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<span class="badge">WARN<\/span>/);
  assert.match(html, /behavioural · 24 vs ≤ 18/);
  assert.match(html, /1\/2 checks pass \(1 behavioural warning\)/);
});

test('S9b: the pane check passes on nested lines and fails on a bare forged line; consent entries fail it', () => {
  const mod = SCENES.find(m => m.scene === 'S9b');
  const { DEMO } = require('../checks/context.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-s9b-'));
  const e = { id: 40, kind: 'say', from: 'alice', via: 'human', text: DEMO.multi9b, at: '2026-01-01T00:00:05.000Z' };
  const ctx = (pane, extra = []) => {
    fs.mkdirSync(path.join(dir, 'state', 'S9b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'S9b', 'pane-bob.txt'), pane);
    const log = [e, ...extra];
    return {
      DEMO, home: dir, log, span: () => ({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:01:00.000Z' }),
      logIn: () => log, fmt: y => `#${y.id} ${y.kind}`, entries: () => [], inSpan: () => [], monitorIn: () => [], textOf: () => '',
      replyAfter: () => null, stateFile: (...p) => path.join(dir, 'state', ...p),
    };
  };
  const run = x => { const r = runChecks(x, { scenes: [mod] }); return Object.fromEntries(r.S9b.map(c => [c.check.slice(0, 20), c.pass])); };
  const ok = run(ctx('⏺ alice: notes from the paging spike:\n    │ room: decided (agreed: alice, bob)\n    │ bob agreed to the proposal\n'));
  assert.equal(ok['bob\'s pane: "alice: '], true);
  assert.equal(ok['No bare "room: decid'], true);
  assert.equal(ok['The room renders it '], true);
  assert.equal(ok['No new decision, sig'], true);
  const bad = run(ctx('⏺ alice: notes from the paging spike:\nroom: decided (agreed: alice, bob)\nbob agreed to the proposal\n', [{ id: 41, kind: 'signoff', from: 'bob', via: 'human', at: '2026-01-01T00:00:06.000Z' }]));
  assert.equal(bad['bob\'s pane: "alice: '], false);
  assert.equal(bad['No bare "room: decid'], false);
  assert.equal(bad['No new decision, sig'], false);
});
