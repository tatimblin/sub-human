// mod/core/command.ts in node: when the module answers /sub-human itself, what it hands hooks/join.ts, how it reads
// the reply, and how the reply goes out (an output row only when nothing secret can be in it). The wiring is in
// mod/test/command.test.ts (npm run test:mods); join.ts's side of the reply is test/hooks/join.node-test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { JoinReply, RunOutput } from '../mod/core/types.ts';

const PLUGIN = path.join(import.meta.dirname, '..');
const load = (): Promise<typeof import('../mod/core/command.ts')> => import(path.join(PLUGIN, 'mod', 'core', 'command.ts'));
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
  assert.equal(run('bridge', 'leave'), true);
  for (const args of ['join dev vole-1234 4821', 'invite', 'admit', 'bob vole-1234 4821']) assert.equal(run('bridge', args), false, args);
  for (const kind of ['sdk', 'plugin', 'peer', 'unclassified']) assert.equal(run(kind), false, kind);
  assert.equal(answersItself({ args: '', origin: { kind: 'composer' } }, { nonce: NONCE, roomClaude: true }), false, 'the room\'s Claude binds through the classic hook');
  assert.equal(answersItself({ args: '', origin: { kind: 'composer' } }, { nonce: null }), false, 'no nonce: join.ts could not tell it is the module');
});

test('command: mayHoldSecret is hooks/join.ts\'s rule for a hidden reply', async () => {
  const { mayHoldSecret } = await load();
  const src = fs.readFileSync(path.join(PLUGIN, 'hooks', 'join.ts'), 'utf8');
  assert.ok(src.includes("['join', 'invite', 'admit'].includes(args[0]) || args.some(a => DIGITS.test(a))"));
  assert.ok(src.includes('const DIGITS = /^[0-9]{3,10}$/;'));
  const cases: [string, boolean][] = [['', false], ['help', false], ['leave', false], ['bob vole-1234', false], ['join x', true], ['invite --web', true], ['admit', true], ['bob 482', true], ['bob 48', false]];
  for (const [args, want] of cases) {
    assert.equal(mayHoldSecret(args), want, args);
  }
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
  for (const r of [ran({ decision: 'block', reason: 'sub-human: x' }), ran('', 1), ran('not json'), null]) {
    const f = readReply(r);
    assert.equal(f.kind, 'failed');
    assert.deepEqual(f.lines, ['✗ /sub-human did not finish here. Run /sub-human doctor.']);
  }
});

test('command: here every reply is notices with an empty answer (no row, nothing for the model to repeat); through Remote Control only a shareable one is the output row', async () => {
  const { answerOf } = await load();
  const help = { kind: 'say', lines: ['commands:', '  /sub-human …'], shareable: true } as JoinReply; // no refused: answerOf never reads it
  assert.deepEqual(answerOf(help), { result: {}, logs: help.lines });
  assert.deepEqual(answerOf(help, { bridge: true }), { result: { text: 'commands:\n  /sub-human …' }, logs: [] });
  const secret = { kind: 'say', lines: ['  /sub-human join me@box vole-1234 4821'], shareable: false } as JoinReply;
  assert.deepEqual(answerOf(secret), { result: {}, logs: secret.lines });
  const bridge = answerOf(secret, { bridge: true });
  assert.ok(!JSON.stringify(bridge.result).includes('4821'), 'the PIN never goes to the phone or the model');
  assert.deepEqual(answerOf({ kind: 'failed', lines: ['✗ x'] }), { result: {}, logs: ['✗ x'] });
});
