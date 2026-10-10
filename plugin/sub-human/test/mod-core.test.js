'use strict';
// The hooks module's pure core (mod/core/*.ts) in node, and hooks/mod-hello.ts. The module's wiring is tested by
// `npm run test:mods` (mod/test/*.test.ts under `claude plugin test`); this file needs no Claude Code binary,
// except the last test, which compares mod/register.ts HOOKS with what `claude plugin validate` reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { World } = require('./hooks/helpers.js');

const PLUGIN = path.join(__dirname, '..');
const load = rel => import(path.join(PLUGIN, rel));

// ---------- copies kept equal ----------
test('mod/core copies of the CommonJS patterns and chat constants are equal to their sources', async () => {
  const seat = await load('mod/core/seat.ts');
  const chat = await load('mod/core/chat.ts');
  const text = require('../lib/text.ts');
  const config = require('../lib/config.ts');
  const room = require('../lib/room.ts');
  assert.equal(seat.NAME_RE.source, text.NAME_RE.source);
  assert.equal(seat.CODE_RE.source, text.CODE_RE.source);
  assert.equal(chat.NEST, config.CHAT_NEST);
  assert.equal(chat.CHAT_LINES_MAX, config.CHAT_LINES_MAX);
  assert.equal(chat.FOR_CLAUDE, room.FOR_CLAUDE);
});

test('mod/ is pure: no node: or CommonJS imports, no dynamic import(), no seat key, no store writes', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(x => x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]);
  const files = walk(path.join(PLUGIN, 'mod')).filter(f => /\.(mjs|ts)$/.test(f));
  assert.ok(files.length >= 8);
  const code = f => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
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
  const used = new Set();
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
  assert.deepEqual(parseHello(JSON.stringify(out) + '\n', 's1'), { sid: 's1', ...out, seat: { ...out.seat, addr: 'alice.otter-4821' } });
  assert.equal(parseHello('', 's1'), null);
  assert.equal(parseHello('not json', 's1'), null);
  assert.equal(parseHello(JSON.stringify({ home: 'relative' }), 's1'), null);
  const bad = parseHello(JSON.stringify({ ...out, seat: { name: '../x', code: 'otter-4821' } }), 's1');
  assert.equal(bad.seat, null);
  assert.equal(seated(bad), false);
  assert.equal(parseHello(JSON.stringify({ home: '/h' }), null).realHome, '/h');
  assert.deepEqual(parseAddr('bob.otter-4821'), { name: 'bob', code: 'otter-4821' });
  assert.deepEqual(parseAddr('b.o.b.otter-4821'), { name: 'b.o.b', code: 'otter-4821' });
  for (const x of ['bob', 'Bob session', 'bob.otter-48', '.otter-4821', null, 42]) assert.equal(parseAddr(x), null, String(x));
});

// ---------- shim ----------
test('shim: the stdout -> ClassicResult table covers every output shape the hooks emit today', async () => {
  const { toClassic, shimEnv, shimArgv } = await load('mod/core/shim.ts');
  const ok = (o, extra = {}) => ({ exitCode: 0, stdout: (typeof o === 'string' ? o : JSON.stringify(o)) + '\n', stderr: '', ...extra });
  const T = [
    // [what, event, run, expected {result, systemMessage?}]
    ['at-room ✓ sent', 'UserPromptSubmit',
      ok({ continue: false, stopReason: '✓ sent', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'alice.otter-4821' } }),
      { result: { preventContinuation: true, stopReason: '✓ sent', sessionTitle: 'alice.otter-4821' } }],
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
    ['a log line before the JSON', 'UserPromptSubmit', ok('warming up\n{"continue":false,"stopReason":"✓ sent"}'),
      { result: { preventContinuation: true, stopReason: '✓ sent' } }],
  ];
  for (const [what, event, run, want] of T) assert.deepEqual(toClassic(event, run), want, what);
  assert.deepEqual(shimEnv({ session_id: 's1' }, '/p'), { CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PID: '', CLAUDE_CODE_SESSION_ID: 's1' });
  assert.deepEqual(shimEnv({}, '/p'), { CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PID: '' });
  assert.deepEqual(shimArgv('/p', 'prompt.ts'), ['node', '--import', '/p/hooks/compile-cache.js', '/p/hooks/prompt.ts']);
});

