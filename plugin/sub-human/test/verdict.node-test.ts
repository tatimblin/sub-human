// lib/cc/verdict.ts: a Claude Code version's verdict (which features fall back on it), kept per version under the
// home; mod/core/cc.ts's pure half; and what hooks/handlers/mod-hello.ts hands the module.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as h from './helpers.ts';
import * as verdict from '../lib/cc/verdict.ts';
import * as contract from '../lib/cc/contract.ts';
import * as identity from '../lib/identity.ts';
import { World } from './hooks/helpers.ts';
import { closeOff, ccNotice, parseCc, isCcVersion, GATED, FALLBACK } from '../mod/core/cc.ts';
import { parseHello } from '../mod/core/seat.ts';
import { withLock } from '../lib/lock.ts';
import { must } from './support/must.ts';
import { isObj } from '../lib/decode.ts';
import { sid as sidOf } from './support/brands.ts';
import type { ContractEntry, Feature } from '../lib/cc/contract.ts';

const entry = (id: string, feature: Feature, extra: Partial<ContractEntry> = {}): ContractEntry => ({ id, stability: 'incidental', feature, search: [`${id}-search`], note: id, ...extra });
const ENTRIES = [
  entry('a-core', 'core'), entry('a-tasks', 'tasks'), entry('a-sign', 'sign-off'), entry('a-edit', 'plan-edit'),
  entry('a-rows', 'rows'), entry('a-look', 'cosmetic'), entry('a-test', 'test'), entry('a-room', 'room-session'), entry('a-ask', 'fallback'),
  entry('a-later', 'delivery', { degraded: [{ from: '9.0.0', note: 'reported changed' }] }),
];
const judged = (failed: string[], version = '2.1.900') => verdict.judge(version, failed, { entries: ENTRIES, now: Date.parse('2026-10-17T00:00:00Z') });
/** A stand-in binary: its VERSION marker and one entry's search string (env-clear-session-id), so not every entry is missing. */
function fakeBinary(dir: string, version: string): string {
  const bin = path.join(dir, `claude-${version}`);
  fs.writeFileSync(bin, `x VERSION:"${version}" y conversation_reset",newConversationId z`);
  return bin;
}
/** A field of a JSON text's top-level object (undefined when the text is not one). */
const field = (text: string, key: string): unknown => { const v: unknown = JSON.parse(text); return isObj(v) ? v[key] : undefined; };
const fileField = (file: string, key: string): unknown => field(fs.readFileSync(file, 'utf8'), key);
const until = async (cond: () => boolean, ms = 15_000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await h.sleep(25); }
};

test('contract: every entry names a feature, one of FEATURES', () => {
  const raw = fileField(path.join(h.LIB, 'cc', 'contract.json'), 'entries');
  const entries: unknown[] = Array.isArray(raw) ? raw : [];
  assert.equal(entries.length, contract.CONTRACT.length);
  for (const e of entries) {
    const feature = isObj(e) ? e.feature : undefined;
    assert.ok(contract.FEATURES.some(f => f === feature), `${isObj(e) ? String(e.id) : '?'}: ${String(feature)}`);
  }
  // the gated features are features, and each has its fallback's words
  for (const f of GATED) { assert.ok(contract.FEATURES.includes(f), f); assert.ok(FALLBACK[f], f); }
  // the plan view's own internals gate sign-off; the edit receipt's gate plan-edit
  const of = (id: string) => must(contract.CONTRACT.find(e => e.id === id), id).feature;
  assert.equal(of('exitplan-permission-setmode'), 'sign-off');
  assert.equal(of('module-plan-mode-detail'), 'plan-edit');
  assert.equal(of('task-file-schema'), 'tasks');
  assert.equal(of('bg-dispatch-line'), 'room-session');
  assert.equal(of('hooks-modules'), 'core');
});

