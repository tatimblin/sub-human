'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { COMMANDS, opts, listsRoomClaude } = require('../demo-lib.js');

const LIB = path.join(__dirname, '..', 'demo-lib.js');
const DEMO_SH = path.join(__dirname, '..', 'demo.sh');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sh-demolib-'));
const lib = (args, env = {}) => spawnSync(process.execPath, [LIB, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

test('demo-lib: every subcommand demo.sh calls is a command', () => {
  const used = new Set([...fs.readFileSync(DEMO_SH, 'utf8').matchAll(/\$LIB ([a-z-]+)/g)].map(m => m[1]));
  assert.ok(used.size > 20);
  for (const c of used) assert.ok(Object.hasOwn(COMMANDS, c), `demo.sh calls ${c}`);
});

test('demo-lib: film typing paces a long line to about 4.5 s, a short one key by key; wait-pane --below reads under a line', () => {
  const { keyDelays, paneBelow } = require('../demo-lib.js');
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

test('demo-lib: demo.sh edits no JSON inline (node -e)', () => {
  assert.doesNotMatch(fs.readFileSync(DEMO_SH, 'utf8'), /node -e/);
});

test('demo-lib: an unknown subcommand exits 2 with the usage pointer', () => {
  const r = lib(['no-such-command']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /header of scripts\/demo-lib\.js/);
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
  assert.match(fs.readFileSync(f, 'utf8'), /^\[\n \{/); // the same layout snap.js writes (1-space indent)
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
  const old = (f, fresh, all, add) => {
    let p = [];
    if (!fresh) try { p = JSON.parse(fs.readFileSync(f, 'utf8')).scenes || []; } catch { /* none */ }
    const s = all.split(' ').filter(x => p.includes(x) || add.includes(x));
    return JSON.stringify({ scenes: s, partial: s.length < all.split(' ').length }, null, 1) + '\n';
  };
  const d = tmp();
  for (const [fresh, prev, add] of [[true, ['S3'], ['S1', 'S2']], [false, ['S3'], ['S1']], [false, null, ['S5']], [false, ['S1'], []]]) {
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
  const lines = fs.readFileSync(path.join(d, 'waits.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
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
