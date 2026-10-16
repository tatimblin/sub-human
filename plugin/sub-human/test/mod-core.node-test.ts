// The hooks module's pure core (mod/core/*.ts) in node, and hooks/handlers/mod-hello.ts. The module's wiring is tested by
// `npm run test:mods` (mod/test/*.test.ts under `claude plugin test`); this file needs no Claude Code binary,
// except the last test, which compares mod/register.ts HOOKS with what `claude plugin validate` reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { World } from './hooks/helpers.ts';
import * as room from '../lib/room.ts';
import * as tail from '../lib/tail.ts';
import * as identity from '../lib/identity.ts';
import type { Entry } from '../lib/room/types.ts';
import type { Hello, HelloSeat, RunOutput } from '../mod/core/types.ts';

/** A route action that carries text (submit, mid-turn-wake, log, append). */
type WithText = { text: string };

const PLUGIN = path.join(import.meta.dirname, '..');
/** The modules this file loads, by path under the plugin. */
interface Mods {
  'mod/core/chat.ts': typeof import('../mod/core/chat.ts');
  'mod/core/deliver.ts': typeof import('../mod/core/deliver.ts');
  'mod/core/facts.ts': typeof import('../mod/core/facts.ts');
  'mod/core/guard.ts': typeof import('../mod/core/guard.ts');
  'mod/core/prefilter.ts': typeof import('../mod/core/prefilter.ts');
  'mod/core/prompt.ts': typeof import('../mod/core/prompt.ts');
  'mod/core/seat.ts': typeof import('../mod/core/seat.ts');
  'mod/core/send.ts': typeof import('../mod/core/send.ts');
  'mod/core/shim.ts': typeof import('../mod/core/shim.ts');
  'mod/core/state.ts': typeof import('../mod/core/state.ts');
  'mod/register.ts': typeof import('../mod/register.ts');
}
const load = <K extends keyof Mods>(rel: K): Promise<Mods[K]> => import(path.join(PLUGIN, rel));

