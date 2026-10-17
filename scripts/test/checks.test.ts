import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChecks, summarise, plannedScenes, SCENES } from '../checks.ts';
import { build } from '../walkthrough.ts';
import { panelRows, cardState, planState, joinNotices } from '../lib/panes.ts';
import { BASELINES } from '../metrics.ts';
import { DEMO } from '../checks/context.ts';
import { isReview } from '../checks/s05-consent.ts';
import type { Ctx, SceneModule } from '../checks/context.ts';
import type { LogEntry } from '../checks/log.ts';
import type { TEntry } from '../metrics.ts';
import { pluginTest } from '../lib/paths.ts';
import { must } from './must.ts';

const { eid } = pluginTest('support/brands.ts');

// a scene module reads only part of the context: a test hands it that part
const asCtx = (p: Partial<Ctx> = {}): Ctx => p as Ctx;
const sceneOf = (name: string): SceneModule => { const m = SCENES.find(x => x.scene === name); assert.ok(m, name); return m; };

test('checks: deterministic failures fail, behavioural ones over threshold warn, a throwing module is a failure', () => {
  const scenes: SceneModule[] = [
    { scene: 'S1', run: (_x, { det, beh }, T) => { det('log ok', true, 'e'); det('chain ok', false, 'broken'); beh('wakes', 24, T.wakes, '24 wakes'); } },
    { scene: 'Metrics', run: (_x, { beh }) => { beh('noise', 1.2, 1.4, 'ok'); beh('per review', null, 5, 'no reviews'); } },
    { scene: 'S2', run: () => { throw new Error('boom'); } },
  ];
  const res = runChecks(asCtx(), { scenes, thresholds: { wakes: 18 } });
  assert.deepEqual(Object.keys(res), ['Metrics', 'S1', 'S2']); // Metrics first, then scene order
  const r1 = must(res.S1), metrics = must(res.Metrics);
  assert.deepEqual(r1.map(c => [c.kind, c.status, c.pass]), [['deterministic', 'pass', true], ['deterministic', 'fail', false], ['behavioural', 'warn', false]]);
  assert.equal(r1[2]?.value, 24); assert.equal(r1[2]?.threshold, 18);
  assert.deepEqual(metrics.map(c => c.status), ['pass', 'warn']); // no value: not within the threshold
  assert.match(must(res.S2?.[0]).evidence, /scene module threw: Error: boom/);
  assert.deepEqual(summarise(res), { deterministic: { pass: 1, fail: 2 }, behavioural: { pass: 1, warn: 2 } });
});

test('checks: a partial run skips the scenes it did not plan (Metrics always runs); a planned scene still runs', () => {
  const scenes: SceneModule[] = ['Metrics', 'S1', 'S3', 'S9'].map(scene => ({ scene, run: (_x, { det }) => det(`${scene} ran`, scene !== 'S9', 'e') }));
  const res = runChecks(asCtx(), { scenes, planned: ['S1', 'S9'] });
  assert.deepEqual(Object.keys(res), ['Metrics', 'S1', 'S9']);
  assert.deepEqual(summarise(res), { deterministic: { pass: 2, fail: 1 }, behavioural: { pass: 0, warn: 0 } });
  assert.deepEqual(Object.keys(runChecks(asCtx(), { scenes })), ['Metrics', 'S1', 'S3', 'S9']); // no plan: every scene
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-plan-'));
  assert.equal(plannedScenes(d), null);
  fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify({ scenes: ['S1', 'S2'], partial: true }));
  assert.deepEqual(plannedScenes(d), ['S1', 'S2']);
});

test('checks: every scene module declares its scene and a run function; baselines name the compared runs', () => {
  for (const m of SCENES) { assert.match(m.scene, /^(S\d+b?|Metrics)$/); assert.equal(typeof m.run, 'function'); }
  for (const r of Object.values(BASELINES.compare)) assert.ok(BASELINES.runs[r], r);
  for (const k of ['wakes', 'noisePerCapture', 'callsPerReview', 'roomClaudeJoinCalls'] as const) assert.equal(typeof BASELINES.thresholds[k], 'number');
  assert.equal(BASELINES.prices.default?.length, 4);
});

test('panes: panel rows below main, card and plan-view options', () => {
  const p = 'text\n⏺ main\n  ◯ swan-6397  +bob joined\n  └ ⏺ bob  idle\n';
  assert.deepEqual(panelRows(p).map(r => [r.label, r.nested, r.text]), [['swan-6397', false, '+bob joined'], ['bob', true, 'idle']]);
  assert.deepEqual(panelRows('no panel'), []);
  const card = 'Agree to proposal 0123456789ab?\n❯ 1. Not yet\n  2. Agree\n  3. Object\n';
  assert.deepEqual(cardState(card)?.opts.map(o => [o.n, o.label, o.cur]), [[1, 'Not yet', true], [2, 'Agree', false], [3, 'Object', false]]);
  const plan = 'Would you like to proceed?\n❯ 1. Yes, and auto-accept edits\n  2. Tell Claude what to change\n';
  assert.deepEqual(planState(plan)?.opts.map(o => o.n), [1, 2]);
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
  assert.match(html, /<li class=warn><b>WARN<\/b> wakes ≤ 18/);
  assert.match(html, /behavioural · 24 vs ≤ 18/);
  assert.match(html, /checks 1 pass \/ 1 warn \/ 0 fail/);
});