test('judge: core, cosmetic and test failures gate nothing (unverified only); a gated one turns its feature off; sign-off implies plan-edit', () => {
  const none = judged([]);
  assert.deepEqual([none.failed, none.off, verdict.verified(none)], [[], [], true]);
  const plumbing = judged(['a-core', 'a-look', 'a-test', 'a-rows', 'a-ask']);
  assert.deepEqual(plumbing.off, [], 'no fallback for plumbing, drawing, the tests, rows or a fallback itself');
  assert.equal(verdict.verified(plumbing), false);
  assert.deepEqual(judged(['a-tasks']).off, ['tasks']);
  assert.deepEqual(judged(['a-edit']).off, ['plan-edit']);
  assert.deepEqual(judged(['a-sign']).off, ['plan-edit', 'sign-off'], 'a plan edit goes through plan mode too');
  assert.deepEqual(judged(['a-sign', 'a-room', 'a-tasks', 'a-core']).off, ['room-session', 'tasks', 'plan-edit', 'sign-off'], 'GATED order');
  // an entry reported changed on the version counts as failed there, though the probe found it
  assert.deepEqual(judged([], '9.0.1').failed, ['a-later']);
  assert.deepEqual(judged([], '2.1.900').failed, []);
  assert.equal(judged(['a-tasks']).probedAt, '2026-10-17T00:00:00.000Z');
});

test('closeOff, parseCc and ccNotice: the one line, only when something is off', () => {
  assert.deepEqual(closeOff(['sign-off', 'bogus', 'tasks', 'tasks', 3]), ['tasks', 'plan-edit', 'sign-off']);
  assert.equal(isCcVersion('2.1.296'), true);
  assert.equal(isCcVersion('2.1.300-dev'), true);
  for (const bad of ['../x', '2.1', 'latest', '2.1.296/../../x', 2, null]) assert.equal(isCcVersion(bad), false, String(bad));
  assert.deepEqual(parseCc({ version: '2.1.302', verified: false, off: ['tasks', 'x'] }), { version: '2.1.302', verified: false, off: ['tasks'] });
  assert.deepEqual(parseCc({ version: '2.1.302', verified: 'yes' }), { version: '2.1.302', verified: null, off: [] });
  assert.equal(parseCc({ version: '../x' }), null);
  assert.equal(parseCc(null), null);
  assert.equal(ccNotice({ version: '2.1.302', verified: false, off: [] }), null);
  assert.equal(ccNotice(null), null);
  // only what SUB_HUMAN_CC_OFF forced: the line does not blame the version
  assert.equal(ccNotice({ version: '2.1.302', verified: false, off: ['tasks'], forced: ['tasks'] }), 'SUB_HUMAN_CC_OFF: the room task list is off (tasks are kept in the room).');
  assert.deepEqual(parseCc({ version: '2.1.302', verified: false, off: ['tasks'], forced: ['tasks', 'bogus'] }), { version: '2.1.302', verified: false, off: ['tasks'], forced: ['tasks'] });
  assert.equal(ccNotice({ version: '2.1.302', verified: false, off: ['tasks', 'plan-edit', 'sign-off'] }),
    "Claude Code 2.1.302 isn't verified with sub-human yet: the room task list is off (tasks are kept in the room), plan edits use the plan tool, sign-off is a question Claude Code asks you, not the plan view. sub-human doctor has details.");
  assert.match(must(ccNotice({ version: '2.1.296', verified: true, off: ['tasks'] })), /^SUB_HUMAN_CC_OFF: the room task list is off/);
  const out = { home: '/h', seat: null, cc: { version: '2.1.302', verified: false, off: ['sign-off'] } };
  assert.deepEqual(must(parseHello(JSON.stringify(out), 's1')).cc, { version: '2.1.302', verified: false, off: ['plan-edit', 'sign-off'] });
  assert.equal('cc' in must(parseHello(JSON.stringify({ home: '/h' }), 's1')), false, 'no version: no cc');
});

