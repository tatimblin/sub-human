// mod/core/leave.ts in node (docs/next/PLAN-LEAVE-CARD.md): the card after a leave, its question and answers, the
// feedback URL (only the person's text and the versions in it), which browser opener runs (stubbed), and
// scripts/open.sh's refusal of any other URL. The wiring (the wake, the card, star.sh and open.sh through
// $.process.run) is in mod/test/leave.test.ts (npm run test:mods).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  leaveAsked, leaveCard, leaveSpec, leaveQuestion, leaveWake, leaveBook, leaveOutcome, issueUrl, versionsLine,
  openCommands, openWith, leaveSaid, CLOSE, STAR, FEEDBACK, REPO_URL, FEEDBACK_MAX, OPEN_TIMEOUT_MS, type OpenRunner,
} from '../mod/core/leave.ts';
import { FOR_CLAUDE } from '../mod/core/constants.ts';
import { wakeParts } from '../mod/core/deliver.ts';

const CODE = 'otter-4821';
const PLUGIN = path.join(import.meta.dirname, '..');
/** AskUserQuestion's tool_response for the card as the hooks built it, answered with label. */
const answered = (label: string, extra: Record<string, unknown> = {}) => ({ questions: leaveCard(CODE).questions, answers: { [leaveQuestion(CODE)]: label }, ...extra });

test('leave card: one question, Close / Star on GitHub / Write feedback, in that order', () => {
  const [q, ...rest] = leaveCard(CODE).questions;
  assert.equal(rest.length, 0);
  assert.ok(q);
  assert.equal(q.question, `You left room ${CODE}. Thanks for trying sub-human!`);
  assert.equal(q.header, 'Left room');
  assert.equal(q.multiSelect, false);
  assert.deepEqual(q.options.map(o => o.label), [CLOSE, STAR, FEEDBACK]);
  assert.ok(q.header.length <= 12, 'the chip fits');
  assert.deepEqual(leaveSpec(CODE).options.map(o => o.label), [CLOSE, STAR, FEEDBACK]);
});

test('leaveAsked: the wake\'s question, the card\'s own, and nothing else', () => {
  assert.deepEqual(leaveAsked({ questions: [{ question: `left room ${CODE}` }] }), { code: CODE });
  assert.deepEqual(leaveAsked({}, { questions: leaveCard(CODE).questions }), { code: CODE });
  assert.equal(leaveAsked({ questions: [{ question: 'copy invite 3f9c2a1b7e0d' }] }), null);
  assert.equal(leaveAsked({ questions: [{ question: 'Which file should I edit?' }] }), null);
  assert.equal(leaveAsked({ questions: [{ question: 'left room otter-48211' }] }), null);
});

test('leaveWake: one framed (for Claude) line naming the code, nothing for the person', () => {
  const w = leaveWake(CODE);
  assert.ok(w.startsWith(FOR_CLAUDE));
  assert.ok(w.includes(`"left room ${CODE}"`));
  assert.equal(w.split('\n').length, 1);
  assert.equal(wakeParts(w), null, 'framed as the plugin\'s own message');
});

test('leaveBook: once per session; the card only for the room just left; done clears it', () => {
  const b = leaveBook();
  assert.equal(b.waiting(null), null);
  assert.equal(b.left(CODE), true);
  assert.equal(b.waiting(CODE), CODE);
  assert.equal(b.waiting(null), CODE);
  assert.equal(b.waiting('other-1234'), null);
  b.done();
  assert.equal(b.waiting(CODE), null);
  assert.equal(b.left('other-1234'), false, 'a second leave this session: no card');
  assert.equal(b.waiting('other-1234'), null);
});

test('leaveOutcome: each label, typed text as feedback, a note on Write feedback, AFK and an edited card as Close', () => {
  const input = { questions: leaveCard(CODE).questions };
  assert.deepEqual(leaveOutcome(answered(CLOSE), input, CODE), { kind: 'close' });
  assert.deepEqual(leaveOutcome(answered(STAR), input, CODE), { kind: 'star' });
  assert.deepEqual(leaveOutcome(answered(FEEDBACK), input, CODE), { kind: 'feedback', text: '' });
  assert.deepEqual(leaveOutcome(answered(FEEDBACK, { annotations: { [leaveQuestion(CODE)]: { notes: ' rows flicker ' } } }), input, CODE), { kind: 'feedback', text: 'rows flicker' });
  assert.deepEqual(leaveOutcome(answered('the PIN step confused me'), input, CODE), { kind: 'feedback', text: 'the PIN step confused me' });
  assert.deepEqual(leaveOutcome(answered(STAR, { afkTimeoutMs: 60000 }), input, CODE), { kind: 'close' });
  const edited = [{ ...leaveCard(CODE).questions[0], options: [{ label: STAR, description: 'x' }] }];
  assert.deepEqual(leaveOutcome({ questions: edited, answers: { [leaveQuestion(CODE)]: STAR } }, { questions: edited }, CODE), { kind: 'close' });
  assert.deepEqual(leaveOutcome(null, input, CODE), { kind: 'close' });
});

