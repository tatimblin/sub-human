// mod/core/copy.ts in node (PLAN-JOIN step 5; 0.6.1: the module asks itself): the copy question and its answer, which
// clipboard tool runs (process spawning stubbed: nothing here writes a real clipboard), that the PIN is never what is
// copied, and an invite gone. The wiring (the module's own dialog, the copy through $.process.run) is in
// mod/test/copy.test.ts (npm run test:mods).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  copyChoiceOf, copyLine, copyBook, clipboardCommands, copyTo, copyNews,
  COPY_QUESTION, COPY_HEADER, COPY_OPTIONS, COPY, SKIP, COPIED, AUTO_COPIED, NO_TOOL, GONE, NOT_COPIED, CLIPBOARD_TIMEOUT_MS, type Runner,
} from '../mod/core/copy.ts';
import { readReply, answerOf } from '../mod/core/command.ts';

const REF = '3f9c2a1b7e0d';
const SECRET = 'K'.repeat(39);
const LINE = `/sub-human join https://box.tail1a2b.ts.net/sub-human/otter-4821#${SECRET}`;
const PIN = '4821';

const PLUGIN = path.join(import.meta.dirname, '..');

test('copy question: as the plan words it, two labels alone, a short header', () => {
  assert.equal(COPY_QUESTION, 'Copy the invite?');
  assert.deepEqual(COPY_OPTIONS, [COPY, SKIP]);
  assert.ok(COPY_HEADER.length <= 12);
});

test('copy question: Copy and Skip are choices; dismissed, text typed or a label edited is none', () => {
  assert.equal(copyChoiceOf(COPY), 'copy');
  assert.equal(copyChoiceOf(SKIP), 'skip');
  assert.equal(copyChoiceOf(null), null);
  assert.equal(copyChoiceOf(''), null);
  assert.equal(copyChoiceOf('yes please'), null);
  assert.equal(copyChoiceOf('copy'), null, 'the labels exactly');
});

test('copy book: lines by ref for the invite\'s life and while it is open; the session\'s choice', () => {
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

test('copy question: what the person sees, and what only the debug log keeps', () => {
  assert.equal(COPIED, 'copied');
  assert.equal(AUTO_COPIED, 'line copied');
  assert.equal(NO_TOOL, 'No clipboard tool found; the line is pinned on your status line.');
  assert.deepEqual([COPIED, AUTO_COPIED, NOT_COPIED, NO_TOOL, GONE].map(copyNews), [false, false, false, true, true]);
});
