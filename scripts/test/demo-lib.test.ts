import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMMANDS, opts, listsRoomClaude, keyDelays, paneBelow, newMatches, taskFor } from '../demo-lib.ts';
import { roomRowMembers, subagentRows } from '../lib/panes.ts';
import { runInfo } from '../checks/context.ts';

const LIB = path.join(import.meta.dirname, '..', 'demo-lib.ts');
const DEMO_SH = path.join(import.meta.dirname, '..', 'demo.sh');
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sh-demolib-'));
const lib = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [LIB, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('demo-lib: every subcommand demo.sh calls is a command', () => {
  const used = new Set([...fs.readFileSync(DEMO_SH, 'utf8').matchAll(/\$LIB ([a-z-]+)/g)].map(m => m[1]));
  assert.ok(used.size > 20);
  for (const c of used) assert.ok(Object.hasOwn(COMMANDS, c), `demo.sh calls ${c}`);
});

test('demo-lib: film typing paces a long line to about 4.5 s, a short one key by key; wait-pane --below reads under a line', () => {
  const long = keyDelays('x'.repeat(300)).reduce((a, b) => a + b, 0);
  assert.ok(long > 3500 && long < 5500, `${long} ms`);
  const short = keyDelays('@room hi, bob');
  assert.equal(short.length, 13);
  assert.ok(short.every(d => d >= 7 && d <= 140), short.join(' '));
  assert.equal(paneBelow('a\n! npm test --silent\n# fail 1\n! npm test --silent\n# fail 0', 'npm test --silent'), '# fail 0');
  assert.equal(paneBelow('no run here', 'npm test --silent'), '');
  assert.equal(paneBelow('all', undefined), 'all');
});

test('demo.sh --film: the story scenes only, S6b defined, every mark has a short caption', () => {
  const sh = fs.readFileSync(DEMO_SH, 'utf8');
  assert.match(sh, /\[ "\$FILM" = 1 \] && ALL=\(S1 S2 S3 S4 S5 S6b S10\)/);
  assert.match(sh, /^S6b\(\) \{/m);
  const marks = [...sh.matchAll(/^\s*mark ([a-z]+) "([^"]*)"/gm)];
  assert.ok(marks.length >= 15, `${marks.length} marks`);
  for (const m of marks) assert.ok(m[2].length > 0 && m[2].length <= 80, `caption for ${m[1]}: ${m[2]}`);
});

test('demo-lib: wait-pane --new takes only a summary the pane did not show before; demo.sh\'s PASS6b reads a real run', () => {
  const sh = fs.readFileSync(DEMO_SH, 'utf8');
  const src = (/^PASS6b='([^']+)'/m.exec(sh) ?? [])[1] ?? '';
  // the end of a ! git pull && npm test in a 36-row pane (Claude Code 2.1.292): the typed line has scrolled off
  const sum = (ms: string): string => `     ✔ GET /health (16.5ms)\n     ℹ tests 32\n     ℹ suites 0\n     ℹ pass 32\n     ℹ fail 0\n     ℹ cancelled 0\n     ℹ skipped 0\n     ℹ todo 0\n     ℹ duration_ms ${ms}\n`;
  const before = `⏺ Bash(npm test)\n${sum('90.2')}\n⏺ All pass.\n❯ \n`;
  assert.deepEqual(newMatches(src, before, before), []);
  const after = `${sum('90.2')}\n⏺ All pass.\n${sum('497.934875')}\n⏺ This pull added 24 more test files.\n❯ \n`;
  const got = newMatches(src, before, after);
  assert.equal(got.length, 1);
  assert.match(got[0], /duration_ms 497\.934875$/);
  assert.deepEqual(newMatches(src, '', sum('1.2').replace('fail 0', 'fail 1')), []);
  assert.deepEqual(newMatches(src, '', 'ℹ pass 3\nℹ fail 0\n'), []); // cut off: not the whole summary yet
  assert.match(sh, /^RUN6b="git pull && npm test"$/m);
});

test('demo-lib taskFor: the task the room\'s Claude added for a person\'s add request, after an id', () => {
  const log = [
    { id: 3, kind: 'task_req', from: 'alice', op: 'add', subject: 'Paging handler', owner: 'alice' },
    { id: 4, kind: 'task_req', from: 'alice', op: 'add', subject: 'Paging tests', owner: 'bob' },
    { id: 5, kind: 'task', from: 'claude', op: 'add', task_id: '2', subject: 'Paging handler', req: 3 },
    { id: 7, kind: 'task_req', from: 'bob', op: 'claim', task_id: '2', owner: 'bob' },
  ];
  assert.equal(taskFor(log, 'alice', 2), '2');
  assert.equal(taskFor(log, 'bob', 2), null); // asked, not applied yet
  assert.equal(taskFor([...log, { id: 6, kind: 'task', op: 'add', task_id: '3', req: 4 }], 'bob', 2), '3');
  assert.equal(taskFor(log, 'alice', 3), null); // only requests after the id
});

test('panes: an opened room row and its members; a Claude\'s own subagent rows (Claude Code 2.1.292)', () => {
  // alice after ↓ ↓ Enter on the room row: the room view, bob inside the row
  const open = '─── egret-7989 ─\n❯ Message @sub-human:room…\n────\n  ↑/↓ to select · ctrl+x ctrl+k to stop all agents\n\n  ◯ main\n❯ ⏺ egret-7989  +bob joined · 2 here\n  └ ◯ bob  working\n';
  assert.deepEqual(roomRowMembers(open, 'egret-7989')?.members, ['bob']);
  assert.deepEqual(roomRowMembers('  ⏺ main\n  ◯ egret-7989  2 here\n', 'egret-7989')?.members, []);
  assert.equal(roomRowMembers(open, 'swan-6397'), null);
  assert.deepEqual(subagentRows(open, 'egret-7989'), []);
  const sub = '  ⏺ main\n  ◯ egret-7989  +alice joined · 2 here\n  ◯ Explore  Explain GET /tasks flow                     4s · ↓ 19.3k tokens\n';
  assert.deepEqual(subagentRows(sub, 'egret-7989').map(r => [r.label, r.text.split('  ')[0]]), [['Explore', 'Explain GET /tasks flow']]);
});

test('demo.sh --film: the panel beat opens the room row and comes back with one ↑; S6b prompts name no tool', () => {
  const sh = fs.readFileSync(DEMO_SH, 'utf8');
  const show = (/^show_room\(\) \{\n([\s\S]*?)\n\}/m.exec(sh) ?? [])[1] ?? '';
  assert.match(show, /select-row "sh-\$s" "\$\(room\)"/);
  assert.match(show, /select-row "sh-\$s" main --key Up/);
  assert.equal((show.match(/keys "\$s" Up/g) || []).length, 1);
  assert.match(sh, /mark panel "Everyone in the room shows up in your agent panel"/);
  const s6b = (/^S6b\(\) \{\n([\s\S]*?)\n\}/m.exec(sh) ?? [])[1] ?? '';
  const prompts = [...s6b.matchAll(/submit "\$[ab]" "([^"]*)"/g)].map(m => m[1]);
  assert.ok(prompts.length >= 3, `${prompts.length} S6b prompts`);
  for (const p of prompts) assert.doesNotMatch(p, /mcp__|op \\"|tool/, p);
  assert.match(s6b, /wait-subagent-row "sh-\$b"/);
});

test('demo.sh --film: tristan opens the room and jess joins; no alice or bob in the film\'s words or captions', () => {
  const sh = fs.readFileSync(DEMO_SH, 'utf8');
  assert.match(sh, /\[ "\$FILM" = 1 \] && \{ SEAT_A=tristan; SEAT_B=jess; \}/);
  assert.match(sh, /--sessions "\$SEAT_A=sh-\$SEAT_A,\$SEAT_B=sh-\$SEAT_B,claude=sh-claude"/);
  // the words the film types (its branch of the scripted words), the S6b scene and the marks' captions
  const words = (/^if \[ "\$FILM" = 1 \]; then\n(  SAY3=[\s\S]*?)\nelse\n/m.exec(sh) ?? [])[1] ?? '';
  const s6b = (/^S6b\(\) \{\n([\s\S]*?)\n\}/m.exec(sh) ?? [])[1] ?? '';
  const film = ['S1', 'S2', 'S3', 'S4', 'S5', 'S10'].map(s => (new RegExp(`^${s}\\(\\) \\{[^\\n]*\\n([\\s\\S]*?)\\n\\}`, 'm').exec(sh) ?? [])[1] ?? '');
  for (const t of [words, s6b, ...film]) assert.doesNotMatch(t, /\b(alice|bob)\b/i);
  // the handoff waits on the state itself: A's commit on the origin, then in B's checkout
  assert.match(s6b, /wait_commit "\$BASE\/origin\.git" "\$a"/);
  assert.match(s6b, /wait_commit "\$BASE\/\$b" "\$a"/);
  // each half is real code with its own tests
  assert.match(s6b, /src\/store\.js and test\/store-paging\.test\.js only/);
  assert.match(s6b, /src\/server\.js and test\/server-paging\.test\.js only/);
});

test('demo-lib plan-run --seats and run-words: the run\'s people and scripted words in run.json, as checks/context.ts reads them', () => {
  const d = tmp();
  const f = path.join(d, 'run.json');
  assert.equal(lib(['plan-run', f, '--all', ALL, '--seats', 'tristan jess', '--fresh', 'S1']).status, 0);
  assert.equal(lib(['run-words', f, 'say3', 'jess, can you take the HTTP side?', 'note5', 'a garbled cursor like `after=zzz` must 400, not 500 — add a test for it']).status, 0);
  assert.deepEqual(readJson(f), { scenes: ['S1'], partial: true, seats: ['tristan', 'jess'], words: { say3: 'jess, can you take the HTTP side?', note5: 'a garbled cursor like `after=zzz` must 400, not 500 — add a test for it' } });
  const r = runInfo(d);
  assert.deepEqual([r.A, r.B, r.DEMO.say3], ['tristan', 'jess', 'jess, can you take the HTTP side?']);
  assert.match(r.DEMO.plan4, /^let's plan cursor paging/); // a word the run did not write: the default
  assert.deepEqual([runInfo(tmp()).A, runInfo(tmp()).B], ['alice', 'bob']); // no run.json
  assert.equal(lib(['run-words', f, 'say3']).status, 2); // a key with no text
});

test('demo-lib: demo.sh edits no JSON inline (node -e)', () => {
  assert.doesNotMatch(fs.readFileSync(DEMO_SH, 'utf8'), /node -e/);
});

test('demo-lib: an unknown subcommand exits 2 with the usage pointer', () => {
  const r = lib(['no-such-command']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /header of scripts\/demo-lib\.ts/);
  assert.equal(lib(['toString']).status, 2); // not an inherited property
});

test('demo-lib opts: flags take no value, other options one', () => {
  assert.deepEqual(opts(['f.json', '--all', 'S1 S2', '--fresh', 'S1', '--absent', '--timeout', '5']),
    { _: ['f.json', 'S1'], all: 'S1 S2', fresh: true, absent: true, timeout: '5' });
});

test('demo-lib prune-index: drops the named scenes, keeps the rest and their order', () => {
  const f = path.join(tmp(), 'index.json');
  fs.writeFileSync(f, JSON.stringify([{ scene: 'S1', n: 1 }, { scene: 'S4', n: 2 }, { scene: 'S2', n: 3 }, { scene: 'S5', n: 4 }]));
  assert.equal(lib(['prune-index', f, 'S4', 'S5']).status, 0);
  assert.deepEqual(readJson(f), [{ scene: 'S1', n: 1 }, { scene: 'S2', n: 3 }]);
  assert.match(fs.readFileSync(f, 'utf8'), /^\[\n \{/); // the same layout snap.ts writes (1-space indent)
});

test('demo-lib prune-index: a missing or broken index becomes []', () => {
  const d = tmp();
  assert.equal(lib(['prune-index', path.join(d, 'index.json'), 'S1']).status, 0);
  assert.deepEqual(readJson(path.join(d, 'index.json')), []);
  fs.writeFileSync(path.join(d, 'bad.json'), '{"torn');
  assert.equal(lib(['prune-index', path.join(d, 'bad.json'), 'S1']).status, 0);
  assert.deepEqual(readJson(path.join(d, 'bad.json')), []);
});

const ALL = 'S1 S2 S3 S4 S5 S6 S7 S8 S9 S9b S10';

test('demo-lib plan-run: a fresh run lists only its scenes, in the --all order', () => {
  const f = path.join(tmp(), 'screens', 'run.json'); // the folder is created
  fs.mkdirSync(path.dirname(f));
  fs.writeFileSync(f, JSON.stringify({ scenes: ['S3', 'S6'] }));
  assert.equal(lib(['plan-run', f, '--all', ALL, '--fresh', 'S10', 'S1', 'S9b']).status, 0);
  assert.deepEqual(readJson(f), { scenes: ['S1', 'S9b', 'S10'], partial: true });
});

test('demo-lib plan-run: a resume adds to the scenes already listed; every scene = not partial', () => {
  const f = path.join(tmp(), 'run.json');
  assert.equal(lib(['plan-run', f, '--all', ALL, 'S1', 'S2']).status, 0); // no file yet: just these
  assert.deepEqual(readJson(f), { scenes: ['S1', 'S2'], partial: true });
  assert.equal(lib(['plan-run', f, '--all', ALL, 'S4', 'S2']).status, 0);
  assert.deepEqual(readJson(f).scenes, ['S1', 'S2', 'S4']);
  assert.equal(lib(['plan-run', f, '--all', ALL, ...ALL.split(' ')]).status, 0);
  assert.deepEqual(readJson(f), { scenes: ALL.split(' '), partial: false });
});

test('demo-lib plan-run: matches the inline edit it replaced', () => {
  // the former demo.sh one-liner, kept here as the reference
  const old = (f: string, fresh: boolean, all: string, add: string[]): string => {
    let p: string[] = [];
    if (!fresh) try { p = JSON.parse(fs.readFileSync(f, 'utf8')).scenes || []; } catch { /* none */ }
    const s = all.split(' ').filter(x => p.includes(x) || add.includes(x));
    return JSON.stringify({ scenes: s, partial: s.length < all.split(' ').length }, null, 1) + '\n';
  };
  const d = tmp();
  const cases: Array<[boolean, string[] | null, string[]]> = [[true, ['S3'], ['S1', 'S2']], [false, ['S3'], ['S1']], [false, null, ['S5']], [false, ['S1'], []]];
  for (const [fresh, prev, add] of cases) {
    const f = path.join(d, `run-${Math.random().toString(36).slice(2)}.json`);
    if (prev) fs.writeFileSync(f, JSON.stringify({ scenes: prev }));
    const want = old(f, fresh, ALL, add);
    assert.equal(lib(['plan-run', f, '--all', ALL, ...(fresh ? ['--fresh'] : []), ...add]).status, 0);
    assert.equal(fs.readFileSync(f, 'utf8'), want);
  }
});

test('demo-lib record: appends one waits.jsonl line for the current scene; --ok false marks it failed', () => {
  const d = tmp();
  const env = { SNAP_DIR: d, DEMO_SCENE: 'S4' };
  assert.equal(lib(['record', '--what', 'nudge: alice asked for the card'], env).status, 0);
  assert.equal(lib(['record', '--what', 'S4: timed out waiting: "x"', '--ok', 'false'], env).status, 0);
  const lines: Array<{ time: string, [k: string]: unknown }> = fs.readFileSync(path.join(d, 'waits.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(({ time, ...r }) => (assert.ok(Date.parse(time)), r)), [
    { scene: 'S4', what: 'nudge: alice asked for the card', ok: true, ms: 0 },
    { scene: 'S4', what: 'S4: timed out waiting: "x"', ok: false, ms: 0 },
  ]);
});

test('demo-lib listsRoomClaude: by job id or session id, as the S10 check reads claude agents --json', () => {
  const roomClaude = { job: 'job-1', session_id: 'sid-1' };
  assert.equal(listsRoomClaude([{ id: 'job-1', state: 'stopped' }], roomClaude), true);
  assert.equal(listsRoomClaude([{ id: 'other', sessionId: 'sid-1' }], roomClaude), true);
  assert.equal(listsRoomClaude([{ id: 'other', sessionId: 'sid-2' }], roomClaude), false);
  assert.equal(listsRoomClaude([], roomClaude), false);
  assert.equal(listsRoomClaude([{ id: undefined }], {}), false);
});