test('mod/ is pure: no node: or CommonJS imports, no dynamic import(), no seat key, no store writes', () => {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(x => x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]);
  const files = walk(path.join(PLUGIN, 'mod')).filter(f => /\.(mjs|ts)$/.test(f));
  assert.ok(files.length >= 8);
  const code = (f: string) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  for (const f of files.filter(x => !x.endsWith('.ts'))) {
    const src = code(f);
    assert.doesNotMatch(src, /from\s+['"]node:|require\(|\bimport\(/, f);
    assert.doesNotMatch(src, /from\s+['"][^'"]*seat-key|\$\.fs\.write\b/, f);
  }
  for (const f of files.filter(x => x.includes(`${path.sep}core${path.sep}`))) assert.doesNotMatch(code(f), /\$\./, `${f} uses $`);
});

// ---------- state ----------
test('state: every $.state reference in mod/ names a key in KEYS, and KEYS is what types/index.d.ts declares', async () => {
  const { KEYS } = await load('mod/core/state.ts');
  const used = new Set<string>();
  for (const f of fs.readdirSync(path.join(PLUGIN, 'mod')).filter(x => x.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(PLUGIN, 'mod', f), 'utf8');
    for (const m of src.matchAll(/\{ plugin: '([^']+)', key: '([^']+)' \}/g)) {
      assert.equal(m[1], 'sub-human', f);
      assert.ok(KEYS.includes(m[2]), `${f}: ${m[2]} is not in KEYS`);
      used.add(m[2]);
    }
  }
  assert.deepEqual([...used].sort(), [...KEYS].sort(), 'every key in KEYS is used');
  const types = fs.readFileSync(path.join(PLUGIN, 'types', 'index.d.ts'), 'utf8');
  const block = types.slice(types.indexOf("'sub-human': {"));
  const declared = [...block.matchAll(/^ {6}(\w+): /gm)].map(m => m[1]);
  assert.deepEqual(declared.sort(), [...KEYS].sort());
});

test('state: asHello is null when absent; asNonce only for its own session id; mintNonce is 32 fresh hex characters', async () => {
  const { asHello, asNonce, mintNonce, NONCE_RE } = await load('mod/core/state.ts');
  for (const v of [undefined, null, 'x', 3, false]) assert.equal(asHello(v), null, String(v));
  const h = { sid: 's1', home: '/h', seat: null };
  assert.equal(asHello(h), h);
  const n = mintNonce();
  assert.match(n, NONCE_RE);
  assert.notEqual(mintNonce(), n);
  assert.equal(asNonce({ sid: 's1', value: n }, 's1'), n);
  assert.equal(asNonce({ sid: 's1', value: n }, 's2'), null, 'another session id (a /clear)');
  for (const v of [undefined, null, { sid: 's1' }, { sid: 's1', value: 'short' }, { sid: 's1', value: n.toUpperCase() }]) assert.equal(asNonce(v, 's1'), null);
  assert.equal(asNonce({ sid: 's1', value: n }, undefined), null);
});

test('guard: the write tools hooked in mod/guard.ts are mod/core/guard.ts WRITE_TOOLS, and HOOKS says the same', async () => {
  const { WRITE_TOOLS } = await load('mod/core/guard.ts');
  const { HOOKS } = await load('mod/register.ts');
  const src = fs.readFileSync(path.join(PLUGIN, 'mod', 'guard.ts'), 'utf8');
  assert.ok(src.includes(`on('tool.call', { tool: [${WRITE_TOOLS.map(t => `'${t}'`).join(', ')}] }`), 'the matcher literal');
  assert.ok(HOOKS.some(h => h.file === 'mod/guard.ts' && h.matcher === WRITE_TOOLS.join('|')));
});

// ---------- seat ----------
test('seat: parseHello keeps a good answer, refuses anything else; parseAddr reads NAME.CODE', async () => {
  const { parseHello, parseAddr, seated } = await load('mod/core/seat.ts');
  const out = { home: '/h', realHome: '/private/h', userHome: '/u', pluginRoot: '/p', seat: { name: 'alice', code: 'otter-4821', role: 'member' } };
  assert.deepEqual(parseHello(JSON.stringify(out) + '\n', 's1'), { sid: 's1', ...out, seat: { ...out.seat, addr: 'alice.otter-4821' }, restorable: false, pending: false });
  assert.equal(parseHello(JSON.stringify({ ...out, restorable: true }), 's1')!.restorable, true);
  assert.equal(parseHello(JSON.stringify({ ...out, pending: true }), 's1')!.pending, true);
  assert.equal(parseHello(JSON.stringify({ ...out, pending: 'yes' }), 's1')!.pending, false, 'only true is true');
  assert.equal(parseHello('', 's1'), null);
  assert.equal(parseHello('not json', 's1'), null);
  assert.equal(parseHello(JSON.stringify({ home: 'relative' }), 's1'), null);
  const bad = parseHello(JSON.stringify({ ...out, seat: { name: '../x', code: 'otter-4821' } }), 's1');
  assert.ok(bad);
  assert.equal(bad.seat, null);
  assert.equal(seated(bad), false);
  assert.equal(parseHello(JSON.stringify({ home: '/h' }), null)!.realHome, '/h');
  assert.deepEqual(parseAddr('bob.otter-4821'), { name: 'bob', code: 'otter-4821' });
  assert.deepEqual(parseAddr('b.o.b.otter-4821'), { name: 'b.o.b', code: 'otter-4821' });
  for (const x of ['bob', 'Bob session', 'bob.otter-48', '.otter-4821', null, 42]) assert.equal(parseAddr(x), null, String(x));
});

// ---------- shim ----------
test('shim: the stdout -> ClassicResult table covers every output shape the hooks emit today', async () => {
  const { toClassic, shimEnv, shimArgv } = await load('mod/core/shim.ts');
  const ok = (o: unknown, extra = {}): RunOutput => ({ exitCode: 0, stdout: (typeof o === 'string' ? o : JSON.stringify(o)) + '\n', stderr: '', ...extra });
  const T: [string, string, RunOutput, unknown][] = [
    // [what, event, run, expected {result, systemMessage?}]
    ['at-room ✓ sent', 'UserPromptSubmit',
      ok({ continue: false, stopReason: "✓ sent to room otter-4821 (Claude wasn't asked)", hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'alice.otter-4821' } }),
      { result: { preventContinuation: true, stopReason: "✓ sent to room otter-4821 (Claude wasn't asked)", sessionTitle: 'alice.otter-4821' } }],
    ['at-room refusal', 'UserPromptSubmit',
      ok({ decision: 'block', reason: '✗ not posted: x', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true } }),
      { result: { block: '✗ not posted: x', suppressOriginalPrompt: true } }],
    ['at-room digest + notices + title', 'UserPromptSubmit',
      ok({ systemMessage: 'bob joined', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Room since your last turn: …', sessionTitle: 'alice.otter-4821' } }),
      { result: { additionalContext: ['Room since your last turn: …'], sessionTitle: 'alice.otter-4821' }, systemMessage: 'bob joined' }],
    ['prompt.ts title only', 'UserPromptSubmit',
      ok({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'alice.otter-4821' } }),
      { result: { sessionTitle: 'alice.otter-4821' } }],
    ['consent Stop nudge', 'Stop',
      ok({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'A review is open.' } }),
      { result: { additionalContext: ['A review is open.'] } }],
    ['join', 'UserPromptExpansion',
      ok({ systemMessage: 'sub-human: joined otter-4821', hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: 'ROOM …' } }),
      { result: { additionalContext: ['ROOM …'] }, systemMessage: 'sub-human: joined otter-4821' }],
    ['join refused', 'UserPromptExpansion', ok({ decision: 'block', reason: 'sub-human: name taken' }), { result: { block: 'sub-human: name taken' } }],
    ['session-restore', 'SessionStart',
      ok({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ROOM …', sessionTitle: 'alice.otter-4821' } }),
      { result: { additionalContext: ['ROOM …'], sessionTitle: 'alice.otter-4821' } }],
    ['row-hold', 'SubagentStop', ok({ decision: 'block', reason: 'Call hold again.' }), { result: { block: 'Call hold again.' } }],
    ['tasks exit 2', 'TaskCompleted', { exitCode: 2, stdout: '', stderr: 'only the room\'s Claude completes task 1\n' }, { result: { block: 'only the room\'s Claude completes task 1' } }],
    ['tasks exit 2 (PostToolUse)', 'PostToolUse', { exitCode: 2, stdout: '', stderr: 'dropped' }, { result: { block: 'dropped' } }],
    ['no output', 'UserPromptSubmit', ok(''), { result: {} }],
    ['plain stdout', 'SessionStart', ok('plain words'), { result: { additionalContext: ['plain words'] } }],
    ['plain stdout where no context is read', 'TaskCompleted', ok('plain words'), { result: {} }],
    ['a crash (exit 1)', 'UserPromptSubmit', { exitCode: 1, stdout: '{"continue":false}', stderr: 'boom' }, { result: {} }],
    ['a field the event does not read is dropped', 'Stop',
      ok({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'x', sessionTitle: 't', suppressOriginalPrompt: true } }),
      { result: { additionalContext: ['x'] } }],
    ['a log line before the JSON', 'UserPromptSubmit', ok('warming up\n{"continue":false,"stopReason":"✓ sent; the room\u0027s Claude was woken"}'),
      { result: { preventContinuation: true, stopReason: "✓ sent; the room's Claude was woken" } }],
  ];
  for (const [what, event, run, want] of T) assert.deepEqual(toClassic(event, run), want, what);
  assert.deepEqual(shimEnv({ session_id: 's1' }, '/p'), { CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PID: '', SUB_HUMAN_VIA: 'module', CLAUDE_CODE_SESSION_ID: 's1' });
  assert.deepEqual(shimEnv({}, '/p'), { CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PID: '', SUB_HUMAN_VIA: 'module' });
  assert.deepEqual(shimArgv('/p', 'prompt'), ['node', '--import', '/p/hooks/compile-cache.js', '/p/hooks/run.ts', 'prompt']);
});

test('shim: a real hook\'s output translates (at-room posting through prompt.ts)', async t => {
  const { toClassic } = await load('mod/core/shim.ts');
  const w = new World({ claude: 'sleep', alice: 'act' }, { t });
  const nonce = 'f00d'.repeat(8);
  w.lib(() => identity.writeModLease(w.sid.alice, { nonce }));
  const r = w.hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: '@room hello', sub_human_origin: 'composer', sub_human_nonce: nonce, transcript_path: '' }, { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  const { result } = toClassic('UserPromptSubmit', { exitCode: r.code, stdout: r.stdout, stderr: r.stderr });
  assert.equal(result.preventContinuation, true);
  assert.match(result.stopReason!, /^✓ sent/);
});

test('shim: subHuman (a hook run with SUB_HUMAN_SHIM=1) comes out beside the result', async () => {
  const { toClassic, SHIM_MODE } = await load('mod/core/shim.ts');
  const ok = (o: unknown): RunOutput => ({ exitCode: 0, stdout: JSON.stringify(o) + '\n', stderr: '' });
  assert.deepEqual(SHIM_MODE, { SUB_HUMAN_SHIM: '1' });
  assert.deepEqual(toClassic('Stop', ok({ subHuman: { reviewOpen: false } })), { result: {}, subHuman: { reviewOpen: false } });
  assert.deepEqual(toClassic('Stop', ok({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'exit' }, subHuman: { reviewOpen: true } })),
    { result: { additionalContext: ['exit'] }, subHuman: { reviewOpen: true } });
  assert.deepEqual(toClassic('Stop', ok({ subHuman: [true] })), { result: {} });
});

