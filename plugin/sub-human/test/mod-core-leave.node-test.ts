// mod/core/leave.ts in node (docs/next/PLAN-LEAVE-CARD.md): the card after a leave, its answers, the feedback URL
// (the person's text, the versions and sub-human's own masked lines, nothing of the room), which browser opener runs
// (stubbed), and scripts/open.sh's refusal of any other URL. The wiring ($.ui.ask, star.sh and open.sh through
// $.process.run) is in mod/test/leave.test.ts (npm run test:mods).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  leaveQuestion, leaveOutcome, issueUrl, versionsLine, openCommands, openWith, saidBook, sessionSnippet,
  CLOSE, STAR, LEAVE_OPTIONS, LEAVE_HEADER, REPO_URL, FEEDBACK_MAX, SNIPPET_MAX, SNIPPET_LINES, OPEN_TIMEOUT_MS, URL_MAX, type OpenRunner,
} from '../mod/core/leave.ts';

const CODE = 'otter-4821';
const PLUGIN = path.join(import.meta.dirname, '..');

test('leave card: the question, a short header, Close and Star on GitHub', () => {
  assert.equal(leaveQuestion(CODE), `You left room ${CODE}. Thanks for trying sub-human! Type below to send feedback.`);
  assert.ok(LEAVE_HEADER.length <= 12, 'the chip fits');
  assert.deepEqual(LEAVE_OPTIONS, [CLOSE, STAR]);
});

test('leaveOutcome: Close or dismissed is nothing, Star stars, any other text is feedback', () => {
  assert.deepEqual(leaveOutcome(CLOSE), { kind: 'close' });
  assert.deepEqual(leaveOutcome(null), { kind: 'close' });
  assert.deepEqual(leaveOutcome('   '), { kind: 'close' });
  assert.deepEqual(leaveOutcome(STAR), { kind: 'star' });
  assert.deepEqual(leaveOutcome(' the PIN step confused me '), { kind: 'feedback', text: 'the PIN step confused me' });
});

test('issueUrl: the feedback template, the text, versions and session by field id, the title from the first line, capped', () => {
  const u = new URL(issueUrl({ text: 'love it\nbut the rows flicker', versions: versionsLine('0.5.5', '2.1.296'), session: '> /sub-human leave' }));
  assert.equal(`${u.origin}${u.pathname}`, `${REPO_URL}/issues/new`);
  assert.equal(u.searchParams.get('template'), 'feedback.yml');
  assert.equal(u.searchParams.get('title'), 'Feedback: love it');
  assert.equal(u.searchParams.get('feedback'), 'love it\nbut the rows flicker');
  assert.equal(u.searchParams.get('versions'), 'sub-human 0.5.5 · Claude Code 2.1.296');
  assert.equal(u.searchParams.get('session'), '> /sub-human leave');
  const none = new URL(issueUrl({ text: '', versions: '' }));
  assert.equal(none.searchParams.get('feedback'), null);
  assert.equal(none.searchParams.get('session'), null);
  assert.equal(none.searchParams.get('title'), 'Feedback');
  const long = issueUrl({ text: 'x'.repeat(20_000), versions: 'sub-human 0.5.5 · Claude Code 2.1.296', session: sessionSnippet(Array(40).fill('✗ '.padEnd(200, 'é'))) });
  assert.ok(long.length <= URL_MAX, `under GitHub's URL limit (${long.length})`);
  assert.equal(new URL(long).searchParams.get('feedback')?.length, FEEDBACK_MAX + 1, 'the snippet gave way, the text stayed');
  const wide = issueUrl({ text: 'é'.repeat(20_000), versions: '', session: 'ü'.repeat(1500) });
  assert.ok(wide.length <= URL_MAX, `text other than ASCII too (${wide.length})`);
  assert.ok((new URL(wide).searchParams.get('feedback')?.length ?? 0) > 500);
});

