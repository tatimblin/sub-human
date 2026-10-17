// mod/core/command.ts in node: when the module answers /sub-human itself, what it hands hooks/handlers/join.ts, how it reads
// the reply, and how the reply goes out (an output row only when nothing secret can be in it). The wiring is in
// mod/test/command.test.ts (npm run test:mods); join.ts's side of the reply is test/hooks/join.node-test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { JoinReply, RunOutput } from '../mod/core/types.ts';
import type * as commandMod from '../mod/core/command.ts';
import type * as inviteSecretMod from '../lib/remote/invite-secret.ts';
import { must } from './support/must.ts';

const PLUGIN = path.join(import.meta.dirname, '..');
const load = (): Promise<typeof commandMod> => import(path.join(PLUGIN, 'mod', 'core', 'command.ts'));
const ran = (o: unknown, exitCode = 0): RunOutput => ({ exitCode, stdout: typeof o === 'string' ? o : JSON.stringify(o) + '\n', stderr: '' });
const NONCE = 'ab'.repeat(16);

test('command: it answers what was typed here, and through Remote Control only what can hold no PIN; never the room\'s Claude, the SDK or a plugin', async () => {
  const { answersItself } = await load();
  const run = (kind: string, args = '') => {
    const e = { command: 'sub-human:sub-human', args, origin: { kind } };
    return answersItself(e, { nonce: NONCE });
  };
  assert.equal(run('composer'), true);
  assert.equal(run('composer', 'join dev vole-1234 4821'), true, 'here a PIN is safe: the answer adds no row');
  for (const kind of ['bridge', 'sdk', 'plugin', 'peer', 'unclassified']) assert.equal(run(kind), false, kind);
  assert.equal(answersItself({ args: '', origin: { kind: 'composer' } }, { nonce: NONCE, roomClaude: true }), false, 'the room\'s Claude binds through the classic hook');
  assert.equal(answersItself({ args: '', origin: { kind: 'composer' } }, { nonce: null }), false, 'no nonce: join.ts could not tell it is the module');
});

test('command: mayHoldSecret, the rule join answers hidden by', async () => {
  const { mayHoldSecret } = await load();
  const cases: [string, boolean][] = [['', false], ['help', false], ['leave', false], ['bob vole-1234', false], ['join x', true], ['invite --web', true], ['admit', true], ['bob 482', true], ['bob 48', false]];
  for (const [args, want] of cases) {
    assert.equal(mayHoldSecret(args), want, args);
  }
});

test('command: a word shaped like an invite line\'s SECRET is hidden wherever it is typed, a paste that lost a character too', async () => {
  const { mayHoldSecret, hasPinWord, SECRET_WORD } = await load();
  const secret = await import(path.join(PLUGIN, 'lib', 'remote', 'invite-secret.ts')) as typeof inviteSecretMod; // a dynamic import, typed
  const word = secret.encode(secret.mint(), Buffer.alloc(8, 7));
  assert.match(word, SECRET_WORD);
  for (const args of [word, `bob ${word}`, `devbox vole-1234 ${word}`, word.toUpperCase(), word.slice(1), `${word}x`]) {
    assert.equal(mayHoldSecret(args), true, args);
    assert.equal(hasPinWord(args), true, args);
  }
  for (const args of ['bob vole-1234', 'a-very-long-name-with-dashes-in-it vole-1234', 'abcdefghij']) assert.equal(mayHoldSecret(args), false, args);
});

test('command: the payload is the UserPromptExpansion join.ts reads, marked as the module\'s', async () => {
  const { joinPayload } = await load();
  const p = joinPayload({ sid: 's1', cwd: '/w', args: 'invite', nonce: NONCE });
  assert.deepEqual([p.hook_event_name, p.session_id, p.cwd, p.command_name, p.command_args, p.sub_human_via, p.sub_human_nonce],
    ['UserPromptExpansion', 's1', '/w', 'sub-human:sub-human', 'invite', 'command.run', NONCE]);
});

test('command: a reply is read as a join, a notice, or a failure (one line pointing to the doctor); a classic block is a failure here', async () => {
  const { readReply } = await load();
  const joined = readReply(ran({ hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: 'SUB-HUMAN: …' }, subHuman: { say: 'joined vole-1234 as bob, with alice', joined: true, shareable: true } }));
  assert.deepEqual(joined, { kind: 'joined', context: 'SUB-HUMAN: …', lines: ['joined vole-1234 as bob, with alice'] });
  const say = readReply(ran({ subHuman: { say: 'invite to room vole-1234 …\n\n  /sub-human join me@box vole-1234 4821\n', refused: false, shareable: false } }));
  assert.deepEqual(say, { kind: 'say', lines: ['invite to room vole-1234 …', '  /sub-human join me@box vole-1234 4821'], refused: false, shareable: false }, 'blank lines dropped');
  for (const r of [ran({ decision: 'block', reason: 'sub-human: x' }), ran('not json'), null]) {
    const f = readReply(r);
    assert.equal(f.kind, 'failed');
    assert.deepEqual(f.lines, ['✗ /sub-human did not finish here. Run /sub-human doctor.']);
  }
  assert.deepEqual(readReply(ran('', 1)).lines, ['✗ /sub-human did not finish here (exit 1). Run /sub-human doctor.'], 'an exit with nothing on stderr says its code');
});