test('read, record and off: kept per version under the home; a changed contract checks again; SUB_HUMAN_CC_OFF forces', t => {
  const home = h.freshHome(t);
  assert.equal(verdict.file('../x'), null);
  assert.equal(verdict.file('2.1.290'), path.join(home, 'cc', '2.1.290.json'));
  assert.equal(verdict.read('2.1.290'), null);
  const v = must(verdict.record('2.1.290', ['task-file-schema', 'hooks-modules']));
  assert.deepEqual([v.failed, v.off], [['task-file-schema', 'hooks-modules'], ['tasks']], 'contract order');
  assert.deepEqual(verdict.read('2.1.290'), v);
  assert.equal(fs.statSync(must(verdict.file('2.1.290'))).mode & 0o777, 0o600);
  assert.equal(verdict.off('tasks', { version: '2.1.290' }), true);
  assert.equal(verdict.off('sign-off', { version: '2.1.290' }), false);
  assert.equal(verdict.off('tasks', { version: '2.1.291' }), false, 'no verdict: nothing off');
  // a verdict made with another contract is none
  const f = must(verdict.file('2.1.290'));
  fs.writeFileSync(f, JSON.stringify({ ...v, contract: '000000000000' }));
  assert.equal(verdict.read('2.1.290'), null);
  // the knob, on any version, closed
  const was = process.env.SUB_HUMAN_CC_OFF;
  t.after(() => { if (was === undefined) delete process.env.SUB_HUMAN_CC_OFF; else process.env.SUB_HUMAN_CC_OFF = was; });
  process.env.SUB_HUMAN_CC_OFF = ' sign-off ,nonsense';
  assert.deepEqual(verdict.forced(), ['plan-edit', 'sign-off']);
  assert.equal(verdict.off('plan-edit'), true);
  assert.equal(verdict.off('tasks'), false);
  assert.deepEqual(verdict.forced({ SUB_HUMAN_CC_OFF: 'tasks,room-session' }), ['room-session', 'tasks']);
});

test('off with no version: the session lease\'s, else the version last seen on this machine', t => {
  h.freshHome(t);
  verdict.record('2.1.290', ['task-file-schema']);
  assert.equal(verdict.seen(), null);
  assert.equal(verdict.off('tasks'), false, 'nothing seen yet');
  verdict.noteSeen('2.1.290');
  assert.equal(verdict.seen(), '2.1.290');
  assert.equal(verdict.off('tasks'), true);
  const sid = sidOf('0b9c6f8e-1111-4222-8333-444455550001');
  identity.writeModLease(sid, { pid: process.pid, ccVersion: '2.1.296' });
  assert.equal(verdict.sessionVersion(sid), '2.1.296');
  assert.equal(must(identity.readModLease(sid)).cc_version, '2.1.296');
  assert.equal(verdict.off('tasks', { sid }), false, 'the session runs 2.1.296, whatever was seen last');
  identity.writeModLease(sid, { pid: process.pid, ccVersion: '../../x' });
  assert.equal(must(identity.readModLease(sid)).cc_version, undefined, 'not a version: not kept');
});

