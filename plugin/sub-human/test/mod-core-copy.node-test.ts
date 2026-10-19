// mod/core/copy.ts in node (PLAN-JOIN step 5): the invite's copy card, its question and answer, which clipboard tool
// runs (process spawning stubbed: nothing here writes a real clipboard), that the PIN is never what is copied, and an
// invite gone before the answer. The wiring (the wake, the card, the copy through $.process.run) is in
// mod/test/copy.test.ts (npm run test:mods).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  copyAsked, copyCard, copyWake, copyLine, copyBook, clipboardCommands, copyTo, copyOutcome, copySaid,
  COPY_QUESTION, COPY, SKIP, COPIED, AUTO_COPIED, NO_TOOL, GONE, NOT_COPIED, CLIPBOARD_TIMEOUT_MS, type Runner,
} from '../mod/core/copy.ts';
import { readReply, answerOf } from '../mod/core/command.ts';
import { FOR_CLAUDE } from '../mod/core/constants.ts';
import { wakeParts } from '../mod/core/deliver.ts';

const REF = '3f9c2a1b7e0d';
const SECRET = 'K'.repeat(39);
const LINE = `/sub-human join https://box.tail1a2b.ts.net/sub-human/otter-4821#${SECRET}`;
const PIN = '4821';

/** AskUserQuestion's tool_response for the card as the hooks built it, answered with label (or as given). */
const answered = (label: string, extra: Record<string, unknown> = {}) => ({ questions: copyCard().questions, answers: { [COPY_QUESTION]: label }, ...extra });

const PLUGIN = path.join(import.meta.dirname, '..');

test('copy card: the question and its two options, as the plan words them', () => {
  const [q] = copyCard().questions;
  assert.ok(q);
  assert.equal(q.question, 'Copy the invite line to your clipboard? (the PIN is not copied)');
  assert.deepEqual(q.options.map(o => o.label), [COPY, SKIP]);
  assert.equal(q.multiSelect, false);
});

test('copy card: the call is the card\'s when it asks "copy invite REF" or carries the card\'s question; nothing else is', () => {
  assert.deepEqual(copyAsked({ questions: [{ question: `copy invite ${REF}` }] }), { ref: REF });
  assert.deepEqual(copyAsked({ questions: [{ question: `Copy invite ${REF.toUpperCase()}?` }] }), { ref: REF });
  assert.deepEqual(copyAsked(copyCard()), { ref: null }, 'the card itself (its Post\'s input): no ref, the call id says which');
  assert.equal(copyAsked({ questions: [{ question: 'admit 3f9c2a1b7e0d' }] }), null);
  assert.equal(copyAsked({ questions: [{ question: 'Should I copy invite instructions into the README?' }] }), null, 'no ref, not the card: an ordinary question');
  assert.equal(copyAsked({ questions: [{ question: `copy invite ${REF}0` }] }), null, 'not a 12-hex ref');
});