test('shim: a real hook\'s output translates (at-room posting through prompt.ts)', async t => {
  const { toClassic } = await load('mod/core/shim.ts');
  const w = new World({ claude: 'sleep', alice: 'act' }, { t });
  const nonce = 'f00d'.repeat(8);
  w.lib(() => require('../lib/identity.ts').writeModLease(w.sid.alice, { nonce }));
  const r = w.hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: '@room hello', sub_human_origin: 'composer', sub_human_nonce: nonce, transcript_path: '' }, { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  const { result } = toClassic('UserPromptSubmit', { exitCode: r.code, stdout: r.stdout, stderr: r.stderr });
  assert.equal(result.preventContinuation, true);
  assert.match(result.stopReason, /^✓ sent/);
});

test('shim: subHuman (a hook run with SUB_HUMAN_SHIM=1) comes out beside the result', async () => {
  const { toClassic, SHIM_MODE } = await load('mod/core/shim.ts');
  const ok = o => ({ exitCode: 0, stdout: JSON.stringify(o) + '\n', stderr: '' });
  assert.deepEqual(SHIM_MODE, { SUB_HUMAN_SHIM: '1' });
  assert.deepEqual(toClassic('Stop', ok({ subHuman: { reviewOpen: false } })), { result: {}, subHuman: { reviewOpen: false } });
  assert.deepEqual(toClassic('Stop', ok({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'exit' }, subHuman: { reviewOpen: true } })),
    { result: { additionalContext: ['exit'] }, subHuman: { reviewOpen: true } });
  assert.deepEqual(toClassic('Stop', ok({ subHuman: [true] })), { result: {} });
});

// ---------- prompt ----------
test('prompt: parse is at-room\'s parse; the gate drops only an @room that no person typed', async () => {
  const p = await load('mod/core/prompt.ts');
  const atRoom = require('../hooks/at-room.ts');
  for (const s of ['@room hi', '@room', '@room  two', 'room:x', 'room: x', 'room:  x', '@roomx', ' @room x', 'hello', '', '/sub-human alice', 'Room: x', '@room\nmore'])
    assert.equal(p.parse(s), atRoom.parse(s), JSON.stringify(s));
  assert.deepEqual([...p.TYPED_ORIGINS], [...atRoom.TYPED_ORIGINS]);
  assert.equal(p.gateVerdict({ text: '@room x', origin: { kind: 'composer' } }), null);
  assert.equal(p.gateVerdict({ text: 'plain', origin: { kind: 'peer' } }), null);
  assert.match(p.gateVerdict({ text: '@room x', origin: { kind: 'peer' } }), /another Claude session/);
  assert.match(p.gateVerdict({ text: '@room x', origin: { kind: 'plugin', name: 'other' } }), /"plugin"/);
  assert.equal(p.gateVerdict({ text: 'room:x', origin: { kind: 'plugin', name: 'other' } }), null, 'room: is no tag');
  assert.equal(p.isAtRoom('@room'), true);
  assert.equal(p.isAtRoom('room'), false);
});

test('prompt: parseClaude is at-room\'s; a seated session gates an untyped @claude like an @room, an unseated one lets it through', async () => {
  const p = await load('mod/core/prompt.ts');
  const atRoom = require('../hooks/at-room.ts');
  for (const s of ['@claude hi', '@claude', '@claude  two', '@claudex', ' @claude x', '@Claude x', 'claude: x', '@room @claude x', 'hi @claude', '', '@claude\nmore'])
    assert.equal(p.parseClaude(s), atRoom.parseClaude(s), JSON.stringify(s));
  assert.equal(p.parseClaude('@room @claude x'), null, 'only a leading tag');
  assert.equal(p.parse('@room @claude x'), '@claude x', 'a plain @room post');
  const seated = { sid: 's1', seat: { name: 'alice', code: 'otter-4821', role: 'member', addr: 'alice.otter-4821' } };
  const unseated = { sid: 's1', seat: null };
  const peer = { text: '@claude plan it', origin: { kind: 'peer' } };
  assert.match(p.gateVerdict(peer, seated), /^✗ not posted: this @claude came from another Claude session/);
  assert.equal(p.gateVerdict(peer, unseated), null, 'outside a room @claude is a plain prompt');
  assert.equal(p.gateVerdict(peer, null), null, 'no hello: at-room decides');
  assert.equal(p.gateVerdict({ ...peer, origin: { kind: 'composer' } }, seated), null);
  assert.equal(p.gateVerdict({ text: 'ask @claude', origin: { kind: 'peer' } }, seated), null);
  assert.deepEqual(p.failClosed('@claude ship it', seated), { block: atRoom.NO_ORIGIN.replace('@room', '@claude'), suppressOriginalPrompt: true });
  assert.equal(p.failClosed('@claude ship it', unseated), null);
  assert.equal(p.failClosed('@claude ship it'), null);
  const e = prompt => ({ session_id: 's1', prompt });
  assert.equal(p.needsNode(e('@claude hi'), unseated), false, 'unseated: an ordinary prompt, no node');
  assert.equal(p.needsNode(e('@claude hi'), seated, { delivering: true, reviewFlag: false }), true, 'the post is signed in node');
});

