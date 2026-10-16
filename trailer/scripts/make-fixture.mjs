#!/usr/bin/env node
/**
 * make-fixture: writes capture/synthetic/capture.jsonl, a synthetic take in the capture contract's format
 * (meta, frame and marker lines; a frame is a full `tmux capture-pane -ep` screen) so the renderer can be
 * built and tested without a live demo run. The screens imitate Claude Code 2.1.292 (colours and glyphs
 * copied from real captures in docs/rebuild/screens); the plan view is an approximation.
 *
 *   node scripts/make-fixture.mjs [--out capture/synthetic]
 *
 * The story and its marker beats follow `scripts/demo.sh --film` (open, join, talk, reply, claudes, plan, proposal,
 * answers, revision, agreed, split, build, claimed, handler, tested, tests, pass), so the cuts in src/edits/ work
 * on this take and on a real one alike.
 *
 * It deliberately leaves things the loader must scrub: the seats' cwd (/private/tmp/sh-demo/alice), an
 * absolute home path, a user@host and the "Update available!" line.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.indexOf('--out');
const OUT = path.resolve(HERE, '..', outArg > 0 ? process.argv[outArg + 1] : 'capture/synthetic');

const COLS = 120;
const ROWS = 36;
const ROOM = 'vole-8126';

// ---- ANSI helpers (Claude Code's 256-colour palette as seen in captures) ----
const E = '\x1b[';
const fg = (n, s) => `${E}38;5;${n}m${s}${E}39m`;
const bold = s => `${E}1m${s}${E}0m`;
const dim = s => `${E}2m${s}${E}0m`;
const GRAY = 246, WHITE = 231, CODE = 153, ORANGE = 174, PEACH = 216, YELLOW = 220, GREEN = 114, RULE = 244, RED = 203;
const strip = s => s.replace(/\x1b\[[0-9;:]*m/g, '');
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - [...strip(s)].length));

const userPrompt = text => `${E}38;5;${GRAY}m${E}48;5;237m❯${E}39m ${fg(WHITE, text)}${E}49m`;
const bullet = (text, color = WHITE) => `${fg(color, '⏺')} ${text}`;
const result = text => `${fg(GRAY, '  ⎿  ')}${text}`;
const code = s => fg(CODE, s);
const roomRow = (who, text) => `${fg(GRAY, '⏺')} ${fg(GRAY, 'sub-human: ')}${bold(who + ':')} ${text}`;
// an @room's receipt (wake: an @claude's), as the stop's warning row draws it (plugin hooks/at-room.ts)
const SENT = `✓ sent to room ${ROOM} (Claude wasn't asked)`, WOKE = "✓ sent; the room's Claude was woken";
const hookSent = (wake = false) => bullet(fg(YELLOW, `Operation stopped by hook: ${wake ? WOKE : SENT}`), YELLOW);

const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

function rule(label) {
  if (!label) return fg(RULE, '─'.repeat(COLS));
  const tail = ` ${label} ─`;
  return fg(RULE, '─'.repeat(COLS - tail.length) + tail);
}

// ---- sessions ----
function session(name) {
  return {
    name, transcript: [], input: '', cursor: false, spinner: null, dialog: null, status: '1 here',
    header: [
      `${fg(ORANGE, ' ▐')}${E}48;5;16m${fg(ORANGE, '▛███▛█')}${E}49m   ${bold('Claude Code')} ${fg(GRAY, 'v2.1.292')}`,
      `${fg(ORANGE, '▝▜')}${E}48;5;16m${fg(ORANGE, '█████')}${E}49m${fg(ORANGE, '█▀')}  ${fg(GRAY, 'Opus 5.5 (1M context) · Claude Max')}`,
      `${fg(ORANGE, ' ▝▝   ▝▝ ')}  ${fg(GRAY, `/private/tmp/sh-demo/${name}`)}`,
      '',
    ],
  };
}

function screen(s, t) {
  const lines = [...s.header, ...s.transcript];
  if (s.spinner) {
    const secs = Math.floor((t - s.spinner.start) / 1000);
    const glyph = SPIN[Math.floor(t / 120) % SPIN.length];
    const toks = (s.spinner.rate * secs).toFixed(1);
    lines.push('', `${fg(ORANGE, glyph)} ${fg(PEACH, s.spinner.verb + '…')} ${fg(GRAY, `(${secs}s · ↓ ${toks}k tokens)`)}`);
    if (s.spinner.tip) lines.push(result(fg(GRAY, s.spinner.tip)));
  }
  lines.push('');
  lines.push(' '.repeat(64) + `${fg(YELLOW, 'Update available! Run: ')}${bold('brew upgrade claude-code@latest')}`);
  if (s.dialog) lines.push(...s.dialog);
  else {
    lines.push(rule(`${s.name}.${ROOM}`));
    const cur = s.cursor ? `${E}7m ${E}27m` : '';
    lines.push(`❯ ${s.input}${cur}`);
    lines.push(rule());
    lines.push(`  ${fg(YELLOW, '⏵⏵ auto mode on')}${fg(GRAY, ' (shift+tab to cycle) · ← 1 agent · ↓ to manage')}`);
    lines.push('', bold('  ⏺ main'), `${fg(GRAY, `  ◯ ${ROOM}  `)}${dim(s.status)}`);
  }
  let rows = lines.slice(Math.max(0, lines.length - ROWS));
  while (rows.length < ROWS) rows.push('');
  return rows.join('\n');
}

// ---- the take ----
const out = [];
const last = {};
let T = 0;
const S = { alice: session('alice'), bob: session('bob') };
const claudeLog = [];

function emit(...names) {
  for (const n of names) {
    const ansi = n === 'claude' ? claudeScreen() : screen(S[n], T);
    if (last[n] === ansi) continue;
    last[n] = ansi;
    out.push({ t: Math.round(T), kind: 'frame', session: n, ansi });
  }
}
const all = () => emit('alice', 'bob');
function marker(scene, beat, caption) { out.push({ t: Math.round(T), kind: 'marker', scene, beat, caption }); }
function wait(ms, tick = []) {
  const end = T + ms;
  while (T < end) { T = Math.min(end, T + 500); if (tick.length) emit(...tick); }
}
// deterministic "human" typing rhythm
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function type(n, text, cps = 22) {
  const s = S[n];
  s.cursor = true;
  emit(n);
  for (const ch of text) {
    T += (1000 / cps) * (0.6 + rnd() * 0.8) + (ch === ' ' ? 40 : 0);
    s.input += ch;
    emit(n);
  }
  T += 350;
}
function submit(n) {
  const s = S[n];
  s.transcript.push('', userPrompt(s.input));
  s.input = '';
  s.cursor = false;
  emit(n);
}
function think(names, ms, verb = 'Thinking', rate = 0.4) {
  for (const n of names) S[n].spinner = { start: T, verb, rate };
  wait(ms, names);
  for (const n of names) S[n].spinner = null;
}
function claudeScreen() {
  const rows = [`${fg(GRAY, 'claude logs')} ${fg(WHITE, 'claude.' + ROOM)}`, '', ...claudeLog];
  const r = rows.slice(Math.max(0, rows.length - ROWS));
  while (r.length < ROWS) r.push('');
  return r.join('\n');
}

const PLAN_V1 = [
  bold('Cursor paging for GET /tasks'),
  '',
  `${bold('alice')}  handler in ${code('src/server.js')}: ${code('?limit&after')}, newest first, opaque cursor; default 20, max 50`,
  `${bold('bob')}    tests in ${code('test/paging.test.js')}: first page, next cursor, last page, empty page`,
  '',
  `Done when ${code('npm test')} passes in both checkouts.`,
];
const PLAN_V2 = [
  bold('Cursor paging for GET /tasks') + fg(GRAY, '  (revised)'),
  '',
  `${bold('alice')}  handler in ${code('src/server.js')}: ${code('?limit&after')}, newest first, opaque cursor; default 20, max 50`,
  `        ${fg(GREEN, 'a malformed cursor, or one past the end, answers 400')}`,
  `${bold('bob')}    tests in ${code('test/paging.test.js')}: first page, next cursor, last page, empty page,`,
  `        ${fg(GREEN, '`after=zzz` answers 400, not 500')}`,
  '',
  `Done when ${code('npm test')} passes in both checkouts.`,
];
function box(lines) {
  const w = COLS - 4;
  return [
    fg(RULE, '╭' + '─'.repeat(w + 2) + '╮'),
    ...lines.map(l => fg(RULE, '│') + ' ' + pad(l, w) + ' ' + fg(RULE, '│')),
    fg(RULE, '╰' + '─'.repeat(w + 2) + '╯'),
  ];
}
function planView(plan, sel, forWho, note) {
  const opt = (i, label) => (i === sel ? fg(CODE, ` ❯ ${i}. ${label}`) : `   ${i}. ${label}`);
  const v = [
    rule(),
    ` ${bold('Ready to code?')}`,
    '',
    ` Here is ${fg(ORANGE, "the room's Claude")}'s plan for ${bold('alice')} and ${bold('bob')}:`,
    ...box(plan),
    '',
    fg(GRAY, ` sub-human: proposed by claude · only your answer here counts (${forWho}) · 3 to ask for changes`),
    ' Would you like to proceed?',
    '',
    opt(1, 'Yes, I agree'),
    opt(2, 'Yes, and auto-accept edits'),
    opt(3, 'No, keep planning'),
  ];
  if (note != null) v.push(`      ${fg(GRAY, '⎿')} ${note}${E}7m ${E}27m`);
  v.push('', fg(GRAY, ' ctrl-g to edit in editor · settings.json to update hooks'));
  return v;
}

out.push({ t: 0, kind: 'meta', sessions: { alice: { cols: COLS, rows: ROWS }, bob: { cols: COLS, rows: ROWS }, claude: { cols: COLS, rows: ROWS } }, room: ROOM });
all();
emit('claude');

// S1: alice opens the room
wait(600);
marker('S1', 'open', "alice opens a room; the room gets its own Claude");
type('alice', '/sub-human alice');
submit('alice');
wait(900);
S.alice.transcript.push(result(`UserPromptExpansion says: sub-human: opened room ${ROOM} as alice · others: /sub-human NAME`));
emit('alice');
wait(700);
S.alice.transcript.push('', bullet(`You've opened room ${bold(ROOM)}. The room's Claude is starting.`));
emit('alice');
wait(1200);

// S2: bob joins
marker('S2', 'join', 'bob joins from his own session');
type('bob', '/sub-human bob');
submit('bob');
wait(800);
S.bob.transcript.push(result(`UserPromptExpansion says: sub-human: joined ${ROOM} as bob (alice, claude here)`));
S.bob.status = '2 here';
S.alice.status = '+bob joined · 2 here';
S.alice.transcript.push('', `${fg(GRAY, '⏺')} ${fg(GRAY, 'sub-human: bob joined')}`);
all();
wait(700);
S.bob.transcript.push('', bullet(`You're in room ${bold(ROOM)} with alice.`));
emit('bob');
wait(1400);

// S3: @room both ways, then Claude to Claude
marker('S3', 'talk', 'alice asks bob in the room, in her own words');
type('alice', "@room bob, can you take the parser tests? handler's in src/server.js", 30);
submit('alice');
wait(400);
S.alice.transcript.push('', hookSent());
S.alice.status = '2 here';
emit('alice');
wait(500);
S.bob.transcript.push('', roomRow('alice', "bob, can you take the parser tests? handler's in src/server.js"));
emit('bob');
wait(1800);
marker('S3', 'reply', 'bob answers: once they agree how paging works');
type('bob', "@room sure, once we've agreed how paging works", 26);
submit('bob');
wait(400);
S.bob.transcript.push('', hookSent());
S.alice.transcript.push('', roomRow('bob', "sure, once we've agreed how paging works"));
all();
wait(1600);
marker('S3', 'claudes', "bob's Claude asks alice's Claude directly");
type('bob', "ask alice's Claude how createTask in src/store.js picks ids. just ask, change nothing", 34);
submit('bob');
think(['bob'], 5200, 'Thinking', 0.3);
S.bob.transcript.push('', bullet(`${bold('SendMessage')}(alice.${ROOM})`, GREEN));
S.bob.transcript.push(result(`“How does createTask pick ids?” → sent to ${fg(WHITE, `alice.${ROOM}`)} — another Claude session on this machine`));
emit('bob');
wait(700);
S.alice.transcript.push('', bullet(`${bold("bob's Claude")}${fg(GRAY, ': how does createTask in src/store.js pick ids? just ask, change nothing')}`, GRAY));
emit('alice');
think(['alice', 'bob'], 2000, 'Reading', 0.5);
S.alice.transcript.push('', bullet(`${bold('Read')}(src/store.js)`, GREEN), result(fg(GRAY, 'Read 48 lines')));
emit('alice');
think(['alice', 'bob'], 17000, 'Thinking', 0.6);
S.alice.transcript.push('', bullet(`${bold('SendMessage')}(bob.${ROOM})`, GREEN), result(fg(GRAY, "sent the answer to bob's Claude")));
S.alice.transcript.push('', bullet(`I answered bob's Claude: ids come from a module counter, ${code('nextId++')}. I changed nothing.`));
emit('alice');
wait(1200);
S.bob.transcript.push('', bullet(`${bold("alice's Claude")}${fg(GRAY, ': createTask takes the next number from a module counter (nextId++); nothing changed')}`, GRAY));
emit('bob');
think(['bob'], 4000, 'Thinking', 0.4);
S.bob.transcript.push('', bullet("alice's Claude answered, and says it changed nothing."),
  `  - ${bold('How ids are picked:')} ${code('createTask')} (${code('src/store.js:7-11')}) takes the next number from a counter (${code('nextId++')}).`,
  `  - ${bold('Why it matters for paging:')} ids are unique and only go up, but ${code('createdAt')} isn't: ${code('seed()')} gives every`,
  `    3 tasks the same timestamp. So sort by ${code('createdAt')} with ${code('id')} as the tiebreaker, or page on ${code('id')} alone.`);
emit('bob');
wait(3500);

// S4: @claude plans; the plan opens in both plan views
marker('S4', 'plan', "bob asks the room's Claude to plan cursor paging");
type('bob', "@claude let's plan cursor paging for GET /tasks: ?limit&after, opaque cursor, newest first", 34);
submit('bob');
wait(400);
S.bob.transcript.push('', hookSent(true));
S.alice.transcript.push('', roomRow('bob', `${fg(ORANGE, '@claude')} let's plan cursor paging for GET /tasks: ?limit&after, opaque cursor, newest first`));
all();
claudeLog.push(`${fg(GRAY, '←')} bob: @claude let's plan cursor paging for GET /tasks`);
emit('claude');
wait(800);
S.alice.status = S.bob.status = '2 here · claude is planning';
all();
for (let i = 0; i < 6; i++) {
  wait(7000, ['alice', 'bob']);
  claudeLog.push(`${fg(GREEN, '⏺')} ${['Read(src/server.js)', 'Read(src/store.js)', 'Read(test/server.test.js)', 'Grep("limit")', 'Write(plan.md)', 'ExitPlanMode'][i]}`);
  emit('claude');
}
wait(1500, ['alice', 'bob']);
S.alice.status = S.bob.status = '2 here · plan open';
S.alice.dialog = planView(PLAN_V1, 1, 'alice');
emit('alice');
marker('S4', 'proposal', 'The plan opens for alice and bob to review');
T += 300;
S.bob.dialog = planView(PLAN_V1, 1, 'bob');
emit('bob');
wait(5000);

// S5: alice agrees, bob objects with a note; the room's Claude revises; both agree
marker('S5', 'answers', 'alice agrees; bob objects with a note');
T += 500;
S.alice.dialog = null;
S.alice.transcript.push('', bullet(fg(GRAY, 'sub-human: you agreed · waiting for bob'), GRAY));
S.alice.status = '2 here · waiting for bob';
emit('alice');
S.bob.dialog = planView(PLAN_V1, 2, 'bob'); T += 350; emit('bob');
S.bob.dialog = planView(PLAN_V1, 3, 'bob'); T += 500; emit('bob');
const note = 'add a test for a cursor past the end — `after=zzz` must 400, not 500';
let typed = '';
S.bob.dialog = planView(PLAN_V1, 3, 'bob', ''); T += 400; emit('bob');
for (const ch of note) {
  T += 34 * (0.6 + rnd() * 0.8);
  typed += ch;
  S.bob.dialog = planView(PLAN_V1, 3, 'bob', typed);
  emit('bob');
}
T += 700;
S.bob.dialog = null;
S.bob.transcript.push('', result(`${fg(RED, 'User rejected the plan:')} ${note}`));
S.bob.transcript.push('', bullet(fg(GRAY, "sub-human: sent bob's note to the room's Claude"), GRAY));
emit('bob');
wait(600);
S.alice.transcript.push('', roomRow('bob', `asked for changes: ${note}`));
S.alice.status = S.bob.status = '2 here · claude is revising';
all();
claudeLog.push(`${fg(GRAY, '←')} bob (note): ${note}`);
emit('claude');
for (let i = 0; i < 4; i++) wait(6000, ['alice', 'bob']);
marker('S5', 'revision', "The room's Claude revises the plan");
S.alice.status = S.bob.status = '2 here · plan open';
S.alice.dialog = planView(PLAN_V2, 1, 'alice');
S.bob.dialog = planView(PLAN_V2, 1, 'bob');
all();
wait(4000);
S.alice.dialog = null;
S.alice.transcript.push('', bullet(fg(GRAY, 'sub-human: you agreed · waiting for bob'), GRAY));
S.alice.status = '2 here · waiting for bob';
emit('alice');
wait(2400);
S.bob.dialog = null;
for (const n of ['alice', 'bob']) {
  S[n].transcript.push('', bullet(`${fg(GREEN, '✓')} sub-human: ${bold('plan agreed')} by alice and bob · the decision is logged`));
  S[n].status = '2 here';
}
all();
marker('S5', 'agreed', 'Both agree: the decision is logged');
wait(3000);

// S6b: split into tasks, each Claude builds its half, both people run the tests
marker('S6b', 'split', "alice's Claude splits the plan into two tasks: one for her, one for bob");
type('alice', 'the plan is agreed: put its two halves on the room task list, one for me and one for bob', 40);
submit('alice');
think(['alice'], 6000, 'Thinking', 0.3);
S.alice.transcript.push('', bullet(`${bold('sub-human:task')}(add "paging handler" for alice, add "paging tests" for bob)`, GREEN),
  result(fg(GRAY, 'queued; the room\'s Claude applies it')));
for (const n of ['alice', 'bob']) S[n].status = '2 here · tasks 2 open';
all();
wait(2000);
marker('S6b', 'build', 'Each Claude builds its half in its own checkout');
type('alice', 'claim #1, then build GET /tasks paging as the room decided, in src/ only. commit and push, then tell bob\'s Claude', 40);
submit('alice');
type('bob', 'claim #2, then write the tests in test/paging.test.js only. once the handler is pushed: pull and npm test', 40);
submit('bob');
think(['alice', 'bob'], 6000, 'Working', 0.9);
marker('S6b', 'claimed', "Each claims its own task on the room's list");
for (const n of ['alice', 'bob']) S[n].status = `2 here · tasks 2 open · #1 alice · #2 bob`;
all();
think(['alice', 'bob'], 6000, 'Working', 0.9);
S.alice.transcript.push('', bullet(`${bold('Update')}(src/server.js)`, GREEN),
  result(fg(GRAY, 'Updated src/server.js with 17 additions and 3 removals')),
  `       ${E}48;2;24;52;32m 41 +  const limit = Math.min(Number(q.limit) || 20, 50);${' '.repeat(41)}${E}49m`,
  `       ${E}48;2;24;52;32m 42 +  const after = q.after ? decodeCursor(q.after) : null;   // 400 if malformed${' '.repeat(14)}${E}49m`,
  `       ${E}48;2;24;52;32m 43 +  const page = newestFirst(tasks, after).slice(0, limit);${' '.repeat(35)}${E}49m`);
emit('alice');
think(['alice', 'bob'], 8000, 'Working', 0.9);
S.bob.transcript.push('', bullet(`${bold('Write')}(test/paging.test.js)`, GREEN),
  result(fg(GRAY, 'Wrote 52 lines to test/paging.test.js')));
emit('bob');
think(['alice', 'bob'], 14000, 'Working', 0.9);
S.alice.transcript.push('', bullet(`${bold('Bash')}(git commit -qam "GET /tasks: cursor paging" && git pull -q --rebase && git push -q)`, GREEN),
  '', bullet(`${bold('SendMessage')}(bob.${ROOM})`, GREEN), result(fg(GRAY, "the handler is pushed")),
  '', bullet(fg(GRAY, `sub-human: task ${code('#1')} paging handler: done`), GRAY));
S.alice.status = S.bob.status = '2 here · tasks 1 open · #2 bob';
all();
marker('S6b', 'handler', "alice's Claude pushes the handler and tells bob's Claude");
think(['bob'], 7000, 'Working', 0.6);
const pass = name => `     ${fg(GREEN, '✔')} ${name} ${fg(GRAY, `(${(1 + rnd() * 6).toFixed(1)}ms)`)}`;
S.bob.transcript.push('', bullet(`${bold('Bash')}(git pull -q && npm test)`, GREEN),
  result(`${fg(GREEN, '✔')} GET /tasks returns the newest 20 ${fg(GRAY, '(3.1ms)')}`),
  pass('after= continues where the page ended'),
  pass('a cursor past the end answers 400, not 500'),
  pass('limit is capped at 50'),
  `     ${fg(GRAY, 'ℹ tests 14 · pass 14 · fail 0')}`,
  '', bullet(`All 14 tests pass against alice's handler. Marked task ${code('#2')} done.`));
for (const n of ['alice', 'bob']) S[n].status = '2 here · tasks: all 2 done';
all();
marker('S6b', 'tested', "bob's Claude pulls it: his tests pass against her handler");
wait(2500);
marker('S6b', 'tests', 'alice and bob pull and run the tests themselves');
const run = "!git pull -q --rebase && npm test --silent | grep -E ' (tests|pass|fail) [0-9]+$'";
type('alice', run, 45);
submit('alice');
type('bob', run, 45);
submit('bob');
wait(2500);
for (const n of ['alice', 'bob']) {
  S[n].transcript.push(result(fg(GRAY, 'ℹ tests 14')), `     ${fg(GRAY, 'ℹ')} ${fg(GREEN, 'pass 14')}`, `     ${fg(GRAY, 'ℹ fail 0')}`);
}
all();
marker('S6b', 'pass', 'npm test passes in both checkouts');
wait(4500);

// a stray path and user@host, so the scrub step has something to do
S.alice.transcript.push(fg(GRAY, '  (session saved in /Users/tristan/.claude/projects/-private-tmp-sh-demo-alice, ssh tristan@Tristans-MacBook-Pro.local)'));
emit('alice');
wait(500);

fs.mkdirSync(OUT, { recursive: true });
// gzipped: the take is ~4 MB of near-identical screens (the loader reads capture.jsonl or capture.jsonl.gz)
fs.writeFileSync(path.join(OUT, 'capture.jsonl.gz'), zlib.gzipSync(out.map(o => JSON.stringify(o)).join('\n') + '\n', { level: 9 }));
fs.writeFileSync(path.join(OUT, 'run.json'), JSON.stringify({
  take: path.basename(OUT), synthetic: true, room: ROOM, durationMs: T,
  scenes: [...new Set(out.filter(o => o.kind === 'marker').map(o => o.scene))],
  checks: 'n/a (synthetic take)',
}, null, 1) + '\n');
const frames = out.filter(o => o.kind === 'frame').length;
console.log(`wrote ${path.relative(process.cwd(), path.join(OUT, 'capture.jsonl.gz'))}: ${frames} frames, ${(T / 1000).toFixed(1)} s`);