// ---------- prompt ----------
test('prompt: the gate drops only an @room that no person typed', async () => {
  const p = await load('mod/core/prompt.ts');
  assert.equal(p.gateVerdict({ text: '@room x', origin: { kind: 'composer' } }, undefined), null);
  assert.equal(p.gateVerdict({ text: 'plain', origin: { kind: 'peer' } }, undefined), null);
  assert.match(p.gateVerdict({ text: '@room x', origin: { kind: 'peer' } }, undefined)!, /another Claude session/);
  assert.match(p.gateVerdict({ text: '@room x', origin: { kind: 'plugin', name: 'other' } }, undefined)!, /"plugin"/);
  assert.equal(p.gateVerdict({ text: 'room:x', origin: { kind: 'plugin', name: 'other' } }, undefined), null, 'room: is no tag');
  assert.equal(p.isAtRoom('@room'), true);
  assert.equal(p.isAtRoom('room'), false);
});

test('prompt: a seated session gates an untyped @claude like an @room, an unseated one lets it through', async () => {
  const p = await load('mod/core/prompt.ts');
  assert.equal(p.parseClaude('@room @claude x'), null, 'only a leading tag');
  assert.equal(p.parse('@room @claude x'), '@claude x', 'a plain @room post');
  // hellos as the core reads them: sid and seat only
  const seated = { sid: 's1', seat: { name: 'alice', code: 'otter-4821', role: 'member', addr: 'alice.otter-4821' } } as Hello;
  const unseated = { sid: 's1', seat: null } as Hello;
  const peer = { text: '@claude plan it', origin: { kind: 'peer' } };
  assert.match(p.gateVerdict(peer, seated)!, /^✗ not posted: this @claude came from another Claude session/);
  assert.equal(p.gateVerdict(peer, unseated), null, 'outside a room @claude is a plain prompt');
  assert.equal(p.gateVerdict(peer, null), null, 'no hello: at-room decides');
  assert.equal(p.gateVerdict({ ...peer, origin: { kind: 'composer' } }, seated), null);
  assert.equal(p.gateVerdict({ text: 'ask @claude', origin: { kind: 'peer' } }, seated), null);
  assert.deepEqual(p.failClosed('@claude ship it', seated), { block: p.NO_ORIGIN.replace('@room', '@claude'), suppressOriginalPrompt: true });
  assert.equal(p.failClosed('@claude ship it', unseated), null);
  assert.equal(p.failClosed('@claude ship it'), null);
  const e = (prompt: string) => ({ session_id: 's1', prompt });
  assert.equal(p.needsNode(e('@claude hi'), unseated), false, 'unseated: an ordinary prompt, no node');
  assert.equal(p.needsNode(e('@claude hi'), seated, { delivering: true, reviewFlag: false }), true, 'the post is signed in node');
});

test('prompt: needsNode skips node only for a surely unseated session and a prompt that is not an @room', async () => {
  const { needsNode } = await load('mod/core/prompt.ts');
  const seat: HelloSeat = { name: 'alice', code: 'otter-4821', role: 'member', addr: 'alice.otter-4821' };
  const e = (prompt: string, sid = 's1') => ({ session_id: sid, prompt });
  assert.equal(needsNode(e('hi'), { sid: 's1', seat: null } as Hello), false);
  assert.equal(needsNode(e('/sub-human alice'), { sid: 's1', seat: null } as Hello), false);
  assert.equal(needsNode(e('@room hi'), { sid: 's1', seat: null } as Hello), true, 'node refuses it: not in a room');
  assert.equal(needsNode(e('hi'), { sid: 's1', seat } as Hello), true);
  assert.equal(needsNode(e('hi'), { sid: 's0', seat: null } as Hello), true, 'another session\'s hello (a /clear not refreshed yet)');
  assert.equal(needsNode(e('hi'), { sid: null, seat: null } as Hello), true, 'a failed refresh');
  assert.equal(needsNode(e('hi'), null), true, 'no hello yet');
});

test('prompt: a seated member skips node only while the tail child delivers and no review may be open; never the room\'s Claude', async () => {
  const { needsNode, originKind } = await load('mod/core/prompt.ts');
  const seat: HelloSeat = { name: 'alice', code: 'otter-4821', role: 'member', addr: 'alice.otter-4821' };
  const hello = { sid: 's1', seat } as Hello; // sid and seat only
  const e = (prompt: string) => ({ session_id: 's1', prompt });
  assert.equal(needsNode(e('hi'), hello, { delivering: true, reviewFlag: false }), false);
  assert.equal(needsNode(e('hi'), hello, { delivering: false, reviewFlag: false }), true, 'no tail child yet: unsure, node runs');
  assert.equal(needsNode(e('hi'), hello, { delivering: true, reviewFlag: true }), true, 'a review may be open');
  assert.equal(needsNode(e('hi'), hello, { delivering: true }), true, 'flag unset: unsure');
  assert.equal(needsNode(e('@room hi'), hello, { delivering: true, reviewFlag: false }), true, 'the post is signed in node');
  assert.equal(needsNode(e('hi'), { sid: 's1', seat: { ...seat, role: 'claude' } } as Hello, { delivering: true, reviewFlag: false }), true, 'the room\'s Claude: its refusal is node\'s');
  assert.equal(originKind({ kind: 'composer' }), 'composer');
  assert.equal(originKind({ kind: 'plugin', name: 'sub-human' }), 'plugin:sub-human');
  assert.equal(originKind({ kind: 'plugin' }), 'plugin');
  assert.equal(originKind(undefined), undefined);
});