test('verify12 local/37: a run that did not answer says how long it ran and what stderr said last; a PIN- or SECRET-shaped word in it is masked', async () => {
  const { readReply, failDetail, lastLine } = await load();
  const run = { exitCode: 1, stdout: '', stderr: 'TypeError: x\n    at f (a.ts:1)\nsub-human: room vole-1234 is locked (members.json)\n\n' };
  assert.deepEqual(readReply(run, { ms: 10_012 }).lines, ['✗ /sub-human did not finish here (after 10.0 s: room vole-1234 is locked (members.json)). Run /sub-human doctor.']);
  assert.deepEqual(readReply(null, { ms: 10_000, error: new Error('process timed out\nafter 10000 ms') }).lines,
    ['✗ /sub-human did not finish here (after 10.0 s: after 10000 ms). Run /sub-human doctor.'], 'a rejection: its message\'s last line');
  assert.equal(failDetail({ ms: 250, exitCode: 0 }), 'after 0.3 s');
  assert.equal(failDetail({}), '');
  assert.equal(lastLine(`join dev vole-1234 4821 2hmejp4am3wm6rh3767dwrkeg99yyp05ry9js2b.`), 'join dev vole-1234 … …');
  assert.equal(lastLine('x'.repeat(400)).length, 160);
});

test('a lease that did not hold the nonce is read as stale (nothing ran: the module says hello and asks again); a seat gone after a failure is said', async () => {
  const { readReply, goneAfter, leftName, failLogLine, appendCapped } = await load();
  const stale = readReply(ran({ subHuman: { lease: 'stale' } }));
  assert.equal(stale.kind, 'stale');
  assert.match(must(stale.lines[0]), /lease did not hold/);
  assert.equal(readReply(ran({ subHuman: { lease: 'stale', say: 'x' } })).kind, 'say', 'a reply with a say is that reply');
  const failed = readReply(null);
  const seat = { name: 'bob', code: 'vole-1234', role: 'member' };
  assert.equal(goneAfter(failed, seat, null), 'this session\'s seat in vole-1234 is gone: the command finished after the wait · /sub-human joins again');
  assert.equal(goneAfter(failed, seat, { code: 'vole-1234' }), null, 'still seated: nothing to say');
  assert.equal(goneAfter({ kind: 'say', lines: [], refused: false, shareable: true }, seat, null), null, 'a reply that came says it itself');
  assert.equal(leftName('leave', failed, seat), null);
  assert.equal(leftName('leave', failed, seat, { gone: true }), 'bob', 'a leave that finished after the wait is a leave');
  assert.equal(failLogLine(0, 'join dev vole-1234 4821', '✗ /sub-human did not finish here.'), '1970-01-01T00:00:00.000Z /sub-human join: /sub-human did not finish here.');
  assert.equal(failLogLine(null, 'Bob vole-1234', 'x'), '- /sub-human NAME: x', 'a name is not logged');
  assert.equal(appendCapped('a\nb\n', 'c', 2), 'b\nc\n');
});

test('command: every reply is notices with an empty answer (no row, nothing for the model to repeat)', async () => {
  const { answerOf } = await load();
  const help: JoinReply = { kind: 'say', lines: ['commands:', '  /sub-human …'], refused: false, shareable: true };
  assert.deepEqual(answerOf(help), { result: {}, logs: help.lines });
  const secret: JoinReply = { kind: 'say', lines: ['  /sub-human join me@box vole-1234 4821'], refused: false, shareable: false };
  assert.deepEqual(answerOf(secret), { result: {}, logs: secret.lines });
  assert.deepEqual(answerOf({ kind: 'failed', lines: ['✗ x'] }), { result: {}, logs: ['✗ x'] });
});

test('command: an invite\'s status fits the terminal: the whole line (the PIN first) when it fits or the width is unknown, else the PIN and SECRET with the notices that give the line; a cancel of the pinned invite unpins it (item 2)', async () => {
  const { pinFor, cancels, readReply, STATUS_LEAD } = await load();
  const status = `PIN 4821 · /sub-human join me@box vole-1234 ${'a'.repeat(39)}`;
  const p = { status, ms: 1000, short: `PIN 4821 · SECRET ${'a'.repeat(39)}`, cut: ['send this line:', '  /sub-human join me@box vole-1234 SECRET'] };
  assert.deepEqual(pinFor(p, ['whole'], STATUS_LEAD + status.length), { status, lines: ['whole'] });
  assert.deepEqual(pinFor(p, ['whole'], undefined), { status, lines: ['whole'] });
  assert.deepEqual(pinFor(p, ['whole'], 90), { status: p.short, lines: p.cut });
  assert.deepEqual(pinFor({ status, ms: 1 }, ['whole'], 40), { status, lines: ['whole'] }, 'no short form: the whole line, cut by the terminal');
  const r = readReply({ exitCode: 0, stdout: JSON.stringify({ subHuman: { say: 'x', shareable: false, pinned: { status, ms: 5, short: p.short, cut: 'a\nb', ref: 'abcdef012345' } } }), stderr: '' });
  assert.deepEqual(r.kind === 'say' && r.pinned, { status, ms: 5, short: p.short, cut: ['a', 'b'], ref: 'abcdef012345' });
  const ok: JoinReply = { kind: 'say', lines: ['invite abcdef012345 cancelled'], refused: false, shareable: true };
  assert.equal(cancels('invite --cancel', ok, 'abcdef012345'), true);
  assert.equal(cancels('invite --cancel abcdef012345', ok, 'abcdef012345'), true);
  assert.equal(cancels('invite --cancel 111111111111', ok, 'abcdef012345'), false, 'another invite');
  assert.equal(cancels('invite --cancel', { ...ok, refused: true }, 'abcdef012345'), false);
  assert.equal(cancels('leave', ok, 'abcdef012345'), false);
});