test('prompt: needsNode skips node only for a surely unseated session and a prompt that is not an @room', async () => {
  const { needsNode } = await load('mod/core/prompt.ts');
  const seat = { name: 'alice', code: 'otter-4821', role: 'member', addr: 'alice.otter-4821' };
  const e = (prompt, sid = 's1') => ({ session_id: sid, prompt });
  assert.equal(needsNode(e('hi'), { sid: 's1', seat: null }), false);
  assert.equal(needsNode(e('/sub-human alice'), { sid: 's1', seat: null }), false);
  assert.equal(needsNode(e('@room hi'), { sid: 's1', seat: null }), true, 'node refuses it: not in a room');
  assert.equal(needsNode(e('hi'), { sid: 's1', seat }), true);
  assert.equal(needsNode(e('hi'), { sid: 's0', seat: null }), true, 'another session\'s hello (a /clear not refreshed yet)');
  assert.equal(needsNode(e('hi'), { sid: null, seat: null }), true, 'a failed refresh');
  assert.equal(needsNode(e('hi'), null), true, 'no hello yet');
});

test('prompt: a seated member skips node only while the tail child delivers and no review may be open; never the room\'s Claude', async () => {
  const { needsNode, originKind } = await load('mod/core/prompt.ts');
  const seat = { name: 'alice', code: 'otter-4821', role: 'member', addr: 'alice.otter-4821' };
  const hello = { sid: 's1', seat };
  const e = prompt => ({ session_id: 's1', prompt });
  assert.equal(needsNode(e('hi'), hello, { delivering: true, reviewFlag: false }), false);
  assert.equal(needsNode(e('hi'), hello, { delivering: false, reviewFlag: false }), true, 'no tail child yet: unsure, node runs');
  assert.equal(needsNode(e('hi'), hello, { delivering: true, reviewFlag: true }), true, 'a review may be open');
  assert.equal(needsNode(e('hi'), hello, { delivering: true }), true, 'flag unset: unsure');
  assert.equal(needsNode(e('@room hi'), hello, { delivering: true, reviewFlag: false }), true, 'the post is signed in node');
  assert.equal(needsNode(e('hi'), { sid: 's1', seat: { ...seat, role: 'claude' } }, { delivering: true, reviewFlag: false }), true, 'the room\'s Claude: its refusal is node\'s');
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
  const tail = require('../lib/tail.ts');
  const { events } = tail.formatNdBatch([], { me: { name: 'alice', role: 'member' }, room: {}, entries: [], show: () => false, joinNote: () => '', seen: new Set() });
  assert.deepEqual(events, []);
  for (const ev of [{ type: 'chat', lines: ['bob: hi'] }, { type: 'pull', text: tail.PULL_HEAD + '\nbob: hi' }, { type: 'wake', text: 'x' }, { type: 'health', text: 'room log check: x' }])
    assert.deepEqual(d.parseEvent(JSON.stringify(ev)), ev);
});

