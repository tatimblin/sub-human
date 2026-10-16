// mod/core/prompt.ts in node: the session title, the origin hand-off, the fail-closed @room refusal and the
// "working" presence rule. The wiring is in mod/test/prompt.test.ts (npm run test:mods).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Hello, HelloSeat } from '../mod/core/types.ts';
import type * as Prompt from '../mod/core/prompt.ts';
import { must } from './support/must.ts';

const PLUGIN = path.join(import.meta.dirname, '..');
const load = (): Promise<typeof Prompt> => import(path.join(PLUGIN, 'mod', 'core', 'prompt.ts'));
const seat = (code = 'otter-4821', role: HelloSeat['role'] = 'member'): HelloSeat => ({ name: 'alice', code, role, addr: `alice.${code}` });
/** A hello as titleFor and writesWorking read it: sid and seat (the rest any home). */
const hi = (sid: string, s: HelloSeat | null): Hello => ({ sid, seat: s, home: '/h', realHome: '/h', userHome: null, pluginRoot: null });

test('prompt: titleFor titles once per session id and address, so a room switch sets the new title', async () => {
  const { titleFor } = await load();
  const a = hi('s1', seat()); // a hello as titleFor reads it: sid and seat only
  assert.equal(titleFor(a, 's1', undefined), 'alice.otter-4821');
  assert.equal(titleFor(a, 's1', { sid: 's1', addr: 'alice.otter-4821' }), null, 'already titled');
  const b = hi('s1', seat('badger-2971'));
  assert.equal(titleFor(b, 's1', { sid: 's1', addr: 'alice.otter-4821' }), 'alice.badger-2971', 'switched rooms');
  assert.equal(titleFor(a, 's2', { sid: 's1', addr: 'alice.otter-4821' }), null, 'not this session\'s hello');
  assert.equal(titleFor(hi('s2', seat()), 's2', { sid: 's1', addr: 'alice.otter-4821' }), 'alice.otter-4821', 'after /clear');
  assert.equal(titleFor(a, 's1', 's1'), 'alice.otter-4821', 'a sid-only mark (older module state) titles once more');
  assert.equal(titleFor(hi('s1', seat('otter-4821', 'claude')), 's1', undefined), null, 'the room\'s Claude keeps its launch name');
  assert.equal(titleFor(hi('s1', null), 's1', undefined), null);
  assert.equal(titleFor(null, 's1', undefined), null);
  // after a /sub-human leave the address goes: the title is the name alone, once
  assert.equal(titleFor(hi('s1', null), 's1', { sid: 's1', addr: 'alice.otter-4821' }), 'alice');
  assert.equal(titleFor(hi('s1', null), 's1', { sid: 's1', addr: 'alice' }), null);
});

test('prompt: the origin hand-off gives a kind only to the prompt whose text it was pushed with', async () => {
  const { originQueue } = await load();
  const q = originQueue();
  const item = q.push('@room hi', 'composer');
  assert.equal(q.take('@room hi'), 'composer');
  assert.equal(q.take('@room something else'), null, 'the only one waiting is not handed to another text');
  q.drop(item);
  assert.equal(q.take('@room hi'), null);
  q.push('one', 'peer');
  q.push('@room two', 'composer');
  assert.equal(q.take('@room two'), 'composer');
});

test('prompt: parse and parseClaude take the tag with one whitespace character after it (a newline too), as hooks/handlers/at-room.ts does', async () => {
  const p = await load();
  const rooms: [string, string | null][] = [['@room hi', 'hi'], ['@room', ''], ['@room\nhi', 'hi'], ['@Room hi', null], ['@room  x', ' x'], ['@roommate hi', null], ['room: hi', null], [' @room hi', null]];
  for (const [text, want] of rooms) {
    assert.equal(p.parse(text), want, JSON.stringify(text));
  }
  const claudes: [string, string | null][] = [['@claude plan', 'plan'], ['@claude\nplan', 'plan'], ['@Claude', null], ['@claude', ''], ['@claudette', null]];
  for (const [text, want] of claudes) {
    assert.equal(p.parseClaude(text), want, JSON.stringify(text));
  }
});

test('prompt: an @room the shim could not handle is refused, never let through; one wording with at-room\'s', async () => {
  const p = await load();
  assert.deepEqual(p.failClosed('@room ship it'), { block: p.GATE_FAILED, suppressOriginalPrompt: true });
  assert.equal(p.failClosed('room:ship it'), null, 'there is no room: tag');
  assert.equal(p.failClosed('ship it'), null);
  assert.equal(p.failClosed(undefined), null);
  // only exit 0 (an answer) and 2 (a block) count as the hook having handled it
  // @ts-expect-error -- deliberate: null is not a number, and undefined is written out
  for (const exitCode of [1, 124, null, undefined]) assert.equal(p.shimFailed({ exitCode }), true, String(exitCode));
  for (const exitCode of [0, 2]) assert.equal(p.shimFailed({ exitCode }), false, String(exitCode));
});