// ---------- delivery (mod/core/deliver.ts) ----------
test('deliver: the child\'s argv and env; lines out of pieces; only well-formed events', async () => {
  const d = await load('mod/core/deliver.ts');
  assert.deepEqual(d.tailArgv('/p'), ['node', '/p/scripts/sub-human', 'tail', '--ndjson']);
  assert.deepEqual(d.tailEnv('sid-1', '/p'), { CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PID: '', CLAUDE_CODE_SESSION_ID: 'sid-1' });
  assert.equal(d.PULL_DELIVERY, 'at-most-once');
  const b = d.lineBuffer();
  assert.deepEqual(b.push('{"type":"chat","li'), []);
  assert.deepEqual(b.push('nes":["bob: hi"]}\n{"type":"rows","text":null}\n{"ty'), ['{"type":"chat","lines":["bob: hi"]}', '{"type":"rows","text":null}']);
  assert.equal(b.pending, '{"ty');
  assert.deepEqual(d.parseEvent('{"type":"chat","lines":["bob: hi"]}'), { type: 'chat', lines: ['bob: hi'] });
  assert.deepEqual(d.parseEvent('{"type":"rows","text":""}'), { type: 'rows', text: null });
  assert.deepEqual(d.parseEvent('{"type":"seat","seat":null}'), { type: 'seat', seat: null });
  assert.equal(d.parseEvent('{"type":"wake"}'), null);
  assert.equal(d.parseEvent('{"type":"exec","text":"rm"}'), null);
  assert.equal(d.parseEvent('not json'), null);
  // the tail's own event writer and this parser agree
  // a stub ctx: an empty batch reads none of it
  const ctx = { me: { name: 'alice', role: 'member' }, room: {}, entries: [], show: () => false, joinNote: () => '', seen: new Set() };
  const { events } = tail.formatNdBatch([], ctx as unknown as Parameters<typeof tail.formatNdBatch>[1]);
  assert.deepEqual(events, []);
  for (const ev of [{ type: 'chat', lines: ['bob: hi'] }, { type: 'pull', text: tail.PULL_HEAD + '\nbob: hi' }, { type: 'wake', text: 'x' }, { type: 'health', text: 'room log check: x' }])
    assert.deepEqual(d.parseEvent(JSON.stringify(ev)), ev);
});

test('deliver: the routing table: chat is a notice, pull held for the next prompt, wake a prompt when idle and an append mid-turn', async () => {
  const d = await load('mod/core/deliver.ts');
  // one $.ui.log per line: a notice is one line (a newline would be drawn as U+FFFD)
  assert.deepEqual(d.route({ type: 'chat', lines: ['bob: hi', '  │ more', 'carol joined'] }), [{ do: 'log', text: 'bob: hi' }, { do: 'log', text: '  │ more' }, { do: 'log', text: 'carol joined' }]);
  assert.deepEqual(d.route({ type: 'pull', text: 'Room since…' }), [{ do: 'hold-pull', text: 'Room since…' }], 'stage 8e B: never a user row of its own');
  assert.deepEqual(d.route({ type: 'rows', text: null }), [{ do: 'hold-rows', text: null }]);
  assert.deepEqual(d.route({ type: 'seat', seat: null }), [{ do: 'seat', seat: null }]);
  const idle = d.route({ type: 'wake', text: 'room: decided\n(for Claude) room now: …' });
  assert.deepEqual(idle, [{ do: 'submit', text: `${d.WAKE_HEAD}\nroom: decided\n(for Claude) room now: …`, seen: ['room: decided'] }]);
  const { gateVerdict } = await load('mod/core/prompt.ts');
  assert.equal(gateVerdict({ text: (idle[0] as WithText).text, origin: { kind: 'plugin', name: 'sub-human' } }, undefined), null, 'a wake never reads as a "room:" post');
  const mid = d.route({ type: 'wake', text: 'room: decided\n(for Claude) room now: …' }, { turnRunning: true });
  assert.deepEqual(mid, [{ do: 'log', text: 'room: decided' }, { do: 'mid-turn-wake', text: (idle[0] as WithText).text }]);
  const roomClaude = d.route({ type: 'wake', text: 'room now: …' }, { role: 'claude', rows: 'SUB-HUMAN ROWS: …' });
  assert.equal((roomClaude[0] as WithText).text, `${d.WAKE_HEAD}\nroom now: …\nSUB-HUMAN ROWS: …`, 'the room\'s Claude\'s rows ride on its wakes');
  assert.equal((d.route({ type: 'wake', text: 'x' }, { role: 'member', rows: 'R' })[0] as WithText).text.includes('R'), false, 'a member\'s go with the person\'s prompt');
  assert.deepEqual(d.route({ type: 'health', text: 'room log check: …' }).map(a => a.do), ['log', 'append']);
  assert.deepEqual(d.route(null), []);
});

test('deliver: unread, restartDelay, spawnWanted', async () => {
  const d = await load('mod/core/deliver.ts');
  const wakes = [{ text: 'during a tool', at: 100 }, { text: 'during the last request', at: 300 }];
  assert.deepEqual(d.unread(wakes, 200), ['during the last request'], 'a tool call finished after the first: a request carried it');
  assert.deepEqual(d.unread(wakes, 0), ['during a tool', 'during the last request'], 'no tool call this turn: none was carried');
  assert.deepEqual(d.unread(wakes, 400), []);
  assert.deepEqual(d.unread(null, 0), []);
  assert.deepEqual([0, 1, 2, 6, 7, 20].map(d.restartDelay), [1000, 2000, 4000, 60_000, 60_000, 60_000]);
  assert.equal(d.spawnWanted(null), true, 'unsure: start it');
  assert.equal(d.spawnWanted({ seat: null } as Hello), false); // a hello as spawnWanted reads it: the seat only
  assert.equal(d.spawnWanted({ seat: { name: 'a' } } as Hello), true);
  assert.equal(d.spawnWanted({ seat: null, pending: true } as Hello), true, 'a PIN join waiting for the host\'s card: its tail says when it let them in');
});