test('ensure: the probed version is verified with no probe; another starts the runner, which probes only that version\'s binary', async t => {
  const home = h.freshHome(t);
  const p = must(verdict.ensure(contract.PROBED_VERSION));
  assert.deepEqual([p.failed, p.off], [[], []]);
  assert.ok(fs.existsSync(path.join(home, 'cc', `${contract.PROBED_VERSION}.json`)));
  const dir = h.tmpDir('sh-verdict-bin-', t);
  const was = process.env.CLAUDE_BIN;
  t.after(() => { if (was === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = was; });
  // another version's binary: nothing judged
  assert.equal(verdict.run('9.9.1', { env: { CLAUDE_BIN: fakeBinary(dir, '9.9.2'), PATH: '' } }), null);
  assert.equal(verdict.run('9.9.1', { env: { CLAUDE_BIN: path.join(dir, 'none'), PATH: '' } }), null, 'no binary');
  // the lock held: another runner is on it
  const f = must(verdict.file('9.9.1'));
  withLock(`${f}.lock`, () => { assert.equal(verdict.run('9.9.1', { env: { CLAUDE_BIN: fakeBinary(dir, '9.9.1'), PATH: '' } }), null); });
  assert.equal(fs.existsSync(f), false);
  // the misses above keep ensure from starting a runner for the hour: forget them
  fs.rmSync(`${f}.miss`, { force: true });
  // in the background, from ensure (as mod-hello calls it): the stand-in has one internal, so every gated feature falls back
  process.env.CLAUDE_BIN = fakeBinary(dir, '9.9.1');
  assert.equal(verdict.ensure('9.9.1'), null, 'never waits');
  await until(() => verdict.read('9.9.1') !== null);
  const v = must(verdict.read('9.9.1'));
  assert.ok(!v.failed.includes('env-clear-session-id') && v.failed.length === contract.CONTRACT.length - 1);
  assert.deepEqual(v.off, [...GATED]);
  assert.deepEqual(verdict.hello('9.9.1'), { version: '9.9.1', verified: false, off: [...GATED] });
  assert.deepEqual(verdict.hello('9.9.3'), { version: '9.9.3', verified: null, off: [] }, 'not checked yet');
});

test('run probes the session\'s own binary first; a version nothing here can read is not run again on every hello', async t => {
  h.freshHome(t);
  const dir = h.tmpDir('sh-verdict-own-', t);
  // the claude on PATH (CLAUDE_BIN here) is another version: the session's own executable is the one probed
  const v = must(verdict.run('9.8.1', { env: { CLAUDE_BIN: fakeBinary(dir, '9.8.0'), PATH: '' }, bin: fakeBinary(dir, '9.8.1') }));
  assert.equal(v.version, '9.8.1');
  // none of them is the version: nothing judged, and a miss is kept
  assert.equal(verdict.run('9.8.2', { env: { CLAUDE_BIN: fakeBinary(dir, '9.8.0'), PATH: '' }, bin: path.join(dir, 'gone') }), null);
  const f = must(verdict.file('9.8.2'));
  assert.ok(fs.existsSync(`${f}.miss`));
  // so ensure starts no runner for it for a while, even once a binary of it is on hand
  const was = process.env.CLAUDE_BIN;
  t.after(() => { if (was === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = was; });
  process.env.CLAUDE_BIN = fakeBinary(dir, '9.8.2');
  assert.equal(verdict.ensure('9.8.2'), null);
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(verdict.read('9.8.2'), null);
});

test('mod-hello: hands the module the version\'s verdict, keeps the version in the lease and as the one seen', async t => {
  const w = new World({ claude: 'sleep' }, { t });
  const sid = '0b9c6f8e-1111-4222-8333-444455550002';
  const r = w.hook('mod-hello', { session_id: sid, cc_version: contract.PROBED_VERSION });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(field(r.stdout, 'cc'), { version: contract.PROBED_VERSION, verified: true, off: [] });
  assert.equal(fileField(path.join(w.home, 'sessions', 'mods', `${sid}.json`), 'cc_version'), contract.PROBED_VERSION);
  assert.equal(fileField(path.join(w.home, 'cc', 'seen.json'), 'version'), contract.PROBED_VERSION);
  const forcedRun = w.hook('mod-hello', { session_id: sid, cc_version: contract.PROBED_VERSION }, { env: { SUB_HUMAN_CC_OFF: 'sign-off' } });
  assert.deepEqual(field(forcedRun.stdout, 'cc'), { version: contract.PROBED_VERSION, verified: true, off: ['plan-edit', 'sign-off'], forced: ['plan-edit', 'sign-off'] });
  // a version not checked here: verified null at once, the runner's verdict in the background
  const dir = h.tmpDir('sh-verdict-bin-', t);
  const fresh = w.hook('mod-hello', { session_id: sid, cc_version: '9.9.4' }, { env: { CLAUDE_BIN: fakeBinary(dir, '9.9.4'), PATH: '' } });
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.deepEqual(field(fresh.stdout, 'cc'), { version: '9.9.4', verified: null, off: [] });
  const file = path.join(w.home, 'cc', '9.9.4.json');
  await until(() => fs.existsSync(file));
  const again = w.hook('mod-hello', { session_id: sid, cc_version: '9.9.4' });
  assert.deepEqual(field(again.stdout, 'cc'), { version: '9.9.4', verified: false, off: [...GATED] });
  // no version (a module that could not read it): no cc, as before
  const plain: unknown = JSON.parse(w.hook('mod-hello', { session_id: sid }).stdout);
  assert.ok(isObj(plain) && !('cc' in plain));
});

test('exeOf: a live process\'s own executable (Linux /proc, else lsof on macOS), so the check probes the session\'s claude; none for no pid or a dead one', () => {
  const real = (p: string | null) => (p ? fs.realpathSync(p) : p);
  assert.equal(real(verdict.exeOf(process.pid)), fs.realpathSync(process.execPath));
  assert.equal(verdict.exeOf(null), null);
  assert.equal(verdict.exeOf(h.deadPid()), null);
});