test('prompt: the mod writes "working" for a typed prompt of a member (or an unknown seat), once', async () => {
  const { writesWorking } = await load();
  const hello = hi('s1', seat()); // sid and seat only
  assert.equal(writesWorking({ kind: 'composer' }, hello, null), true);
  assert.equal(writesWorking({ kind: 'bridge' }, null, 'idle_prompt'), true, 'unknown seat: presence.ts decides');
  assert.equal(writesWorking({ kind: 'composer' }, hello, 'working'), false, 'already working');
  assert.equal(writesWorking({ kind: 'peer' }, hello, null), false, 'not typed');
  assert.equal(writesWorking(undefined, hello, null), false);
  assert.equal(writesWorking({ kind: 'composer' }, hi('s1', null), null), false, 'no seat');
  const roomClaude = hi('s1', seat('otter-4821', 'claude'));
  assert.equal(writesWorking({ kind: 'composer' }, roomClaude, null), false, 'the room\'s Claude refuses typed prompts');
});

test('prompt: receiptBook keeps only an @room stop\'s own warning row, as the receipt alone, once', async () => {
  const { receiptBook, STOP_FRAME } = await load();
  const book = receiptBook(2);
  const notice = (text: string) => ({ type: 'system', name: 'informational', content: [{ type: 'text', text }] });
  // hooks/handlers/at-room.ts's receipts: the whole stop reason is matched, so an @room's and an @claude's never cross
  const SENT = "✓ sent to room otter-4821 (Claude wasn't asked)", WAKE = "✓ sent; the room's Claude was woken";
  assert.equal(book.rewrite(notice(`${STOP_FRAME}${SENT}`)), null, 'nothing waiting: the engine\'s words stay');
  book.expect(SENT);
  assert.equal(book.rewrite(notice(`${STOP_FRAME}${WAKE}`)), null, 'another receipt');
  assert.equal(book.rewrite({ type: 'user', isMeta: true, content: [{ type: 'text', text: `${STOP_FRAME}${SENT}` }] }), null, 'the model\'s copy is left alone');
  assert.equal(book.rewrite(notice(SENT)), null, 'no frame');
  assert.deepEqual(book.rewrite(notice(`${STOP_FRAME}${SENT}`)), notice(SENT));
  assert.equal(book.rewrite(notice(`${STOP_FRAME}${SENT}`)), null, 'once');
  book.expect('a'); book.expect('b'); book.expect('c');
  assert.equal(book.size, 2, 'a stop whose row never came is forgotten');
  assert.equal(book.rewrite(notice(`${STOP_FRAME}a`)), null);
  assert.deepEqual(book.rewrite(notice(`${STOP_FRAME}c`)), notice('c'));
  book.expect(''); book.expect(undefined);
  assert.equal(book.size, 1);
  assert.equal(book.rewrite(null), null);
  assert.equal(book.rewrite({ type: 'system', content: [{ type: 'text', text: `${STOP_FRAME}b` }, { type: 'text', text: 'x' }] }), null, 'one text block only');
});

test('prompt (stage 8f item 4): the model row of an @claude line\'s stop names @claude, an @room line\'s @room', async () => {
  const { receiptBook, STOP_FRAME } = await load();
  const book = receiptBook();
  const WAKE = "✓ sent; the room's Claude was woken", SENT = "✓ sent to room otter-4821 (Claude wasn't asked)";
  const meta = (text: string) => ({ type: 'user', isMeta: true, content: [{ type: 'text', text }] });
  book.expect(WAKE, '@claude');
  book.expect(SENT);
  assert.deepEqual(book.modelRow(meta(`${STOP_FRAME}${WAKE}`)), meta(`sub-human: the person's @claude line above went to the room, not to you (${WAKE}); nothing is asked of you.`));
  assert.deepEqual(book.modelRow(meta(`${STOP_FRAME}${SENT}`)), meta(`sub-human: the person's @room line above went to the room, not to you (${SENT}); nothing is asked of you.`));
});

test('prompt: roomClaudeCommand refuses a command a person types into the room\'s Claude (/clear too); its launch and other origins run', async () => {
  const { roomClaudeCommand } = await load();
  assert.match(must(roomClaudeCommand('clear', { kind: 'composer' }, 'otter-4821')), /^✗ the room's Claude takes no typed input, commands included; .*claude\.otter-4821$/);
  assert.ok(roomClaudeCommand('compact', { kind: 'bridge' }, 'otter-4821'));
  assert.equal(roomClaudeCommand('sub-human', { kind: 'composer' }, 'otter-4821'), null, 'its launch: at-room answers a typed one');
  assert.equal(roomClaudeCommand('clear', { kind: 'sdk' }, 'otter-4821'), null, 'the launcher, not a person');
  assert.equal(roomClaudeCommand('clear', { kind: 'composer' }, undefined), null, 'a member\'s session');
});

test('prompt: a paste that starts the prompt is unwrapped before the tag is read (live: a pasted "@room …" went to the model)', async () => {
  const { parse, parseClaude, isAtRoom, unwrapLead } = await load();
  const pasted = '\n\n<pasted_content id="1">\n@room the long notes\nline two\n</pasted_content id="1">\n';
  assert.equal(isAtRoom(pasted), true);
  assert.equal(parse(pasted), 'the long notes\nline two');
  assert.equal(parse(`${pasted}and after`), 'the long notes\nline twoand after', 'the text after the paste follows its body');
  assert.equal(parseClaude('<pasted_content id="2">\n@claude plan it\n</pasted_content id="2">'), 'plan it');
  assert.equal(parse('<pasted_content id="1">\nnot a tag @room\n</pasted_content id="1">'), null);
  assert.equal(parse('hello <pasted_content id="1">\n@room x\n</pasted_content id="1">'), null, 'a paste later in the prompt is just words');
  assert.deepEqual(unwrapLead('@room plain'), { text: '@room plain', unwrapped: false });
});
