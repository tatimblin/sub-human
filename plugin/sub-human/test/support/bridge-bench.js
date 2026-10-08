#!/usr/bin/env node
'use strict';
/**
 * test/support/bridge-bench.js: the numbers behind the bridge's proof gate (a hook pays the worker's boot, not the calls). Test
 * only; prints a markdown table of p50 / p99 in ms.
 *
 *   node plugin/sub-human/test/support/bridge-bench.js [--calls N] [--hooks N]
 *       per call: store calls on an FsRoomStore here vs the same calls through ThreadRoomStore (bridge + worker);
 *       start: a new bridge's first call (worker boot + the handler's load);
 *       floor: a node process that makes one bridge call to an empty handler vs one that makes none;
 *       per hook: hook processes run plain vs with the thread store preloaded (SUB_HUMAN_TEST_THREAD_STORE),
 *       interleaved so drift hits both alike.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir } = require(path.join(__dirname, '..', 'helpers.js'));
const { World, fixture } = require(path.join(__dirname, '..', 'hooks', 'helpers.js'));
const { createBridge } = require(path.join(__dirname, '..', '..', 'lib', 'remote', 'bridge.js'));
const { FsRoomStore } = require(path.join(__dirname, '..', '..', 'lib', 'room', 'store.js'));
const { ThreadRoomStore } = require('./thread-store.js');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const CALLS = arg('--calls', 500);
const HOOKS = arg('--hooks', 40);

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const ms = n => n.toFixed(n < 1 ? 3 : 1);
function time(fn) { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; }
const row = (what, a, b) => `| ${what} | ${ms(pct(a, 0.5))} / ${ms(pct(a, 0.99))} | ${ms(pct(b, 0.5))} / ${ms(pct(b, 0.99))} | ${ms(pct(b, 0.5) - pct(a, 0.5))} / ${ms(pct(b, 0.99) - pct(a, 0.99))} |`;

/** Per call: each op CALLS times on both stores of one room. */
function perCall(w) {
  const out = [];
  w.lib(() => {
    const fs = new FsRoomStore(w.code), th = new ThreadRoomStore(w.code);
    for (let i = 0; i < 40; i++) fs.append({ kind: 'status', text: `line ${i}` }, { via: 'system', from: 'orch', system: true });
    th.lastId(); // the worker is up before timing
    const ops = {
      'lastId()': s => s.lastId(),
      'kv.get()': s => s.kv.get('tasks'),
      'members.read()': s => s.members.read(),
      'readView({after})': s => s.readView({ after: 30 }),
      'readAll() (40 entries)': s => s.readAll(),
      'kv.update() (CAS)': s => s.kv.update('bench', v => ({ n: ((v && v.n) || 0) + 1 })),
    };
    for (const [name, op] of Object.entries(ops)) {
      const a = [], b = [];
      for (let i = 0; i < CALLS; i++) { a.push(time(() => op(fs))); b.push(time(() => op(th))); }
      out.push(row(name, a, b));
    }
  });
  return out;
}

/** A new bridge's first call: worker boot plus loading the handler (thread-store.js and lib/room/store.js). */
function start() {
  const xs = [];
  for (let i = 0; i < 20; i++) {
    const b = createBridge({ handler: require.resolve('./thread-store.js') });
    xs.push(time(() => { try { b.call('none', {}); } catch { /* the reply is what is timed */ } }));
    b.close();
  }
  return `| first call of a new bridge | | ${ms(pct(xs, 0.5))} / ${ms(pct(xs, 0.99))} | |`;
}

/** The floor: a process that only requires the bridge vs one that also makes one call to an empty handler. */
function floor() {
  const handler = path.join(tmpDir('sh-bench-'), 'empty.js');
  fs.writeFileSync(handler, 'exports.handle = () => true;\n');
  const BRIDGE = require.resolve(path.join(__dirname, '..', '..', 'lib', 'remote', 'bridge.js'));
  const proc = body => time(() => spawnSync(process.execPath, ['-e', `const { createBridge } = require(${JSON.stringify(BRIDGE)}); ${body}`]));
  const a = [], b = [];
  for (let i = 0; i < HOOKS; i++) { a.push(proc('')); b.push(proc(`createBridge({ handler: ${JSON.stringify(handler)} }).call('x', {});`)); }
  return row('a process: one call to an empty handler', a, b);
}

/** Per hook: wall time of a hook process, plain vs over the thread store. */
function perHook(w) {
  const proxy = { SUB_HUMAN_TEST_THREAD_STORE: '1', NODE_OPTIONS: `--require ${require.resolve('./thread-store.js')}` };
  const submit = prompt => ({ ...fixture('user-prompt-submit'), prompt });
  const hooks = {
    'prompt.js, a plain prompt': ['prompt', submit('what changed?')],
    'prompt.js, an @room post (signed append)': ['prompt', submit('@room bench')],
    'presence.js, idle_prompt': ['presence', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'idle' }],
  };
  const out = [];
  for (const [name, [hook, input]] of Object.entries(hooks)) {
    const a = [], b = [];
    const run = env => time(() => { const r = w.hook(hook, input, { as: 'alice', env }); if (r.code !== 0) throw new Error(`${hook}: ${r.stderr}`); });
    for (let i = 0; i < HOOKS; i++) { a.push(run({})); b.push(run(proxy)); }
    out.push(row(name, a, b));
  }
  return out;
}

const w = new World({ orch: 'sleep', alice: 'act' });
console.log(`node ${process.version}, ${process.platform}; per call n=${CALLS}, per hook n=${HOOKS}\n`);
console.log('| | plain p50 / p99 (ms) | thread store p50 / p99 (ms) | overhead p50 / p99 (ms) |\n|---|---|---|---|');
for (const l of [...perCall(w), start(), floor(), ...perHook(w)]) console.log(l);
