// mod/core/room-chat.ts in node: the room row as the room's chat (0.8.0 room-chat). The wiring (turn.step, the row's
// rows, the drawing) is in mod/test/chat.test.ts (npm run test:mods).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chatOn, chatSpawn, keeperCall, keeperHold, typedText, postNote, keeperStep, ended, woken, rowStatus, rowUuids, drawLine,
  keepRow, rowOf, KEEPER_MAX, KEEPER_WINDOW_MS, ROWS_KEPT,
} from '../mod/core/room-chat.ts';
import type { Hello } from '../mod/core/types.ts';
import type { Gated } from '../mod/core/cc.ts';

const CODE = 'otter-4821';
const hello = (off: Gated[]): Hello =>
  ({ sid: 's', home: '/h', realHome: '/h', userHome: '/u', pluginRoot: '/p', seat: null, cc: { version: '2.1.296', verified: false, off } });
const WRAP = (t: string) => `The user sent a new message while you were working:\n${t}\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result.`;

test('room-chat: on unless the verdict turns room-row or room-chat off; the spawn, the keeper\'s call and its hold', () => {
  assert.equal(chatOn(null), true);
  assert.equal(chatOn(hello([])), true);
  assert.equal(chatOn(hello(['room-chat'])), false);
  assert.equal(chatOn(hello(['room-row'])), false);
  assert.deepEqual(chatSpawn(CODE), { subagentType: 'sub-human:room', name: CODE, description: 'type here', prompt: `chat: ${CODE}` });
  assert.deepEqual(keeperCall(CODE), { subagent_type: 'sub-human:keeper', description: 'keeper', prompt: `keep: ${CODE}`, run_in_background: true });
  assert.deepEqual(keeperHold(CODE), { room: CODE, take: true });
  assert.deepEqual(keeperHold(CODE, true), { room: CODE, take: true, wake: true }, 'a row the module may not send to');
});

test('room-chat: a typed line\'s exact words out of Claude Code\'s wrapper; anything else is no typed line', () => {
  const words = 'exact: "quotes" <b>tag</b> \\ back — ünïcode 🚀 @room\nline two';
  assert.equal(typedText(WRAP(words)), words);
  assert.equal(typedText(WRAP('  spaced  ')), '  spaced  ');
  assert.equal(typedText(WRAP('   ')), null, 'nothing typed');
  assert.equal(typedText('hello'), null);
  assert.equal(typedText(`chat: ${CODE}`), null);
  assert.equal(typedText(undefined), null);
});

test('room-chat: at-room\'s answer as the row says it: nothing under a sent line, else its words', () => {
  assert.equal(postNote({ preventContinuation: true, stopReason: 'Sent' }), null);
  assert.equal(postNote({ preventContinuation: true, stopReason: 'Sent (pasted text unwrapped)' }), null);
  assert.equal(postNote({ preventContinuation: true, stopReason: '⧗ queued: room x is offline' }), '⧗ queued: room x is offline');
  assert.equal(postNote({ block: '✗ not posted: this prompt wasn\'t typed by you' }), '✗ not posted: this prompt wasn\'t typed by you');
  assert.match(String(postNote({})), /^✗ not posted: /, 'no answer');
});

test('room-chat: a keeper that dies at once is started at most KEEPER_MAX times in KEEPER_WINDOW_MS', () => {
  let times: number[] = [];
  let n = 0;
  for (let i = 0; i < 10; i++) { const s = keeperStep(times, 1000 + i); times = s.times; if (s.spawn) n++; }
  assert.equal(n, KEEPER_MAX);
  assert.equal(keeperStep(times, 1000 + KEEPER_WINDOW_MS + 10).spawn, true, 'once the window passed');
});

test('room-chat: a hold that ended the keeper (STOP, cancelled) and one that did not run', () => {
  assert.equal(ended(`STOP: a newer row holds room ${CODE}. End now without calling any tool.`), true);
  assert.equal(ended('(cancelled)'), true);
  assert.equal(ended('WAKE: a new line in room x.'), true);
  assert.equal(woken('WAKE: a new line in room x.'), true);
  assert.equal(woken(`STOP: a newer row holds room ${CODE}.`), false);
  assert.equal(ended('The server-side auto mode classifier gave no verdict for mcp__plugin_sub-human_room__hold'), false);
  assert.equal(ended(undefined), false);
});

test('room-chat: the status line under main\'s prompt', () => {
  assert.equal(rowStatus(CODE, 'maya, dev here', 2), `${CODE} · maya, dev here · 2 new`);
  assert.equal(rowStatus(CODE, 'only you', 0), `${CODE} · only you`);
  assert.equal(rowStatus(CODE, '', 0), CODE);
});

test('room-chat: a resumed row\'s lines are its transcript\'s answeredWithoutRequest rows', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'chat: x' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', answeredWithoutRequest: true }),
    JSON.stringify({ type: 'assistant', uuid: 'a2' }),
    '{"answeredWithoutRequest": true, "uuid": "torn',
    JSON.stringify({ type: 'assistant', uuid: 'a3', answeredWithoutRequest: true }),
  ].join('\n');
  assert.deepEqual(rowUuids(jsonl), ['a1', 'a3']);
});

test('room-chat: a row line is drawn with no bullet, each line\'s author bold', () => {
  const tree = drawLine("maya: pushed it\n  │ and the tests\nbob's Claude: tests pass\nbob joined");
  const rows = 'children' in tree && Array.isArray(tree.children) ? tree.children : [];
  assert.equal(rows.length, 4);
  const json = JSON.stringify(tree);
  assert.match(json, /"bold":true},"children":\["maya:"\]\}," pushed it"/);
  assert.match(json, /"children":\["bob's Claude:"\]/);
  assert.match(json, /"children":\["  │ and the tests"\]/, 'a nested line has no author');
  assert.match(json, /"children":\["bob joined"\]/);
});

test('room-chat: the row is kept per session id, the newest ROWS_KEPT', () => {
  let rows = keepRow(undefined, 's0', { code: CODE, id: 'r0' });
  for (let i = 1; i < ROWS_KEPT + 5; i++) rows = keepRow(rows, `s${i}`, { code: CODE, id: `r${i}` });
  assert.equal(Object.keys(rows).length, ROWS_KEPT);
  assert.equal(rowOf(rows, 's0'), null, 'the oldest went');
  assert.deepEqual(rowOf(rows, `s${ROWS_KEPT + 4}`), { code: CODE, id: `r${ROWS_KEPT + 4}` });
  assert.deepEqual(rowOf(keepRow(rows, 's1', { code: 'vole-1234', id: 'n' }), 's1'), { code: 'vole-1234', id: 'n' }, 'replaced');
  assert.equal(rowOf({ s: { code: 1 } }, 's'), null);
  assert.deepEqual(rowOf(keepRow(rows, 'sw', { code: CODE, id: 'w', wake: true }), 'sw'), { code: CODE, id: 'w', wake: true }, 'a row main\'s model started');
  assert.equal(rowOf(null, 's'), null);
});
