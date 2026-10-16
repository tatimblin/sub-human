// The 100k-entry budget: an @room post (the store's signed append) and the agent-panel status line, measured
// in-process over a room whose log holds 100,000 entries, after a warm-up (the process's caches are filled, as in
// the long-lived tail and MCP server; a hook's cold start is the hooks entry's own budget, docs/ARCHITECTURE.md
// Performance). Budgets: append <= 50 ms, status line <= 30 ms (the median of RUNS).
//
// The log is written by hand, as a day of a busy room would leave it: one entry a second, ending now, a hash chain,
// the seats' keys pinned by member_joined, a proposal every 1,000 entries with answers, and 1 % signed human words.
// It is one log.jsonl, as a room from before segments: the first append seals it (lib/room/log-io.ts), so "cold"
// in-process includes that one rotation. Then a fresh process times its first append and status line over the
// segmented room (snapshot + active segment): the cold cost of every hook and status line from then on, budgeted
// at COLD (generous: wall clock in a child; the best of three).
//
// What fails the test is relative, so a loaded runner does not flake it: the same measurements over a room of SMALL
// entries, taken in the same process at the same time, and the 100k-entry numbers must stay within RATIO of them
// (plus SLACK ms): the cost does not grow with the log. The absolute budgets are a warning on stderr (a failure with
// SUB_HUMAN_PERF_STRICT=1, for a quiet machine).
//
// Skipped under SUB_HUMAN_TEST_THREAD_STORE (every store call would cross the bridge: another measurement) and with
// SUB_HUMAN_SKIP_PERF=1. SUB_HUMAN_PERF_REPORT=1 prints the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as h from './helpers.ts';
import * as identity from '../lib/identity.ts';
import * as store from '../lib/room/store.ts';
import * as envelope from '../lib/room/envelope.ts';
import * as seatKey from '../hooks/seat-key.ts';
import { agentStatusline } from '../statusline/index.ts';
import type { RoomCode } from '../lib/brand.ts';
import { sn } from './support/brands.ts';

const N = Number(process.env.SUB_HUMAN_PERF_N) || 100_000;
const RUNS = 15;
const BUDGET = { append: 50, statusline: 30 };
const COLD = { append: 60, statusline: 60 };
const SMALL = 1_000;
const RATIO = 8;
const SLACK = 10;
const strict = process.env.SUB_HUMAN_PERF_STRICT === '1';
/** An absolute budget: a warning, or with SUB_HUMAN_PERF_STRICT=1 a failure. */
function budget(what: string, got: number, limit: number): void {
  if (got <= limit) return;
  const msg = `${what} ${got.toFixed(1)} ms > ${limit} ms (wall clock: a loaded machine can do this)`;
  if (strict) assert.fail(msg);
  process.stderr.write(`perf warning: ${msg}\n`);
}
/** The hard check: big within RATIO x small + SLACK ms, both measured now on this machine. */
const relative = (what: string, big: number, small: number) => assert.ok(big <= small * RATIO + SLACK,
  `${what}: ${big.toFixed(1)} ms over ${N} entries, ${small.toFixed(1)} ms over ${SMALL}: it grows with the log`);
const skip = process.env.SUB_HUMAN_TEST_THREAD_STORE === '1' ? 'the thread store measures the bridge, not the store'
  : process.env.SUB_HUMAN_SKIP_PERF === '1' ? 'SUB_HUMAN_SKIP_PERF=1' : false;