test('prompt: the origin queue hands prompt.submit\'s origin to the classic hook; mergeClassic keeps ours on top', async () => {
  const { originQueue, mergeClassic } = await load('mod/core/prompt.ts');
  const q = originQueue();
  assert.equal(q.take('@room x'), null, 'nothing waiting: at-room keeps its own checks');
  const a = q.push('@room x', 'composer');
  assert.equal(q.take('@room x'), 'composer');
  assert.equal(q.take('@room x (the classic payload spelled it differently)'), null, 'no text match: unsure, never the only one waiting');
  const b = q.push('later', 'peer');
  assert.equal(q.take('later'), 'peer');
  assert.equal(q.take('neither'), null, 'two waiting and no text match: unsure');
  q.drop(a); q.drop(b); q.drop(b);
  assert.equal(q.size, 0);
  assert.deepEqual(mergeClassic({ preventContinuation: true, stopReason: "✓ sent to room otter-4821 (Claude wasn't asked)", sessionTitle: 'a.b' }, { additionalContext: ['theirs'], sessionTitle: 'x' }),
    { preventContinuation: true, stopReason: "✓ sent to room otter-4821 (Claude wasn't asked)", sessionTitle: 'a.b', additionalContext: ['theirs'] });
  assert.deepEqual(mergeClassic({ additionalContext: ['ours'] }, { additionalContext: ['theirs'], block: 'no' }), { additionalContext: ['ours', 'theirs'], block: 'no' });
  assert.deepEqual(mergeClassic({ block: 'mine', suppressOriginalPrompt: true }, {}), { block: 'mine', suppressOriginalPrompt: true });
  assert.deepEqual(mergeClassic({}, undefined), {});
});

// ---------- prefilter ----------
test('prefilter: consent and the task hooks are skipped only when sure', async () => {
  const f = await load('mod/core/prefilter.ts');
  // hellos as the prefilter reads them: sid and seat only
  const member = { sid: 's1', seat: { name: 'alice', code: 'otter-4821', role: 'member' } } as Hello;
  const roomClaude = { sid: 's1', seat: { name: 'claude', code: 'otter-4821', role: 'claude' } } as Hello;
  const none = { sid: 's1', seat: null } as Hello;
  assert.equal(f.consentNeeded(none, 's1', undefined), false, 'no seat: no review');
  assert.equal(f.consentNeeded(member, 's1', undefined), true, 'flag unset: unsure');
  assert.equal(f.consentNeeded(member, 's1', true), true);
  assert.equal(f.consentNeeded(member, 's1', false), false);
  assert.equal(f.consentNeeded(none, 's2', false), false, 'the flag alone is enough');
  assert.equal(f.consentNeeded(none, 's2', undefined), true, 'another session\'s hello');
  assert.equal(f.consentNeeded(null, 's1', undefined), true);
  assert.equal(f.tasksNeeded(member, 's1', undefined), false);
  assert.equal(f.tasksNeeded(roomClaude, 's1', undefined), true);
  assert.equal(f.tasksNeeded(none, 's1', undefined), false);
  assert.equal(f.tasksNeeded(none, 's1', 'otter-4821'), true, 'a room Claude before its join');
  assert.equal(f.tasksNeeded(member, 's2', undefined), true);
  assert.equal(f.tasksNeeded({ ...member, sid: null }, null, undefined), true);
  assert.equal(f.tasksNeeded(null, 's1', undefined), true);
  assert.equal(f.reviewOpenOf({ reviewOpen: false }), false);
  assert.equal(f.reviewOpenOf({ reviewOpen: 'no' }), undefined);
  assert.equal(f.reviewOpenOf(undefined), undefined);
});

// ---------- chat ----------
test('chat: a peer message is "NAME\'s Claude: …" with nested continuation lines; room lines show (for Claude) as a dim marker', async () => {
  const { peerLines, roomRows, NEST } = await load('mod/core/chat.ts');
  assert.deepEqual(peerLines('bob.otter-4821', '  done\n\nnext: tests  \n'), ["bob's Claude: done", `${NEST}next: tests`]);
  assert.deepEqual(peerLines('bob.otter-4821', ''), ["bob's Claude"]);
  assert.equal(peerLines('Some session', 'hi'), null);
  assert.equal(peerLines(undefined, 'hi'), null);
  const many = Array.from({ length: 25 }, (_, i) => `l${i}`).join('\n');
  const out = peerLines('bob.otter-4821', many);
  assert.ok(out);
  assert.equal(out.length, 21);
  assert.equal(out.at(-1), `${NEST}[+5 more lines: ctrl+o]`);
  assert.deepEqual(peerLines('bob.otter-4821', 'a‮b\u0007c\r\nd'), ["bob's Claude: abc", `${NEST}d`]);
  const plain = (t: string) => ({ text: t, dim: false });
  assert.deepEqual(roomRows('bob: hi\n  │ more\n(for Claude) room now: no proposals\ncarol joined'),
    [plain('bob: hi'), plain('  │ more'), { text: '(for Claude) room now: no proposals', dim: true }, plain('carol joined')]);
  assert.equal(roomRows('(for Claude) x'), null, 'nothing but lines for Claude: the engine draws the row');
  // a run is one marker, its first line cut, "(+N)" for the rest
  const long = `(for Claude) ${'x'.repeat(100)}`;
  const rows = roomRows(`${long}\n(for Claude) b\n(for Claude) c\nbob: hi`)!;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dim, true);
  assert.match(rows[0].text, /^\(for Claude\) x+… \(\+2\)$/);
  assert.ok(rows[0].text.length <= 72 + ' (+2)'.length);
  assert.deepEqual(rows[1], plain('bob: hi'));
});

test('chat: the room\'s own chatLines come through roomLines unchanged', async () => {
  const { roomRows } = await load('mod/core/chat.ts');
  const e = { id: 7, from: 'bob', via: 'human', kind: 'say', to: 'room', text: 'sure\nonce we agree' } as Entry; // no at: chatLines does not read it
  const lines = room.chatLines(e, { viewer: 'alice' });
  assert.deepEqual(roomRows(lines.join('\n'))!.map(r => r.text), lines);
});

// ---------- guard ----------
test('guard: write targets, ancestors and the verdict before and after mod-hello', async () => {
  const g = await load('mod/core/guard.ts');
  assert.equal(g.normalize('/a/b/../c/./d/'), '/a/c/d');
  assert.equal(g.normalize('/..'), '/');
  assert.deepEqual(g.ancestors('/a/b'), ['/a/b', '/a', '/']);
  assert.equal(g.absTarget('~/x', { userHome: '/u' }), '/u/x');
  assert.equal(g.absTarget('~/x', {}), null);
  assert.equal(g.absTarget('x/../y', { cwd: '/w' }), '/w/y');
  assert.equal(g.writeTarget({ notebook_path: '/n.ipynb' }), '/n.ipynb');
  const ctx = { home: '/h/store', realHome: '/private/h/store' };
  assert.ok(g.writeVerdict(['/h/store/rooms/x'], ctx));
  assert.ok(g.writeVerdict(['/tmp/link/x', '/private/h/store/x'], ctx));
  assert.equal(g.writeVerdict(['/h/store2/x', '/h/storex'], ctx), null);
  assert.equal(g.writeVerdict(['/u/.sub-human/x'], ctx), null, 'a known home is the only store');
  assert.ok(g.writeVerdict(['/u/.sub-human/x'], {}), 'before hello: the .sub-human spelling');
  assert.ok(g.writeVerdict([], {}, '~/.sub-human/rooms/x'));
  assert.equal(g.writeVerdict(['/w/.sub-human-notes.md'], {}), null);
  assert.deepEqual(g.roomToolVerdict({ tool: g.HOLD }, true), { decision: 'deny', reason: g.HOLD_DENY });
  assert.deepEqual(g.roomToolVerdict({ tool: g.HOLD, agentId: 'a1' }, true), { decision: 'allow', reason: g.ROOM_ALLOW });
  assert.equal(g.roomToolVerdict({ tool: g.MCP_PREFIX + 'post' }, false), null);
  assert.equal(g.roomToolVerdict({ tool: 'Bash' }, true), null);
  assert.equal(g.failClosed({ tool: 'Write', file_path: '/x/sub-human/y' }), true);
  assert.equal(g.failClosed({ tool: 'Write', file_path: '/x/y' }), false);
});

