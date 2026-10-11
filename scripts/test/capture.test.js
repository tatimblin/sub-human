'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { framer, finalise, parseSessions, verdict } = require('../capture.js');

const CAPTURE = path.join(__dirname, '..', 'capture.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sh-cap-'));
const lines = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('capture: a frame only when the pane changed; sizes kept per session', () => {
  const fr = framer();
  const p = (ansi, cols = 120, rows = 36) => ({ ansi, cols, rows });
  assert.deepEqual(fr.feed('alice', p('a'), 10), { t: 10, kind: 'frame', session: 'alice', ansi: 'a' });
  assert.equal(fr.feed('alice', p('a'), 110), null);
  assert.equal(fr.feed('claude', null, 110), null); // not there yet
  assert.equal(fr.feed('alice', p('b'), 210).ansi, 'b');
  assert.equal(fr.feed('bob', p('a', 80, 24), 210).session, 'bob'); // per session
  assert.deepEqual(fr.sizes, { alice: { cols: 120, rows: 36 }, bob: { cols: 80, rows: 24 } });
  assert.deepEqual(parseSessions('alice=sh-alice,claude'), [['alice', 'sh-alice'], ['claude', 'sh-claude']]);
});

test('capture: finalise puts one meta first, sorts the rest by t (stable), drops torn lines', () => {
  const f = path.join(tmp(), 'capture.jsonl');
  fs.writeFileSync(f, [
    '{"t":0,"kind":"meta","sessions":{},"room":null}',
    '{"t":300,"kind":"frame","session":"alice","ansi":"x"}',
    '{"t":250,"kind":"marker","scene":"S1","beat":"open","caption":"c"}',
    '{"t":300,"kind":"frame","session":"bob","ansi":"y"}',
    '{"t":40',
  ].join('\n') + '\n');
  const n = finalise(f, { sessions: { alice: { cols: 120, rows: 36 } }, room: 'vole-8126' });
  const ls = lines(f);
  assert.deepEqual(ls.map(o => [o.kind, o.t]), [['meta', 0], ['marker', 250], ['frame', 300], ['frame', 300]]);
  assert.deepEqual(ls.slice(2).map(o => o.session), ['alice', 'bob']);
  assert.deepEqual(ls[0], { t: 0, kind: 'meta', sessions: { alice: { cols: 120, rows: 36 } }, room: 'vole-8126' });
  assert.deepEqual(n, { lines: 4, frames: 2, markers: 1 });
});

test('capture: verdict reads a checks.json', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'c.json'), JSON.stringify({ S1: [{ check: 'a', status: 'pass' }, { check: 'b', status: 'fail' }], _meta: { summary: { deterministic: { pass: 1, fail: 1 } } } }));
  assert.deepEqual(verdict(path.join(d, 'c.json')), { summary: { deterministic: { pass: 1, fail: 1 } }, failed: ['S1: b'], pass: false });
});

test('capture fixture: the hand-made trailer/capture/fixture follows the contract', () => {
  const f = path.join(__dirname, '..', '..', 'trailer', 'capture', 'fixture', 'capture.jsonl');
  const ls = lines(f);
  assert.equal(ls[0].kind, 'meta');
  assert.deepEqual(Object.keys(ls[0].sessions).sort(), ['alice', 'bob', 'claude']);
  assert.match(ls[0].room, /^[a-z]+-\d{4}$/);
  for (let i = 1; i < ls.length; i++) assert.ok(ls[i].t >= ls[i - 1].t, `sorted at line ${i + 1}`);
  const frames = ls.filter(o => o.kind === 'frame');
  for (const s of ['alice', 'bob', 'claude']) assert.ok(frames.some(o => o.session === s && o.t === 0), `${s} has a frame at t 0`);
  for (const o of frames) assert.ok(o.ansi.split('\n').length <= ls[0].sessions[o.session].rows, `${o.session}@${o.t} fits its rows`);
  assert.ok(ls.filter(o => o.kind === 'marker').every(o => o.scene && o.beat && o.caption));
  assert.ok(ls.at(-1).t >= 15000, 'about 20 s long');
});

const hasTmux = spawnSync('tmux', ['-V']).status === 0;

test('capture: the poller records a real tmux pane, markers from another process, and finalises on stop', { skip: !hasTmux && 'no tmux' }, async () => {
  const d = tmp();
  const s = `cap-test-${process.pid}`; // never an sh-* session
  const env = { ...process.env, CAPTURE_ACTIVE: path.join(d, 'active.json'), SUB_HUMAN_ROOM: 'otter-4821' };
  execFileSync('tmux', ['new-session', '-d', '-s', s, '-x', '120', '-y', '36', 'sh']);
  try {
    execFileSync('tmux', ['set-window-option', '-t', s, 'window-size', 'manual']);
    execFileSync('tmux', ['resize-window', '-t', s, '-x', '120', '-y', '36']);
    const take = path.join(d, 'take');
    const p = spawn(process.execPath, [CAPTURE, 'start', take, '--sessions', `alice=${s},claude=cap-missing-${process.pid}`, '--interval', '50'], { env, stdio: 'ignore' });
    for (let i = 0; i < 50 && !fs.existsSync(env.CAPTURE_ACTIVE); i++) await sleep(50);
    await sleep(300);
    execFileSync('tmux', ['send-keys', '-t', `${s}:`, 'printf "\\033[31mred\\033[0m hello\\n"', 'Enter']);
    await sleep(400);
    const run = a => assert.equal(spawnSync(process.execPath, [CAPTURE, ...a], { env }).status, 0);
    run(['scene', 'S1', 'start']);
    run(['mark', 'S1', 'open', 'alice opens a room']);
    run(['scene', 'S1', 'ok']);
    run(['stop']);
    await new Promise(r => (p.exitCode != null ? r() : p.on('exit', r)));
    const ls = lines(path.join(take, 'capture.jsonl'));
    assert.equal(ls[0].kind, 'meta');
    assert.deepEqual(ls[0].sessions, { alice: { cols: 120, rows: 36 } });
    assert.equal(ls[0].room, 'otter-4821');
    const fs1 = ls.filter(o => o.kind === 'frame');
    assert.ok(fs1.length >= 2, `${fs1.length} frames`);
    assert.ok(fs1.every(o => o.session === 'alice'));
    assert.ok(fs1.some(o => o.ansi.includes('\x1b[31mred')), 'colours kept');
    assert.equal(fs1.at(-1).ansi.split('\n').length, 36);
    assert.deepEqual(ls.filter(o => o.kind === 'marker').map(o => [o.scene, o.beat, o.caption]), [['S1', 'open', 'alice opens a room']]);
    const rj = JSON.parse(fs.readFileSync(path.join(take, 'run.json'), 'utf8'));
    assert.equal(rj.scenes[0].scene, 'S1'); assert.equal(rj.scenes[0].status, 'ok');
    assert.ok(rj.scenes[0].endT >= rj.scenes[0].startT);
    assert.equal(fs.existsSync(env.CAPTURE_ACTIVE), false);
    run(['mark', 'S2', 'x', 'no capture active: a no-op']);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', s]);
  }
});