const sleepers: ChildProcess[] = [];
process.on('exit', () => { for (const p of sleepers) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
const sleeper = () => { const p = spawn('sleep', ['600'], { stdio: 'ignore' }); p.unref(); sleepers.push(p); return p.pid; };

const hash12 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function time(fn: () => unknown): number { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; }

/** A room with N entries; alice (this process) and bob seated, their keys pinned. */
function bigRoom(n = N): { code: RoomCode } {
  h.freshHome();
  const code = identity.newCode();
  const names = ['alice', 'bob'];
  for (const name of names) {
    const r = identity.join({ code, name: sn(name), role: 'member', pid: name === 'alice' ? process.pid : sleeper(), session_id: `sid-${name}`, cwd: os.tmpdir() });
    assert.ok(r.ok, r.error);
  }
  const keys = Object.fromEntries(names.map(n => [n, seatKey.ensure(code, sn(n))]));
  const file = path.join(identity.roomDir(code), 'log.jsonl');
  const start = Date.now() - n * 1000;
  const out: string[] = [];
  let prev = '';
  let proposal = '';
  for (let id = 1; id <= n; id++) {
    const at = new Date(start + id * 1000).toISOString();
    let p: Record<string, unknown>;
    if (id <= names.length) {
      const n = names[id - 1];
      p = { from: n, via: 'system', kind: 'member_joined', to: 'room', text: `${n} joined`, pubkey: seatKey.publicPem(code, sn(n)) };
    } else if (id % 1000 === 0) {
      proposal = hash12(`p${id}`);
      p = { from: 'bob', via: 'agent', kind: 'proposal', to: 'room', text: `proposal ${proposal}: step ${id}`, hash: proposal, approvers: names };
    } else if (id % 1000 === 1 && proposal) {
      p = envelope.sign({ from: 'alice', via: 'human', kind: 'signoff', to: 'room', proposal_hash: proposal }, keys.alice, { room: code, from: 'alice', now: start + id * 1000 });
    } else if (id % 100 === 0) {
      p = envelope.sign({ from: 'bob', via: 'human', kind: 'say', to: 'room', text: `bob says ${id}` }, keys.bob, { room: code, from: 'bob', now: start + id * 1000 });
    } else {
      p = { from: id % 2 ? 'alice' : 'bob', via: 'agent', kind: id % 7 ? 'say' : 'status', to: 'room', text: `note ${id} ${'x'.repeat(60)}` };
    }
    const { sig, ...rest } = p as Record<string, unknown> & { sig?: string };
    const e: Record<string, unknown> = { id, at, ...rest, prev: hash12(prev) };
    if (sig !== undefined) e.sig = sig;
    prev = JSON.stringify(e);
    out.push(prev);
  }
  fs.writeFileSync(file, out.join('\n') + '\n');
  return { code };
}

/** In this process over a room of n entries: the first append and status line, then their medians after warm-up. */
function measure(n: number): { code: RoomCode; home: string; panel: object; cold: { append: number; statusline: number }; got: { append: number; statusline: number }; max: { append: number; statusline: number }; sealed: boolean } {
  const { code } = bigRoom(n);
  seatKey.arm();
  const s = store.open(code);
  let k = 0;
  const post = () => s.append({ kind: 'say', text: `alice's words ${k++}` }, { via: 'human', from: 'alice' });
  const panel = { session_id: 'sid-alice', tasks: [{ id: 't1', status: 'running', description: code }, { id: 't2', status: 'running', description: 'bob' }] };
  const line = () => { const o = agentStatusline(panel, { env: { NO_COLOR: '1' } }); assert.match(o, /"t1"/); };
  const cold = { append: time(post), statusline: time(line) };
  for (let i = 0; i < 3; i++) { post(); line(); }
  const append: number[] = [], status: number[] = [];
  for (let i = 0; i < RUNS; i++) { append.push(time(post)); status.push(time(line)); }
  return { code, home: identity.home(), panel, cold, got: { append: median(append), statusline: median(status) }, max: { append: Math.max(...append), statusline: Math.max(...status) }, sealed: !!s.snapshot() };
}

/** One fresh process: its first append and status line over room code (imports done before timing). */
function freshOnce(code: RoomCode, home: string, panel: object): { append: number; statusline: number } {
  const src = `
    const t = () => Number(process.hrtime.bigint()) / 1e6;
    const store = require(${JSON.stringify(path.join(h.LIB, 'room', 'store.ts'))});
    const seatKey = require(${JSON.stringify(path.join(h.PLUGIN, 'hooks', 'seat-key.ts'))});
    const { agentStatusline } = require(${JSON.stringify(path.join(h.PLUGIN, 'statusline', 'index.ts'))});
    seatKey.arm();
    const s = store.open(${JSON.stringify(code)});
    let a = t(); s.append({ kind: 'say', text: 'cold words' }, { via: 'human', from: 'alice' }); const append = t() - a;
    a = t(); agentStatusline(${JSON.stringify(panel)}, { env: { NO_COLOR: '1' } }); const statusline = t() - a;
    process.stdout.write(JSON.stringify({ append, statusline }));`;
  const r = spawnSync(process.execPath, ['-e', src], { env: h.childEnv({ SUB_HUMAN_HOME: home }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as { append: number; statusline: number };
}
/** FRESH_RUNS fresh processes per room, the small room's and the big room's taken in turn, the best of each: one sample
 * of wall clock in a child is at the mercy of a busy machine, and a burst of load then hits both rooms alike (stage
 * 8e I.12: the small room's three were taken before the big room was built, the big room's under the load after). */
const FRESH_RUNS = 5;
function freshPair(a: { code: RoomCode; home: string; panel: object }, b: { code: RoomCode; home: string; panel: object }) {
  const runs: { a: { append: number; statusline: number }[]; b: { append: number; statusline: number }[] } = { a: [], b: [] };
  for (let i = 0; i < FRESH_RUNS; i++) { runs.a.push(freshOnce(a.code, a.home, a.panel)); runs.b.push(freshOnce(b.code, b.home, b.panel)); }
  const best = (xs: { append: number; statusline: number }[]) => ({ append: Math.min(...xs.map(x => x.append)), statusline: Math.min(...xs.map(x => x.statusline)) });
  return { a: best(runs.a), b: best(runs.b) };
}

test(`perf: an @room post and the status line over a ${N}-entry log stay in budget`, { skip, timeout: 300_000 }, () => {
  const small = measure(SMALL);
  const big = measure(N);
  assert.ok(big.sealed, 'the first append sealed the old log');
  const { a: smallFresh, b: bigFresh } = freshPair(small, big);
  if (process.env.SUB_HUMAN_PERF_REPORT === '1') {
    process.stderr.write(`perf N=${N}: append cold ${big.cold.append.toFixed(1)} ms, median ${big.got.append.toFixed(1)} ms (max ${big.max.append.toFixed(1)}; ${SMALL} entries: ${small.got.append.toFixed(1)}); `
      + `status line cold ${big.cold.statusline.toFixed(1)} ms, median ${big.got.statusline.toFixed(1)} ms (max ${big.max.statusline.toFixed(1)}; ${SMALL} entries: ${small.got.statusline.toFixed(1)})\n`
      + `perf N=${N} segmented, a fresh process: append cold ${bigFresh.append.toFixed(1)} ms (${SMALL}: ${smallFresh.append.toFixed(1)}); status line cold ${bigFresh.statusline.toFixed(1)} ms (${SMALL}: ${smallFresh.statusline.toFixed(1)})\n`);
  }
  relative('append median', big.got.append, small.got.append);
  relative('status line median', big.got.statusline, small.got.statusline);
  relative('a fresh process\'s first append', bigFresh.append, smallFresh.append);
  relative('a fresh process\'s first status line', bigFresh.statusline, smallFresh.statusline);
  budget('append median', big.got.append, BUDGET.append);
  budget('status line median', big.got.statusline, BUDGET.statusline);
  budget('cold append over the segmented log', bigFresh.append, COLD.append);
  budget('cold status line over the segmented log', bigFresh.statusline, COLD.statusline);
});