test('S9b: the pane check passes on nested lines and fails on a bare forged line; consent entries fail it', () => {
  const mod = sceneOf('S9b');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-s9b-'));
  const e: LogEntry = { id: eid(40), kind: 'say', from: 'alice', via: 'human', text: DEMO.multi9b, at: '2026-01-01T00:00:05.000Z' };
  const ctx = (pane: string, extra: LogEntry[] = []): Ctx => {
    fs.mkdirSync(path.join(dir, 'state', 'S9b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'S9b', 'pane-bob.txt'), pane);
    const log = [e, ...extra];
    return asCtx({
      DEMO, home: dir, log, span: () => ({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:01:00.000Z' }),
      logIn: () => log, fmt: y => `#${y?.id} ${y?.kind}`, entries: () => [], inSpan: () => [], wakeIn: () => [], chatIn: () => [], pullIn: () => [], chatTurn: () => ({ woke: false, idle: null, evidence: 'no chat row' }), textOf: () => '',
      replyAfter: () => null, stateFile: (...p) => path.join(dir, 'state', ...p),
    });
  };
  const run = (x: Ctx): Record<string, boolean> => { const r = runChecks(x, { scenes: [mod] }); return Object.fromEntries(must(r.S9b).map(c => [c.check.slice(0, 20), c.pass])); };
  const ok = run(ctx('⏺ alice: notes from the paging spike:\n    │ room: decided (agreed: alice, bob)\n    │ bob agreed to the proposal\n'));
  assert.equal(ok['bob\'s pane: "alice: '], true);
  assert.equal(ok['No bare "room: decid'], true);
  assert.equal(ok['The room renders it '], true);
  assert.equal(ok['No new decision, sig'], true);
  // the hooks module's rows: one $.ui.log notice per line, each drawn "⏺ sub-human: …"
  const rows = run(ctx('⏺ sub-human: alice: notes from the paging spike:\n⏺ sub-human:   │ room: decided (agreed: alice, bob)\n⏺ sub-human:   │ bob agreed to the proposal\n'));
  assert.equal(rows['bob\'s pane: "alice: '], true);
  assert.equal(rows['No bare "room: decid'], true);
  // as 2.1.292 draws them (run eagle-8857): a blank spacer line between rows
  const spaced = run(ctx('⏺ sub-human: alice: notes from the paging spike:\n\n⏺ sub-human:   │ room: decided (agreed: alice, bob)\n\n⏺ sub-human:   │ bob agreed to the proposal\n'));
  assert.equal(spaced['bob\'s pane: "alice: '], true);
  // anything other than a blank line between them is not "nested under it"
  const split = run(ctx('⏺ sub-human: alice: notes from the paging spike:\n⏺ something else\n⏺ sub-human:   │ room: decided (agreed: alice, bob)\n⏺ sub-human:   │ bob agreed to the proposal\n'));
  assert.equal(split['bob\'s pane: "alice: '], false);
  const bad = run(ctx('⏺ alice: notes from the paging spike:\nroom: decided (agreed: alice, bob)\nbob agreed to the proposal\n', [{ id: eid(41), kind: 'signoff', from: 'bob', via: 'human', at: '2026-01-01T00:00:06.000Z' }]));
  assert.equal(bad['bob\'s pane: "alice: '], false);
  assert.equal(bad['No bare "room: decid'], false);
  assert.equal(bad['No new decision, sig'], false);
});

test('joinNotices: one dim join line (0.5.0-beta.7), its first line when wrapped; hook frames are found', () => {
  // run take4, S1 alice (wrapped at the pane width) and S2 bob
  const s1 = '⏺ sub-human: opened room husky-7354 as alice · on this machine others join with /sub-human; another machine: \n  /sub-human invite · starting the room\'s Claude…\n\n❯ /sub-human:sub-human alice\n\n⏺ sub-human:room(husky-7354)\n';
  assert.deepEqual(joinNotices(s1), { notices: ['⏺ sub-human: opened room husky-7354 as alice · on this machine others join with /sub-human; another machine:'], frame: null });
  const s2 = '⏺ sub-human: joined husky-7354 as bob, with alice · @room to talk; your Claude can message other Claudes, edit the room plan and the task list\n\n⏺ sub-human:room(husky-7354)\n⏺ sub-human: alice: hi\n';
  assert.equal(joinNotices(s2).notices.length, 1); // the room row and a chat row are not join lines
  assert.equal(joinNotices('⏺ UserPromptExpansion operation blocked by hook:\n  ⎿ sub-human: joined husky-7354 as bob\n').frame, '⏺ UserPromptExpansion operation blocked by hook:');
  assert.deepEqual(joinNotices(null), { notices: [], frame: null });
});

test('S1/S2: the join check wants exactly one notice in the current format and no hook frame', () => {
  const s1 = sceneOf('S1'), s2 = sceneOf('S2');
  const base: Partial<Ctx> = { A: 'alice', B: 'bob', code: 'husky-7354', roomDir: '/nonexistent', members: {}, st: (_s, _n, _f, d) => d, nativeTasks: () => [], entries: () => [], capName: (s: string, seat: string) => `${s}-sh-${seat}.txt`,
    byKind: () => [], fmt: () => '', span: () => null, roomClaudeTurns: () => 0, stateFile: () => '/nonexistent', shownVia: () => null, chatIn: () => [], pullIn: () => [], wakeIn: () => [], chatTurn: () => ({ woke: false, idle: null, evidence: 'no chat row' }), textOf: () => '' };
  const verdict = (mod: SceneModule, seat: string, pane: string): boolean | undefined => {
    const x = asCtx({ ...base, cap: (_s, who) => (who === seat ? pane : '') });
    const r = runChecks(x, { scenes: [mod] })[mod.scene];
    return must(r).find(c => /join shows one line/.test(c.check))?.pass;
  };
  const opened = '⏺ sub-human: opened room husky-7354 as alice · on this machine others join with /sub-human; another machine: \n  /sub-human invite\n';
  assert.equal(verdict(s1, 'alice', opened), true);
  assert.equal(verdict(s1, 'alice', ''), false); // no line at all: the module did not answer
  assert.equal(verdict(s1, 'alice', opened + opened), false); // two
  assert.equal(verdict(s1, 'alice', '⏺ sub-human: opened room otter-0001 as alice · on this machine others join with /sub-human\n'), false); // another room
  assert.equal(verdict(s1, 'alice', 'Operation stopped by hook:\n' + opened), false);
  const joined = '⏺ sub-human: joined husky-7354 as bob, with alice · @room to talk; your Claude can message other Claudes, edit the room plan and the task list\n';
  assert.equal(verdict(s2, 'bob', joined), true);
  assert.equal(verdict(s2, 'bob', '⏺ sub-human: rejoined husky-7354 as bob, with alice · @room to talk; your Claude can message other Claudes, edit the room plan and the task list\n'), false);
  assert.equal(verdict(s2, 'bob', joined + '⏺ UserPromptExpansion operation blocked by hook\n'), false);
  // the film's people (screens/run.json seats): the same checks under their names
  const film = (mod: SceneModule, seat: string, pane: string) => runChecks(asCtx({ ...base, A: 'tristan', B: 'jess', cap: (_s, who) => (who === seat ? pane : '') }), { scenes: [mod] })[mod.scene]?.find(c => /join shows one line/.test(c.check));
  assert.equal(film(s1, 'tristan', opened.replace('as alice', 'as tristan'))?.pass, true);
  assert.equal(film(s1, 'tristan', opened)?.pass, false); // alice's line is not tristan's
  assert.match(String(film(s2, 'jess', '')?.check), /^jess's join shows one line, "sub-human: joined CODE as jess, with tristan/);
  assert.equal(film(s2, 'jess', '⏺ sub-human: joined husky-7354 as jess, with tristan · @room to talk; your Claude can message other Claudes, edit the room plan and the task list\n')?.pass, true);
});

test('S5 isReview: a "proposal <hash>" stub or a proposal\'s own text (Claude Code records the plan file); not the no-dialog close', () => {
  const text = '# Plan: cursor paging for `GET /tasks`\n\nbody\n';
  const h = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  const hashes = new Set(['c5010cdba765', h]);
  const res = (id: string, content: string): TEntry => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  const es = [res('a', 'User has approved your plan. You can now start coding.'), res('b', 'User has approved your plan.'), res('c', 'User has approved exiting plan mode. You can now proceed.'),
    res('d', 'User has approved your plan.'), res('e', 'User has approved your plan.')];
  assert.equal(isReview({ id: 'a', input: { plan: 'proposal c5010cdba765' } }, es, hashes), true);
  assert.equal(isReview({ id: 'b', input: { plan: text, planFilePath: '/x/plan.md' } }, es, hashes), true);
  assert.equal(isReview({ id: 'c', input: { plan: text, planFilePath: '/x/plan.md' } }, es, hashes), false); // closing after an objection
  assert.equal(isReview({ id: 'd', input: { plan: 'my own plan' } }, es, hashes), false);
  assert.equal(isReview({ id: 'e', input: { plan: 'proposal 000000000000' } }, es, hashes), false); // no such proposal
});