test('guard: the plugin-code rule reads the cwd only when the command does not name the plugin', async () => {
  const g = await load('mod/core/guard.ts');
  assert.equal(g.needsCwd('node hooks/consent.ts'), true);
  assert.equal(g.needsCwd('node hooks/consent.js'), true); // the name before the TypeScript migration
  assert.equal(g.needsCwd('node mcp/room-server.js'), true);
  assert.equal(g.needsCwd('node /x/sub-human/hooks/consent.ts'), false);
  assert.equal(g.needsCwd('npm test'), false);
  const inPlugin = { pluginRoot: '/repo/plugin/sub-human', cwd: '/repo/plugin/sub-human/hooks' };
  assert.ok(g.bashVerdict('node consent.ts && node hooks/consent.ts', inPlugin));
  assert.equal(g.bashVerdict('node hooks/consent.ts', { ...inPlugin, cwd: '/elsewhere' }), null);
  assert.ok(g.bashVerdict('node hooks/consent.ts', { ...inPlugin, cwd: '/elsewhere', realCwd: '/repo/plugin/sub-human' }));
});

test('guard: the person-only CLI is sent to a terminal outside Claude Code, never to its ! mode (the PIN would land in the conversation)', async () => {
  const g = await load('mod/core/guard.ts');
  const why = g.bashVerdict('sub-human invite --ssh');
  assert.match(why!, /in a terminal outside Claude Code, never with !/);
  assert.doesNotMatch(why!, /in your own shell/);
});

// ---------- mod-hello ----------
test('send: SendMessage to a seat on another machine goes through the room; everything else passes on', async () => {
  const { remotePeer, postArgs, postResult } = await load('mod/core/send.ts');
  const seat: HelloSeat = { name: 'jess', code: 'vole-8126', role: 'member', addr: 'jess.vole-8126' };
  const members = {
    alice: { name: 'alice', machine: 'aaaa' },
    claude: { name: 'claude', role: 'claude', machine: 'aaaa' },
    jess: { name: 'jess', machine: 'bbbb' },
    kim: { name: 'kim', machine: 'bbbb' },
    gone: { name: 'gone', machine: 'aaaa', left_at: '2026-10-12T00:00:00Z' },
    old: { name: 'old' }, // before machine ids: never judged remote
  };
  assert.equal(remotePeer('alice.vole-8126', seat, members, 'bbbb'), 'alice');
  assert.equal(remotePeer('claude.vole-8126', seat, members, 'bbbb'), 'claude', "the room's Claude runs on the host");
  assert.equal(remotePeer('kim.vole-8126', seat, members, 'bbbb'), null, 'same machine: the native send');
  assert.equal(remotePeer('jess.vole-8126', seat, members, 'bbbb'), null, 'never to myself');
  assert.equal(remotePeer('alice.otter-4821', seat, members, 'bbbb'), null, 'another room');
  assert.equal(remotePeer('gone.vole-8126', seat, members, 'bbbb'), null, 'a seat that left');
  assert.equal(remotePeer('old.vole-8126', seat, members, 'bbbb'), null);
  assert.equal(remotePeer('nobody.vole-8126', seat, members, 'bbbb'), null);
  assert.equal(remotePeer('alice', seat, members, 'bbbb'), null, 'not an address');
  assert.equal(remotePeer('alice.vole-8126', null, members, 'bbbb'), null, 'no seat');
  assert.equal(remotePeer('alice.vole-8126', seat, null, 'bbbb'), null, 'no members document');
  assert.equal(remotePeer('alice.vole-8126', seat, members, undefined), null, 'no machine id');
  assert.deepEqual(postArgs('alice', 'hi?'), { kind: 'say', to: 'alice', text: 'hi?' });
  assert.deepEqual(postResult('alice', { content: [{ type: 'text', text: '{"id":7}' }] }), { isDelivered: true });
  assert.deepEqual(postResult('alice', { isError: true, content: [{ type: 'text', text: 'refused: rate' }] }),
    { isDelivered: false, reason: 'Not sent to alice (on another machine, reached through the room): refused: rate' });
});