test('saidBook: command verbs never arguments, each reply line, the latest SNIPPET_LINES', () => {
  const b = saidBook();
  b.command(`join box otter-4821 ${'K'.repeat(39)} 4090`);
  b.command('/etc/passwd');
  b.command('');
  b.note('one\ntwo\n\n');
  assert.deepEqual(b.lines(), ['> /sub-human join', '> /sub-human …', '> /sub-human', 'one', 'two']);
  for (let i = 0; i < 30; i++) b.note(`line ${i}`);
  assert.equal(b.lines().length, SNIPPET_LINES);
  assert.equal(b.lines().at(-1), 'line 29');
});

test('sessionSnippet: room codes, SECRET-shaped words and PIN-shaped numbers masked; versions kept; cut from the end', () => {
  const s = sessionSnippet([`left ${CODE} · /sub-human joins again`, `✗ secret ${'K'.repeat(39)} PIN 4090`, 'needs Claude Code 2.1.296 or newer, port 7']);
  assert.equal(s, 'left ROOM · /sub-human joins again\n✗ secret SECRET PIN NNNN\nneeds Claude Code 2.1.296 or newer, port 7');
  assert.equal(sessionSnippet([]), '');
  const cut = sessionSnippet(Array(20).fill('x'.repeat(19).concat(' ').repeat(10)));
  assert.equal(cut.length, SNIPPET_MAX + 1);
  assert.ok(cut.startsWith('…'));
});

test('versionsLine: whichever is known', () => {
  assert.equal(versionsLine(null, null), '');
  assert.equal(versionsLine('0.5.5', null), 'sub-human 0.5.5');
  assert.equal(versionsLine(null, '2.1.296'), 'Claude Code 2.1.296');
});

test('openCommands: wslview under WSL, open, xdg-open with a display; none over ssh', () => {
  assert.deepEqual(openCommands({}).map(c => c.name), ['open']);
  assert.deepEqual(openCommands({ DISPLAY: ':0' }).map(c => c.name), ['open', 'xdg-open']);
  assert.deepEqual(openCommands({ WAYLAND_DISPLAY: 'wayland-0' }).map(c => c.name), ['open', 'xdg-open']);
  assert.deepEqual(openCommands({ WSL_DISTRO_NAME: 'Ubuntu' }).map(c => c.name), ['wslview', 'open']);
  assert.deepEqual(openCommands({ SSH_CONNECTION: '10.0.0.2 50000 10.0.0.3 22', DISPLAY: ':0' }), []);
  assert.deepEqual(openCommands({ SSH_TTY: '/dev/ttys004' }), []);
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

test('scripts/open.sh opens only this plugin\'s GitHub pages, and refuses an opener it does not know', () => {
  const sh = (url: string, name: string) => spawnSync('/bin/sh', [path.join(PLUGIN, 'scripts/open.sh'), name], { input: `${url}\n`, encoding: 'utf8', env: { PATH: '/nonexistent' } }).status;
  assert.equal(sh('https://evil.example/x', 'xdg-open'), 2);
  assert.equal(sh('https://github.com/tatimblin/sub-human-evil', 'xdg-open'), 2);
  assert.equal(sh(`${REPO_URL}/../../evil/x`, 'xdg-open'), 2);
  assert.equal(sh(`${REPO_URL}@evil.example`, 'xdg-open'), 2);
  assert.equal(sh(`${REPO_URL}/issues/new?x=1`, 'nope'), 2);
  // no opener on PATH: 127, so the next is tried
  assert.equal(sh(`${REPO_URL}/issues/new?x=1`, 'xdg-open'), 127);
  assert.equal(sh(REPO_URL, 'wslview'), 127);
  // a URL with no newline after it is read all the same
  assert.equal(spawnSync('/bin/sh', [path.join(PLUGIN, 'scripts/open.sh'), 'xdg-open'], { input: REPO_URL, env: { PATH: '/nonexistent' } }).status, 127);
});

test('scripts/star.sh: 127 without gh', () => {
  const r = spawnSync('/bin/sh', [path.join(PLUGIN, 'scripts/star.sh')], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
  assert.equal(r.status, 127);
});