test('deliver: the routing table: chat is a notice, pull an append, wake a prompt when idle and an append mid-turn', async () => {
  const d = await load('mod/core/deliver.ts');
  // one $.ui.log per line: a notice is one line (a newline would be drawn as U+FFFD)
  assert.deepEqual(d.route({ type: 'chat', lines: ['bob: hi', '  │ more', 'carol joined'] }), [{ do: 'log', text: 'bob: hi' }, { do: 'log', text: '  │ more' }, { do: 'log', text: 'carol joined' }]);
  assert.deepEqual(d.route({ type: 'pull', text: 'Room since…' }), [{ do: 'append', text: 'Room since…' }]);
  assert.deepEqual(d.route({ type: 'rows', text: null }), [{ do: 'hold-rows', text: null }]);
  assert.deepEqual(d.route({ type: 'seat', seat: null }), [{ do: 'seat', seat: null }]);
  const idle = d.route({ type: 'wake', text: 'room: decided\n(for Claude) room now: …' });
  assert.deepEqual(idle, [{ do: 'submit', text: `${d.WAKE_HEAD}\nroom: decided\n(for Claude) room now: …`, seen: ['room: decided'] }]);
  const { gateVerdict } = await load('mod/core/prompt.ts');
  assert.equal(gateVerdict({ text: idle[0].text, origin: { kind: 'plugin', name: 'sub-human' } }), null, 'a wake never reads as a "room:" post');
  const mid = d.route({ type: 'wake', text: 'room: decided\n(for Claude) room now: …' }, { turnRunning: true });
  assert.deepEqual(mid, [{ do: 'log', text: 'room: decided' }, { do: 'mid-turn-wake', text: idle[0].text }]);
  const roomClaude = d.route({ type: 'wake', text: 'room now: …' }, { role: 'claude', rows: 'SUB-HUMAN ROWS: …' });
  assert.equal(roomClaude[0].text, `${d.WAKE_HEAD}\nroom now: …\nSUB-HUMAN ROWS: …`, 'the room\'s Claude\'s rows ride on its wakes');
  assert.equal(d.route({ type: 'wake', text: 'x' }, { role: 'member', rows: 'R' })[0].text.includes('R'), false, 'a member\'s go with the person\'s prompt');
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
  assert.equal(d.spawnWanted({ seat: null }), false);
  assert.equal(d.spawnWanted({ seat: { name: 'a' } }), true);
  const seat = { name: 'alice', code: 'otter-4821', role: 'member', addr: 'alice.otter-4821' };
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
  assert.deepEqual(mergeClassic({ preventContinuation: true, stopReason: '✓ sent', sessionTitle: 'a.b' }, { additionalContext: ['theirs'], sessionTitle: 'x' }),
    { preventContinuation: true, stopReason: '✓ sent', sessionTitle: 'a.b', additionalContext: ['theirs'] });
  assert.deepEqual(mergeClassic({ additionalContext: ['ours'] }, { additionalContext: ['theirs'], block: 'no' }), { additionalContext: ['ours', 'theirs'], block: 'no' });
  assert.deepEqual(mergeClassic({ block: 'mine', suppressOriginalPrompt: true }, {}), { block: 'mine', suppressOriginalPrompt: true });
  assert.deepEqual(mergeClassic({}, undefined), {});
});

// ---------- prefilter ----------
test('prefilter: consent and the task hooks are skipped only when sure', async () => {
  const f = await load('mod/core/prefilter.ts');
  const member = { sid: 's1', seat: { name: 'alice', code: 'otter-4821', role: 'member' } };
  const roomClaude = { sid: 's1', seat: { name: 'claude', code: 'otter-4821', role: 'claude' } };
  const none = { sid: 's1', seat: null };
  assert.equal(f.consentNeeded(none, 's1', undefined), false, 'no seat: no review');
  assert.equal(f.consentNeeded(member, 's1', undefined), true, 'flag unset: unsure');
  assert.equal(f.consentNeeded(member, 's1', true), true);
  assert.equal(f.consentNeeded(member, 's1', false), false);
  assert.equal(f.consentNeeded(none, 's2', false), false, 'the flag alone is enough');
  assert.equal(f.consentNeeded(none, 's2', undefined), true, 'another session\'s hello');
  assert.equal(f.consentNeeded(null, 's1', undefined), true);
  assert.equal(f.tasksNeeded(member, 's1'), false);
  assert.equal(f.tasksNeeded(roomClaude, 's1'), true);
  assert.equal(f.tasksNeeded(none, 's1', undefined), false);
  assert.equal(f.tasksNeeded(none, 's1', 'otter-4821'), true, 'a room Claude before its join');
  assert.equal(f.tasksNeeded(member, 's2'), true);
  assert.equal(f.tasksNeeded({ ...member, sid: null }, null), true);
  assert.equal(f.tasksNeeded(null, 's1'), true);
  assert.equal(f.reviewOpenOf({ reviewOpen: false }), false);
  assert.equal(f.reviewOpenOf({ reviewOpen: 'no' }), undefined);
  assert.equal(f.reviewOpenOf(undefined), undefined);
});