test('mod-hello: prints the home and this session\'s seat, and writes the lease (0600)', t => {
  const w = new World({ claude: 'sleep', alice: 'act' }, { t });
  const r = w.hook('mod-hello', {}, { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, {
    home: w.home, realHome: fs.realpathSync(w.home), userHome: w.userHome, pluginRoot: PLUGIN,
    seat: { name: 'alice', code: w.code, role: 'member', addr: `alice.${w.code}` }, restorable: true, pending: false,
  });
  const lease = path.join(w.home, 'sessions', 'mods', `${w.sid.alice}.json`);
  assert.equal(fs.statSync(lease).mode & 0o777, 0o600);
  const rec = JSON.parse(fs.readFileSync(lease, 'utf8'));
  assert.equal(rec.session_id, w.sid.alice);
  assert.equal(rec.seat, undefined, 'the seat is in the hello, not the lease');
  assert.deepEqual(w.lib(() => identity.readModLease(w.sid.alice)), rec);
});

test('mod-hello: an unseated session gets seat null (and a lease); a bad payload gets no lease', t => {
  const w = new World({ claude: 'sleep' }, { t });
  const sid = '0b9c6f8e-1111-4222-8333-444455556666';
  const r = w.hook('mod-hello', { session_id: sid });
  assert.equal(r.code, 0, r.stderr);
  const hello = r.json as unknown as Hello; // mod-hello prints a hello, not a hook answer
  assert.equal(hello.seat, null);
  assert.equal(hello.restorable, false, 'no seat for this session id, and none for this process');
  assert.equal(hello.pending, false, 'no join of this session waits for a host');
  assert.equal(hello.home, w.home);
  assert.ok(fs.existsSync(path.join(w.home, 'sessions', 'mods', `${sid}.json`)));
  const bad = w.hook('mod-hello', { session_id: '../../x' });
  assert.equal(bad.code, 0, bad.stderr);
  assert.equal((bad.json as unknown as Hello).seat, null);
  assert.ok(!fs.existsSync(path.join(w.home, 'sessions', 'mods', '..')) || !fs.readdirSync(path.join(w.home, 'sessions', 'mods')).some(f => f.includes('x')));
});

// ---------- the module, as validate reads it ----------
const validate = spawnSync('claude', ['plugin', 'validate', PLUGIN, '--strict', '--json'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: process.env.HOME || os.homedir() } });
/** The parts of `claude plugin validate --json` this reads. */
interface ValidateReport {
  success: boolean;
  contents: { type: string; gatingHooks?: { hook: string; pattern: string; hasCatch: boolean }[]; notes: string[] }[];
}
const haveClaude = !validate.error && /^\s*\{/.test(validate.stdout || '');

test('validate: the module loads, every gating hook has a .catch, and HOOKS lists exactly what it registers', { skip: !haveClaude && 'no claude binary' }, async () => {
  const report: ValidateReport = JSON.parse(validate.stdout);
  assert.equal(report.success, true, validate.stdout);
  const hooksReport = report.contents.find(c => c.type === 'hooks')!;
  const gating = hooksReport.gatingHooks || [];
  assert.ok(gating.length >= 4);
  assert.deepEqual(gating.filter(x => !x.hasCatch).map(x => x.hook), []);
  const line = hooksReport.notes.find(n => / hooks: /.test(n))!;
  // validate cuts a long note ("… [+N chars]"): the part it shows is compared exactly, its cut last name as a prefix
  const listed = line.slice(line.indexOf(' hooks: ') + 8);
  const cut = /… \[\+\d+ chars\]$/.test(listed);
  const parts = listed.replace(/… \[\+\d+ chars\]$/, '').split(/, (?=[a-z]+\.[\w.]+(?:\{|,|$))/);
  if (cut) { const last = parts.pop()!, at = last.lastIndexOf(', '); parts.push(...(at >= 0 ? [last.slice(0, at), last.slice(at + 2)] : [last])); }
  const registered = parts.map(h => h.replace(/\{.*$/, ''));
  const { HOOKS } = await load('mod/register.ts');
  const events = HOOKS.map(h => h.event);
  if (!cut) assert.deepEqual(registered, events);
  else {
    assert.deepEqual(registered.slice(0, -1), events.slice(0, registered.length - 1));
    assert.ok(events[registered.length - 1].startsWith(registered.at(-1)!), `${registered.at(-1)} … is ${events[registered.length - 1]}`);
  }
  // the gating hooks validate lists in full, in registration order, are HOOKS entries in that order
  let i = 0;
  for (const g of gating) {
    while (i < events.length && events[i] !== g.pattern) i++;
    assert.ok(i < events.length, `${g.hook} is not in HOOKS (in order)`);
    i++;
  }
});

// ---------- the hooks the module took from hooks.json (stage 2) ----------
test('prefilter: rows, the restore and consent\'s PreToolUse start node only where they can act', async () => {
  const f = await load('mod/core/prefilter.ts');
  const seat = { name: 'alice', code: 'otter-4821', role: 'member', addr: 'alice.otter-4821' } as HelloSeat;
  const seated = { sid: 's1', seat } as Hello, unseated = { sid: 's1', seat: null } as Hello;
  assert.equal(f.rowsNeeded(seated, 's1', 'sub-human:room'), true);
  assert.equal(f.rowsNeeded(seated, 's1', 'Explore'), false, 'any other agent');
  assert.equal(f.rowsNeeded(unseated, 's1', 'sub-human:participant'), false);
  assert.equal(f.rowsNeeded(unseated, 's2', 'sub-human:participant'), true, 'another session id: unsure');
  assert.equal(f.rowsNeeded(null, 's1', 'sub-human:room'), true, 'no hello: unsure');
  for (const source of ['clear', 'compact', 'resume']) {
    assert.equal(f.restoreNeeded(seated, 's1', source), true, source);
    assert.equal(f.restoreNeeded(unseated, 's1', source), false, source);
    assert.equal(f.restoreNeeded({ ...unseated, restorable: true }, 's1', source), true, `${source}: a seat to put back`);
    assert.equal(f.restoreNeeded(seated, 's-new', source), true, `${source}: a new session id (a /clear): unsure`);
  }
  assert.equal(f.restoreNeeded(seated, 's1', 'startup'), false);
  assert.equal(f.restoreNeeded(unseated, 's1', 'fork'), true, 'a fork (← the agent view): only node can find the seat it continues');
  const room = 'mcp__plugin_sub-human_room__read';
  assert.equal(f.consentPreNeeded(seated, 's1', room, false), false, 'no review may be open');
  // stage 8e D: the post tool always reaches consent where a seat is (a waiting note refuses it)
  assert.equal(f.consentPreNeeded(seated, 's1', 'mcp__plugin_sub-human_room__post', false), true);
  assert.equal(f.consentPreNeeded(unseated, 's1', 'mcp__plugin_sub-human_room__post', false), false);
  assert.equal(f.consentPreNeeded(seated, 's1', room, true), true);
  assert.equal(f.consentPreNeeded(seated, 's1', room, undefined), true, 'unset counts as open');
  assert.equal(f.consentPreNeeded(unseated, 's1', room, true), false);
  assert.equal(f.consentPreNeeded(seated, 's1', 'AskUserQuestion', false), true, 'a card for a seat, review or not');
  assert.equal(f.consentPreNeeded(unseated, 's1', 'ExitPlanMode', true), false);
});

test('shim: a PreToolUse answer (deny over ask over allow; context joined; our rewrite stands) and a PermissionRequest decision', async () => {
  const s = await load('mod/core/shim.ts');
  const line = (o: unknown) => JSON.stringify(o);
  const pre = (d: string, why: string, extra: object = {}) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d, permissionDecisionReason: why, ...extra } });
  const out = (...o: unknown[]): RunOutput => ({ exitCode: 0, stdout: o.map(line).join('\n') + '\n', stderr: '' });
  assert.deepEqual(s.toPre(out(pre('ask', 'room proposal x', { updatedInput: { plan: 'P' } }))).result, { ask: 'room proposal x', updatedInput: { plan: 'P' } });
  assert.deepEqual(s.toPre(out(pre('allow', 'sub-human: opening x'))), { result: { allow: true }, allowReason: 'sub-human: opening x' });
  assert.deepEqual(s.toPre(out({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'note' } }, pre('deny', 'no'))).result, { deny: 'no', additionalContext: ['note'] });
  assert.deepEqual(s.toPre({ exitCode: 2, stdout: '', stderr: 'blocked\n' }).result, { deny: 'blocked' });
  assert.deepEqual(s.toPre({ exitCode: 1, stdout: line(pre('deny', 'x')), stderr: '' }).result, {}, 'a hook that failed answers nothing');
  assert.deepEqual(s.toPre(out({ subHuman: { reviewOpen: true } })), { result: {}, subHuman: { reviewOpen: true } });
  assert.deepEqual(s.mergePre({ allow: true }, { deny: 'theirs' }), { deny: 'theirs' }, 'a deny beneath wins over our allow');
  assert.deepEqual(s.mergePre({ ask: 'ours', updatedInput: { plan: 'P' } }, { allow: true, updatedInput: { plan: 'Q' } }), { ask: 'ours', updatedInput: { plan: 'P' } });
  assert.deepEqual(s.mergePre({ additionalContext: ['a'] }, { additionalContext: ['b'] }), { additionalContext: ['a', 'b'] });
  assert.deepEqual(s.mergePre({}, {}), {});
  const allow = { behavior: 'allow', updatedInput: {} } as const;
  assert.deepEqual(s.toPermission(out({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: allow }, subHuman: { reviewOpen: false } })),
    { result: { decision: allow }, subHuman: { reviewOpen: false } });
  assert.deepEqual(s.toPermission(out({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'maybe' } } })).result, {});
  assert.deepEqual(s.mergePermission({ decision: allow }, { decision: { behavior: 'deny', message: 'no' } }), { decision: { behavior: 'deny', message: 'no' } });
  assert.deepEqual(s.mergePermission({ decision: allow }, {}), { decision: allow });
  assert.deepEqual(s.mergePermission({}, { decision: allow }), { decision: allow });
});