test('copy card (noise pass D): the wake is one line for the model, none for the person (no prompt they seem to have typed), the ref only', () => {
  const w = copyWake(REF);
  assert.equal(w.split('\n').length, 1);
  assert.ok(w.startsWith(FOR_CLAUDE));
  assert.equal(wakeParts(w), null, 'framed as the plugin\'s message, with no room-lines context');
  assert.match(w, new RegExp(`Call AskUserQuestion with the question "copy invite ${REF}"`));
  assert.match(w, /then reply with nothing\.$/);
  assert.doesNotMatch(w, /sub-human join|#|\b\d{4}\b/);
});

test('copy card: Copy copies the held line; Skip, AFK, a follow-up, a typed answer or an edited card copies nothing', () => {
  const input = copyCard();
  assert.deepEqual(copyOutcome(answered(COPY), input, LINE), { copy: LINE, choice: 'copy' });
  assert.deepEqual(copyOutcome(answered(SKIP), input, LINE), { say: NOT_COPIED, choice: 'skip' }, 'Skip: no card again this session');
  assert.deepEqual(copyOutcome(answered(COPY, { afkTimeoutMs: 60000 }), input, LINE), { say: NOT_COPIED }, 'AFK');
  assert.deepEqual(copyOutcome(answered(COPY, { followUp: true }), input, LINE), { say: NOT_COPIED }, 'follow-up');
  assert.deepEqual(copyOutcome(answered('yes please'), input, LINE), { say: NOT_COPIED }, 'typed its own');
  const edited = { questions: [{ ...copyCard().questions[0], options: [{ label: COPY, description: 'copy it all, the PIN too' }, { label: SKIP, description: '' }] }], answers: { [COPY_QUESTION]: COPY } };
  assert.deepEqual(copyOutcome(edited, input, LINE), { say: NOT_COPIED }, 'an edited card');
  assert.deepEqual(copyOutcome(null, input, LINE), { say: NOT_COPIED });
});

test('copy card: an invite gone before the answer (used, expired, cancelled) is said so on Copy', () => {
  assert.deepEqual(copyOutcome(answered(COPY), copyCard(), null), { say: GONE, choice: 'copy' });
  assert.equal(GONE, 'that invite is gone, run /sub-human invite again');
  const book = copyBook();
  book.hold(REF, LINE, 1000);
  assert.equal(book.lineFor(REF, 999), LINE);
  assert.equal(book.lineFor(REF, 1000), null, 'its life is over');
  book.hold(REF, LINE, 1000);
  book.keepOpen(['aaaaaaaaaaaa']);
  assert.equal(book.lineFor(REF, 0), null, 'not among the room\'s open invites (used, burnt or cancelled)');
  book.hold(REF, LINE, 1000);
  book.drop(REF);
  assert.deepEqual(book.refs(0), []);
  book.hold('not-a-ref', LINE, 1000);
  assert.deepEqual(book.refs(0), [], 'only a 12-hex ref is held');
  book.ask('toolu_1', REF);
  assert.equal(book.askedRef('toolu_1'), REF);
  assert.equal(book.askedRef('toolu_1'), null, 'read once');
  assert.equal(book.choice(), null);
  book.choose('copy');
  assert.equal(book.choice(), 'copy');
});

test('copy card: the PIN is never what is copied: join.ts\'s line excludes it, and a line with a PIN-shaped word is not held', () => {
  const status = `PIN ${PIN} · ${LINE}`;
  const r = readReply({ exitCode: 0, stdout: JSON.stringify({ subHuman: { say: 'x', shareable: false, pinned: { status, ms: 5, ref: REF, line: LINE } } }), stderr: '' });
  const out = answerOf(r);
  assert.equal(out.status?.line, LINE);
  assert.ok(!out.status.line.split(/\s+/).includes(PIN));
  const bad = readReply({ exitCode: 0, stdout: JSON.stringify({ subHuman: { say: 'x', shareable: false, pinned: { status, ms: 5, ref: REF, line: `${LINE} ${PIN}` } } }), stderr: '' });
  assert.equal(answerOf(bad).status?.line, undefined, 'a line carrying a PIN is dropped');
  assert.equal(copyLine(`${LINE} ${PIN}`), null);
  assert.equal(copyLine(`${LINE}\n${PIN}`), null);
  assert.equal(copyLine(LINE), LINE);
  const noRef = readReply({ exitCode: 0, stdout: JSON.stringify({ subHuman: { say: 'x', shareable: false, pinned: { status, ms: 5, line: LINE } } }), stderr: '' });
  assert.equal(answerOf(noRef).status?.line, undefined, 'no ref: nothing to key the line by');
});

test('clipboard: pbcopy, then wl-copy (Wayland) and xclip -selection clipboard (X11); clip.exe first under WSL', () => {
  const names = (env: Parameters<typeof clipboardCommands>[0]) => clipboardCommands(env).map(c => c.name);
  assert.deepEqual(names({}), ['pbcopy']);
  assert.deepEqual(names({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }), ['pbcopy', 'wl-copy', 'xclip']);
  assert.deepEqual(names({ DISPLAY: ':0' }), ['pbcopy', 'xclip']);
  assert.deepEqual(names({ WSL_DISTRO_NAME: 'Ubuntu' }), ['clip.exe', 'pbcopy']);
});

test('clipboard: scripts/clip.sh runs the named tool with the line on stdin, 127 when it is missing, 2 for a name it does not know', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-clip-'));
  const out = path.join(tmp, 'got');
  fs.writeFileSync(path.join(tmp, 'xclip'), `#!/bin/sh\necho "$*" > ${JSON.stringify(out)}.args\ncat > ${JSON.stringify(out)}\n`, { mode: 0o755 });
  const clip = (name: string, PATH: string) => spawnSync('/bin/sh', [path.join(PLUGIN, 'scripts', 'clip.sh'), name], { input: LINE, env: { PATH }, encoding: 'utf8' }).status;
  assert.equal(clip('xclip', `${tmp}:/usr/bin:/bin`), 0);
  assert.equal(fs.readFileSync(out, 'utf8'), LINE);
  assert.equal(fs.readFileSync(`${out}.args`, 'utf8').trim(), '-selection clipboard');
  assert.equal(clip('wl-copy', '/nonexistent'), 127);
  assert.equal(clip('rm', `${tmp}:/usr/bin:/bin`), 2);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('clipboard: the line goes on stdin (never an argument) to the first tool that exits 0; missing, failing or timed-out tools are skipped', async () => {
  const calls: { name: string; stdin: string; timeoutMs: number }[] = [];
  const stub = (codes: (number | 'reject')[]): Runner => async (name, init) => {
    calls.push({ name, ...init });
    const c = codes[calls.length - 1] ?? 127;
    if (c === 'reject') throw new Error('timed out');
    return { exitCode: c };
  };
  const cmds = clipboardCommands({ WAYLAND_DISPLAY: 'w', DISPLAY: ':0' });
  assert.equal(await copyTo(stub([127, 'reject', 0]), LINE, cmds), 'copied');
  assert.deepEqual(calls.map(c => c.name), ['pbcopy', 'wl-copy', 'xclip']);
  for (const c of calls) {
    assert.equal(c.stdin, LINE);
    assert.equal(c.timeoutMs, CLIPBOARD_TIMEOUT_MS);
    assert.ok(!c.name.includes(SECRET), 'the line is never in an argument');
  }
  calls.length = 0;
  assert.equal(await copyTo(stub([127, 1, 127]), LINE, cmds), 'none');
  assert.equal(calls.length, 3);
  assert.equal(await copyTo(stub([]), LINE, []), 'none');
});

test('copy card: what the person and the model are told', () => {
  assert.equal(COPIED, 'copied');
  assert.equal(AUTO_COPIED, 'line copied');
  assert.equal(NO_TOOL, 'No clipboard tool found; the line is pinned on your status line.');
  assert.equal(copySaid(COPIED), 'sub-human: the copy card is answered (copied); the person sees that. Reply with nothing.');
});