// ---------- chat ----------
test('chat: a peer message is "NAME\'s Claude: …" with nested continuation lines; room lines drop (for Claude)', async () => {
  const { peerLines, roomLines, NEST } = await load('mod/core/chat.ts');
  assert.deepEqual(peerLines('bob.otter-4821', '  done\n\nnext: tests  \n'), ["bob's Claude: done", `${NEST}next: tests`]);
  assert.deepEqual(peerLines('bob.otter-4821', ''), ["bob's Claude"]);
  assert.equal(peerLines('Some session', 'hi'), null);
  assert.equal(peerLines(undefined, 'hi'), null);
  const many = Array.from({ length: 25 }, (_, i) => `l${i}`).join('\n');
  const out = peerLines('bob.otter-4821', many);
  assert.equal(out.length, 21);
  assert.equal(out.at(-1), `${NEST}[+5 more lines: ctrl+o]`);
  assert.deepEqual(peerLines('bob.otter-4821', 'a‮b\u0007c\r\nd'), ["bob's Claude: abc", `${NEST}d`]);
  assert.deepEqual(roomLines('bob: hi\n  │ more\n(for Claude) room now: no proposals\ncarol joined'), ['bob: hi', '  │ more', 'carol joined']);
  assert.equal(roomLines('(for Claude) x'), null);
});

test('chat: the room\'s own chatLines come through roomLines unchanged', async () => {
  const { roomLines } = await load('mod/core/chat.ts');
  const room = require('../lib/room.ts');
  const e = { id: 7, from: 'bob', via: 'human', kind: 'say', to: 'room', text: 'sure\nonce we agree' };
  const lines = room.chatLines(e, { viewer: 'alice' });
  assert.deepEqual(roomLines(lines.join('\n')), lines);
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
  assert.match(why, /in a terminal outside Claude Code, never with !/);
  assert.doesNotMatch(why, /in your own shell/);
});

// ---------- mod-hello ----------
test('mod-hello: prints the home and this session\'s seat, and writes the lease (0600)', t => {
  const w = new World({ claude: 'sleep', alice: 'act' }, { t });
  const r = w.hook('mod-hello', {}, { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, {
    home: w.home, realHome: fs.realpathSync(w.home), userHome: w.userHome, pluginRoot: PLUGIN,
    seat: { name: 'alice', code: w.code, role: 'member', addr: `alice.${w.code}` },
  });
  const lease = path.join(w.home, 'sessions', 'mods', `${w.sid.alice}.json`);
  assert.equal(fs.statSync(lease).mode & 0o777, 0o600);
  const rec = JSON.parse(fs.readFileSync(lease, 'utf8'));
  assert.equal(rec.session_id, w.sid.alice);
  assert.equal(rec.seat, undefined, 'the seat is in the hello, not the lease');
  assert.deepEqual(w.lib(() => require('../lib/identity.ts').readModLease(w.sid.alice)), rec);
});

test('mod-hello: an unseated session gets seat null (and a lease); a bad payload gets no lease', t => {
  const w = new World({ claude: 'sleep' }, { t });
  const sid = '0b9c6f8e-1111-4222-8333-444455556666';
  const r = w.hook('mod-hello', { session_id: sid });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.seat, null);
  assert.equal(r.json.home, w.home);
  assert.ok(fs.existsSync(path.join(w.home, 'sessions', 'mods', `${sid}.json`)));
  const bad = w.hook('mod-hello', { session_id: '../../x' });
  assert.equal(bad.code, 0, bad.stderr);
  assert.equal(bad.json.seat, null);
  assert.ok(!fs.existsSync(path.join(w.home, 'sessions', 'mods', '..')) || !fs.readdirSync(path.join(w.home, 'sessions', 'mods')).some(f => f.includes('x')));
});

// ---------- the module, as validate reads it ----------
const validate = spawnSync('claude', ['plugin', 'validate', PLUGIN, '--strict', '--json'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: process.env.HOME || os.homedir() } });
const haveClaude = !validate.error && /^\s*\{/.test(validate.stdout || '');

test('validate: the module loads, every gating hook has a .catch, and HOOKS lists exactly what it registers', { skip: !haveClaude && 'no claude binary' }, async () => {
  const report = JSON.parse(validate.stdout);
  assert.equal(report.success, true, validate.stdout);
  const hooksReport = report.contents.find(c => c.type === 'hooks');
  const gating = hooksReport.gatingHooks || [];
  assert.ok(gating.length >= 4);
  assert.deepEqual(gating.filter(x => !x.hasCatch).map(x => x.hook), []);
  const line = hooksReport.notes.find(n => / hooks: /.test(n));
  const registered = line.slice(line.indexOf(' hooks: ') + 8).split(/, (?=[a-z]+\.[\w.]+(?:\{|,|$))/).map(h => h.replace(/\{.*$/, ''));
  const { HOOKS } = await load('mod/register.ts');
  assert.deepEqual(registered, HOOKS.map(h => h.event));
});
