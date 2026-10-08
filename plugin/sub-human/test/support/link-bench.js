#!/usr/bin/env node
'use strict';
/**
 * test/support/link-bench.js: the numbers behind PR5's latency check (docs/next/REMOTE-PLAN.md PR3 condition 3, PR5
 * As built). Test only; prints a markdown table of p50 / p99 in ms.
 *
 *   node plugin/sub-human/test/support/link-bench.js [--calls N] [--hooks N]
 *       round trip: one op from a mirror in this process (its bridge up) through the link daemon's socket and the
 *       pipe to the host's server, which places the entry and streams it back before replying;
 *       per hook: the same hook on the host (alice, its own store) and on the remote home (bob, the mirror),
 *       interleaved so drift hits both alike: a plain prompt (reads only: no worker), an @room post and a
 *       presence change (one op each over the link).
 */
const path = require('node:path');
const h = require('../helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.js'));
const link = require(path.join(h.LIB, 'remote', 'link.js'));
const { Machine } = require('./two-homes.js');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const CALLS = arg('--calls', 200);
const HOOKS = arg('--hooks', 40);

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const ms = n => n.toFixed(n < 1 ? 3 : 1);
function time(fn) { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; }
const row = (what, a, b) => `| ${what} | ${ms(pct(a, 0.5))} / ${ms(pct(a, 0.99))} | ${ms(pct(b, 0.5))} / ${ms(pct(b, 0.99))} | ${ms(pct(b, 0.5) - pct(a, 0.5))} / ${ms(pct(b, 0.99) - pct(a, 0.99))} |`;

const host = new Machine(undefined, 'host'), remote = new Machine(undefined, 'remote');
const alice = host.seat('alice'), bob = remote.seat('bob');
host.join(alice, 'alice');
const code = host.lib(() => store.listRooms()[0]);
const invite = /sh1\.\S+/.exec(host.join(alice, 'host').json.reason)[0];
const joined = remote.join(bob, `join bob ${invite}`);
if (!joined.json.hookSpecificOutput) throw new Error(`join: ${JSON.stringify(joined.json)} ${joined.stderr}`);
const daemon = remote.lib(() => link.status(code)).pid;
process.on('exit', () => { try { process.kill(daemon); } catch { /* gone */ } });

/** One signed post from a mirror in this process: its bridge is up after the first. */
function roundTrip() {
  return remote.lib(() => {
    const mirror = store.open(code);
    const say = i => mirror.append({ kind: 'say', text: `round trip ${i}` }, { via: 'human', from: 'bob' });
    say(-1);
    const a = [], b = [];
    const local = store.open(code, { dir: h.tmpDir('sh-bench-') });
    for (let i = 0; i < CALLS; i++) { a.push(time(() => local.append({ kind: 'say', text: `local ${i}` }, { via: 'human', from: 'bob' }))); b.push(time(() => say(i))); }
    return row('one signed append: a local FsRoomStore vs the mirror (bridge up)', a, b);
  });
}

function perHook() {
  const states = ['idle', 'permission'];
  const hooks = {
    'prompt.js, a plain prompt (no worker on the mirror)': (m, s) => m.plain(s, 'what changed?'),
    'prompt.js, an @room post': (m, s, i) => m.say(s, `bench ${i}`),
    'presence.js, a changed state': (m, s, i) => m.hook('presence', { hook_event_name: 'Notification', notification_type: `${states[i % 2]}_prompt` }, s),
  };
  const out = [];
  for (const [name, run] of Object.entries(hooks)) {
    const a = [], b = [];
    for (let i = 0; i < HOOKS; i++) {
      a.push(time(() => { const r = run(host, alice, i); if (r.status !== 0) throw new Error(r.stderr); }));
      b.push(time(() => { const r = run(remote, bob, i); if (r.status !== 0 || (r.json && r.json.decision)) throw new Error(`${r.stderr} ${JSON.stringify(r.json)}`); }));
    }
    out.push(row(name, a, b));
  }
  return out;
}

console.log(`node ${process.version}, ${process.platform}; round trip n=${CALLS}, per hook n=${HOOKS}\n`);
console.log('| | host p50 / p99 (ms) | remote p50 / p99 (ms) | overhead p50 / p99 (ms) |\n|---|---|---|---|');
for (const l of [roundTrip(), ...perHook()]) console.log(l);