test('facts: the main loop\'s transcript and mode by session id; a call\'s agentId while it runs; the classic PreToolUse payload', async () => {
  const { factsBook, prePayload } = await load('mod/core/facts.ts');
  const f = factsBook(2);
  f.noteEvent({ session_id: 's1', transcript_path: '/t1', permission_mode: 'default' });
  f.noteEvent({ session_id: 's1', permission_mode: 'plan' });
  f.noteEvent({ session_id: 's1', permission_mode: 'bypassPermissions', agent_id: 'sub' }); // a subagent's own loop
  assert.deepEqual(f.of('s1'), { transcript_path: '/t1', permission_mode: 'plan' });
  assert.deepEqual(f.of('s9'), {});
  f.stashAgent('tu1', 'a1'); f.stashAgent('tu2', 'a2'); f.stashAgent('tu3', 'a3');
  assert.equal(f.agentOf('tu1'), undefined, 'kept to the newest few');
  assert.equal(f.agentOf('tu3'), 'a3');
  f.dropAgent('tu3');
  assert.equal(f.agentOf('tu3'), undefined);
  assert.deepEqual(prePayload({ tool: 'ExitPlanMode', tool_use_id: 'tu', agentId: 'x', plan: 'P' }, { sid: 's1', cwd: '/w', facts: f.of('s1'), agentId: 'a1' }), {
    hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/w', transcript_path: '/t1', permission_mode: 'plan', agent_id: 'a1',
    tool_name: 'ExitPlanMode', tool_input: { plan: 'P' }, tool_use_id: 'tu',
  });
  assert.deepEqual(prePayload({ tool: 'Agent', tool_use_id: 'tu' }, { sid: 's1', facts: {} }), { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Agent', tool_input: {}, tool_use_id: 'tu' });
});

test('seat: the home and the session index the module checks without node are lib/\'s', async () => {
  const s = await load('mod/core/seat.ts');
  assert.equal(s.homeOf('/x/home', '/u'), '/x/home');
  assert.equal(s.homeOf('', '/u/'), '/u/.sub-human');
  assert.equal(s.homeOf(undefined, undefined), null);
  assert.equal(s.sidIndex('/u/.sub-human', 'abc-1'), '/u/.sub-human/sessions/by-sid/abc-1.json');
  assert.equal(s.sidIndex('/u/.sub-human', '../x'), null);
  assert.equal(s.sidIndex('relative', 'abc'), null);
  const w = new World({ claude: 'sleep', alice: 'act' });
  w.lib(() => {
    assert.equal(s.homeOf(process.env.SUB_HUMAN_HOME, os.homedir()), identity.home());
    assert.ok(fs.existsSync(s.sidIndex(path.resolve(identity.home()), w.sid.alice)!), 'a seat\'s index is where the module looks');
  });
  w.dispose();
  assert.deepEqual(s.localHello({ sid: 's1', home: '/h', userHome: '/u', pluginRoot: '/p' }), { sid: 's1', home: '/h', realHome: '/h', userHome: '/u', pluginRoot: '/p', seat: null, restorable: false, pending: false });
});

test('prompt: an @room in a session surely without a seat is refused in at-room\'s words, without node', async () => {
  const p = await load('mod/core/prompt.ts');
  const unseated = { sid: 's1', seat: null } as Hello;
  assert.deepEqual(p.unseatedRefusal({ session_id: 's1', prompt: '@room hi' }, unseated), { preventContinuation: true, stopReason: p.NOT_IN_ROOM }, 'a stop: no "blocked by hook" frame, nothing put back in the input');
  assert.equal(p.unseatedRefusal({ session_id: 's1', prompt: '@claude hi' }, unseated), null, 'outside a room @claude is a prompt');
  assert.equal(p.unseatedRefusal({ session_id: 's2', prompt: '@room hi' }, unseated), null, 'not this session\'s hello: node decides');
  assert.equal(p.unseatedRefusal({ session_id: 's1', prompt: '@room hi' }, { sid: 's1', seat: { name: 'a', code: 'otter-4821', role: 'member', addr: 'a.otter-4821' } } as Hello), null);
  const d = await load('mod/core/deliver.ts');
  assert.equal(d.rewakePrompt('one\ntwo\n'), `${d.REWAKE_SHOWN}\n(for Claude) one\n(for Claude) two`);
});
