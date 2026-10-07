'use strict';
// The hooks module's pure core (mod/core/*.mjs) in node, and hooks/mod-hello.js. The module's wiring is tested by
// `npm run test:mods` (mod/test/*.test.ts under `claude plugin test`); this file needs no Claude Code binary,
// except the last test, which compares mod/register.mjs HOOKS with what `claude plugin validate` reads.
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
  const seat = await load('mod/core/seat.mjs');
  const chat = await load('mod/core/chat.mjs');
  const text = require('../lib/text.js');
  const config = require('../lib/config.js');
  const room = require('../lib/room.js');
  assert.equal(seat.NAME_RE.source, text.NAME_RE.source);
  assert.equal(seat.CODE_RE.source, text.CODE_RE.source);
  assert.equal(chat.NEST, config.CHAT_NEST);
  assert.equal(chat.CHAT_LINES_MAX, config.CHAT_LINES_MAX);
  assert.equal(chat.FOR_CLAUDE, room.FOR_CLAUDE);
});

test('mod/ is pure: no node: or CommonJS imports, no dynamic import(), no seat key, no store writes', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(x => x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]);
  const files = [...walk(path.join(PLUGIN, 'mod')), path.join(PLUGIN, 'hooks', 'register.mjs')].filter(f => /\.(mjs|ts)$/.test(f));
  assert.ok(files.length >= 8);
  const code = f => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  for (const f of files.filter(x => !x.endsWith('.ts'))) {
    const src = code(f);
    assert.doesNotMatch(src, /from\s+['"]node:|require\(|\bimport\(/, f);
    assert.doesNotMatch(src, /from\s+['"][^'"]*seat-key|\$\.fs\.write\b/, f);
  }
  for (const f of files.filter(x => x.includes(`${path.sep}core${path.sep}`))) assert.doesNotMatch(code(f), /\$\./, `${f} uses $`);
});

// ---------- seat ----------
test('seat: parseHello keeps a good answer, refuses anything else; parseAddr reads NAME.CODE', async () => {
  const { parseHello, parseAddr, seated } = await load('mod/core/seat.mjs');
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
  const { toClassic, shimEnv, shimArgv } = await load('mod/core/shim.mjs');
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
    ['prompt.js title only', 'UserPromptSubmit',
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
    ['tasks exit 2', 'TaskCompleted', { exitCode: 2, stdout: '', stderr: 'only the orch completes task 1\n' }, { result: { block: 'only the orch completes task 1' } }],
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
  assert.deepEqual(shimArgv('/p', 'prompt.js'), ['node', '/p/hooks/prompt.js']);
});

test('shim: a real hook\'s output translates (at-room posting through prompt.js)', async t => {
  const { toClassic } = await load('mod/core/shim.mjs');
  const w = new World({ orch: 'sleep', alice: 'act' }, { t });
  const r = w.hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: '@room hello', source: 'user', transcript_path: '' }, { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  const { result } = toClassic('UserPromptSubmit', { exitCode: r.code, stdout: r.stdout, stderr: r.stderr });
  assert.equal(result.preventContinuation, true);
  assert.match(result.stopReason, /^✓ sent/);
});

// ---------- chat ----------
test('chat: a peer message is "NAME\'s Claude: …" with nested continuation lines; room lines drop (for Claude)', async () => {
  const { peerLines, roomLines, NEST } = await load('mod/core/chat.mjs');
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
  const { roomLines } = await load('mod/core/chat.mjs');
  const room = require('../lib/room.js');
  const e = { id: 7, from: 'bob', via: 'human', kind: 'say', to: 'room', text: 'sure\nonce we agree' };
  const lines = room.chatLines(e, { viewer: 'alice' });
  assert.deepEqual(roomLines(lines.join('\n')), lines);
});

// ---------- guard ----------
test('guard: write targets, ancestors and the verdict before and after mod-hello', async () => {
  const g = await load('mod/core/guard.mjs');
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
  const g = await load('mod/core/guard.mjs');
  assert.equal(g.needsCwd('node hooks/consent.js'), true);
  assert.equal(g.needsCwd('node /x/sub-human/hooks/consent.js'), false);
  assert.equal(g.needsCwd('npm test'), false);
  const inPlugin = { pluginRoot: '/repo/plugin/sub-human', cwd: '/repo/plugin/sub-human/hooks' };
  assert.ok(g.bashVerdict('node consent.js && node hooks/consent.js', inPlugin));
  assert.equal(g.bashVerdict('node hooks/consent.js', { ...inPlugin, cwd: '/elsewhere' }), null);
  assert.ok(g.bashVerdict('node hooks/consent.js', { ...inPlugin, cwd: '/elsewhere', realCwd: '/repo/plugin/sub-human' }));
});

// ---------- mod-hello ----------
test('mod-hello: prints the home and this session\'s seat, and writes the lease (0600)', t => {
  const w = new World({ orch: 'sleep', alice: 'act' }, { t });
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
  assert.equal(rec.seat, `alice.${w.code}`);
  assert.deepEqual(w.lib(() => require('../lib/identity.js').readModLease(w.sid.alice)), rec);
});

test('mod-hello: an unseated session gets seat null (and a lease); a bad payload gets no lease', t => {
  const w = new World({ orch: 'sleep' }, { t });
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
  const { HOOKS } = await load('mod/register.mjs');
  assert.deepEqual(registered, HOOKS.map(h => h.event));
});