test('issueUrl: the feedback template, the text and versions by field id, the title from the first line, capped', () => {
  const u = new URL(issueUrl({ text: 'love it\nbut the rows flicker', versions: versionsLine('0.5.5', '2.1.296') }));
  assert.equal(`${u.origin}${u.pathname}`, `${REPO_URL}/issues/new`);
  assert.equal(u.searchParams.get('template'), 'feedback.yml');
  assert.equal(u.searchParams.get('title'), 'Feedback: love it');
  assert.equal(u.searchParams.get('feedback'), 'love it\nbut the rows flicker');
  assert.equal(u.searchParams.get('versions'), 'sub-human 0.5.5 · Claude Code 2.1.296');
  const none = new URL(issueUrl({ text: '', versions: '' }));
  assert.equal(none.searchParams.get('feedback'), null);
  assert.equal(none.searchParams.get('title'), 'Feedback:');
  const long = issueUrl({ text: 'x'.repeat(20_000), versions: '' });
  assert.ok(long.length < 8000, `under GitHub's URL limit (${long.length})`);
  assert.equal(new URL(long).searchParams.get('feedback')?.length, FEEDBACK_MAX + 1);
});

test('versionsLine: whichever is known', () => {
  assert.equal(versionsLine(null, null), '');
  assert.equal(versionsLine('0.5.5', null), 'sub-human 0.5.5');
  assert.equal(versionsLine(null, '2.1.296'), 'Claude Code 2.1.296');
});

test('openCommands: wslview under WSL, open, xdg-open with a display; a headless box gets open alone', () => {
  assert.deepEqual(openCommands({}).map(c => c.name), ['open']);
  assert.deepEqual(openCommands({ DISPLAY: ':0' }).map(c => c.name), ['open', 'xdg-open']);
  assert.deepEqual(openCommands({ WAYLAND_DISPLAY: 'wayland-0' }).map(c => c.name), ['open', 'xdg-open']);
  assert.deepEqual(openCommands({ WSL_DISTRO_NAME: 'Ubuntu' }).map(c => c.name), ['wslview', 'open']);
});

test('openWith: the first opener that exits 0, the URL on stdin; a rejection or 127 tries the next', async () => {
  const calls: { name: string; stdin: string; timeoutMs: number }[] = [];
  const codes = [127, 1, 0];
  const run: OpenRunner = async (name, init) => {
    calls.push({ name, ...init });
    if (calls.length === 2) throw new Error('timeout');
    return { exitCode: codes[calls.length - 1] ?? 127 };
  };
  const cmds = [{ name: 'wslview' as const }, { name: 'open' as const }, { name: 'xdg-open' as const }];
  assert.equal(await openWith(run, REPO_URL, cmds), 'opened');
  assert.deepEqual(calls.map(c => c.name), ['wslview', 'open', 'xdg-open']);
  assert.ok(calls.every(c => c.stdin === REPO_URL && c.timeoutMs === OPEN_TIMEOUT_MS));
  assert.equal(await openWith(async () => ({ exitCode: 127 }), REPO_URL, cmds), 'none');
});

test('leaveSaid: asks the model for nothing', () => {
  assert.ok(leaveSaid('closed').endsWith('Reply with nothing.'));
});

test('scripts/open.sh opens only this plugin\'s GitHub pages, and refuses an opener it does not know', () => {
  const sh = (url: string, name: string) => spawnSync('/bin/sh', [path.join(PLUGIN, 'scripts/open.sh'), name], { input: `${url}\n`, encoding: 'utf8', env: { PATH: '/nonexistent' } }).status;
  assert.equal(sh('https://evil.example/x', 'xdg-open'), 2);
  assert.equal(sh('https://github.com/tatimblin/sub-human-evil', 'xdg-open'), 2);
  assert.equal(sh(`${REPO_URL}/issues/new?x=1`, 'nope'), 2);
  // no opener on PATH: 127, so the next is tried
  assert.equal(sh(`${REPO_URL}/issues/new?x=1`, 'xdg-open'), 127);
  assert.equal(sh(REPO_URL, 'wslview'), 127);
});

test('scripts/star.sh: 127 without gh', () => {
  const r = spawnSync('/bin/sh', [path.join(PLUGIN, 'scripts/star.sh')], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
  assert.equal(r.status, 127);
});
