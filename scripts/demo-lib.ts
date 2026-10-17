#!/usr/bin/env node
/**
 * demo-lib: tmux + room-log helpers for scripts/demo.sh (no jq, no deps).
 *
 *   demo-lib.ts type  <session> <text>            type text (paste-buffer, never send-keys -l)
 *   demo-lib.ts keys  <session> <Key>…            Enter Esc Up Down Left Right Tab Space BSpace C-c C-d
 *   demo-lib.ts literal <session> <text>          type text as keystrokes (send-keys -l): for form text boxes
 *   demo-lib.ts submit <session> <text>           type text, Enter; for a "/command", Enter again if the
 *                                                  picker swallowed the first Enter. With SH_DEMO_TYPING=1 (demo.sh
 *                                                  --film) the text is typed a key at a time, at a person's pace
 *   demo-lib.ts select-row <session> <label> [--key Down|Up]   move the agent-panel cursor (❯) onto the
 *                                                  row labelled <label> (└ children too), one key at a time
 *   demo-lib.ts ready <session> [--timeout S]     handle the trust dialog (choose "Yes, I trust this folder"
 *                                                  explicitly), then wait for the prompt
 *   demo-lib.ts pane <session>                    print the pane as plain text
 *   demo-lib.ts wait-pane <session> <regex> [--timeout S] [--absent] [--what TEXT] [--below REGEX] [--new]
 *                                                  (--below: only the pane text under the last line matching REGEX;
 *                                                  --new: only a match whose text was not in the pane when the wait began)
 *   demo-lib.ts wait-subagent-row <session> [--save FILE] [--timeout S]   wait until the agent panel shows a row of
 *                                                  the seat's own subagent (a top-level row besides main and the room);
 *                                                  --save: that pane's text, at that moment
 *   demo-lib.ts wait-paint <session> [--quiet S] [--timeout S]   wait until the pane has text and is unchanged
 *                                                  for --quiet S (1; spinners and elapsed counters ignored);
 *                                                  recorded in waits.jsonl only when it times out
 *   demo-lib.ts wait-exited <session> [--timeout S]   wait until the pane's process has exited (pane_dead)
 *   demo-lib.ts wait-room [--timeout S]           wait for a room dir; prints the code
 *   demo-lib.ts wait-log --kind K [--from N] [--via V] [--count N] [--latest-plan] [--after ID]
 *                        [--text-has S] [--timeout S] [--what TEXT]
 *   demo-lib.ts approve-until <session> (--kind K [wait-log filters] | --task-done ID) [--timeout S]
 *                        play the seat's human while its Claude works: answer each permission dialog
 *                        with option 2 ("Yes, and …" for the session; else 1. Yes) until the log matches
 *                        (or, with --task-done, until <room>/tasks.json has task ID completed);
 *                        with --quiet S, then keep at it until its background agents are done (only the room
 *                        row left in its panel) and no dialog has shown for S seconds
 *   demo-lib.ts wait-holds <seat> <name> [--timeout S]   wait until <seat>'s room server holds <name>'s row
 *                                                  (members/<seat>/session.json holds, fresh)
 *   demo-lib.ts member-field <name> <field>       print members.json[name][field] ('' if none)
 *   demo-lib.ts wait-member <name> <field> --not V [--timeout S]   wait until that field differs from V
 *   demo-lib.ts count --kind K [same filters]     print the count now
 *   demo-lib.ts last-id --kind K [same filters] [--field F]   print the id (or field F) of the last matching
 *                                                  entry (0 if none)
 *   demo-lib.ts log-max                           print the highest log id
 *   demo-lib.ts json-string <text>                print text as a JSON string literal (for a tool argument in a prompt)
 *   demo-lib.ts json-field <file> <field>         print a JSON file's top-level field (exit 1: none; --film: jess's link pid)
 *   demo-lib.ts link-shape <file>                 print a link file's shape (mode, token: bool, invite: bool,
 *                                                  transport, its ssh user as …), never its token (S11, --film S2)
 *   demo-lib.ts latest-plan                       print the latest plan_rev hash
 *   demo-lib.ts readonly <session>                exit 0 if a read-only client is attached
 *   demo-lib.ts join-line <session>               print the line /sub-human invite showed in that pane, without its
 *                                                  "/sub-human " ("join DEST ROOM SECRET [--home H]"; exit 1: none)
 *   demo-lib.ts join-pin <session>                print the PIN /sub-human invite showed apart from that line (exit 1:
 *                                                  none)
 *   demo-lib.ts admit-card <session> [--timeout S]   wait for the host's join-request card in that pane and answer
 *                                                  "Let in" on it (the person's own answer; S11)
 *   demo-lib.ts wait-idle <session> [--timeout S] [--quiet S]   wait until the main prompt is idle (no
 *                                                  "esc to interrupt" and the pane unchanged for --quiet S, 3)
 *   demo-lib.ts card <session> <Not yet|Agree|Object> [note] [--dwell REGEX]   answer the open proposal: in the plan
 *                                                  view (Agree = the "Yes" that keeps the seat's mode, Object = "Tell
 *                                                  Claude what to change" + note, Not yet = Esc) or, the fallback, on the
 *                                                  card. --dwell: paging the plan view, rest 1.5 s on the first page
 *                                                  that matches REGEX (the film: a person reading that part)
 *   demo-lib.ts wait-task-list [--timeout S]      wait until the room session's native task list directory exists
 *                                                  (made before it starts: lib/room-claude.ts openTaskList)
 *   demo-lib.ts wait-tasks [--owner N] [--id N] [--subject S] [--status S] [--timeout S]   wait on <room>/tasks.json
 *   demo-lib.ts task-id [--owner N] [--subject S]   print the id of the newest such task in <room>/tasks.json
 *   demo-lib.ts task-for --owner N [--after ID] [--timeout S]   wait until the host has applied the newest task add
 *                                                  suggested for N (after log entry ID); print its task id
 *   demo-lib.ts wait-claude-idle [--after ID] [--timeout S]   wait until the room Claude's transcript has an
 *                                                  end_turn after log entry ID and 6 s of quiet
 *   demo-lib.ts wait-job-gone [--timeout S]       wait until `claude agents --json` no longer lists the room's Claude job
 *   demo-lib.ts claude-transcript                   print the room's Claude session's transcript path
 *   demo-lib.ts synthetic-claude-prompt             run hooks/run.ts at-room as the room Claude's UserPromptSubmit (shim stdin) for a
 *                                                  typed "hi" (CLAUDE_PID = the room Claude's pid); print its output
 *   demo-lib.ts prune-index <index.json> <scene>…   drop those scenes' captures (before they run again)
 *   demo-lib.ts plan-run <run.json> --all "S1 S2 …" [--fresh] [--seats "A B"] [--remote "NAME=HOME"] <scene>…   write
 *                                                  {scenes, partial}: a fresh run lists only <scene>…, a resume adds them
 *                                                  to those listed; --all order. --seats: the two people (seats: [A, B];
 *                                                  the checks default to alice and bob). --remote: a seat on another
 *                                                  machine and its sub-human home there (remote: {NAME: HOME}; --film's jess)
 *   demo-lib.ts run-words <run.json> <key> <text> [<key> <text>]…   the people's scripted words in run.json's words
 *                                                  (the checks compare the log against them)
 *   demo-lib.ts record --what TEXT [--ok false]   one line in waits.jsonl for a driver step that is not a wait
 *
 * Every wait appends {scene, what, ok, ms, time} to $SNAP_DIR/waits.jsonl (scene from $DEMO_SCENE)
 * and exits 1 on timeout (demo.sh's `need` aborts the scene on it; `settle` and evidence waits go on). --timeout 0 waits with no
 * limit (a person's own step in --human mode), printing a reminder every minute.
 *
 * Keys: when a read-only client is attached (ours or anyone's), tmux may refuse send-keys ("client is
 * read-only": it checks the best client it can find, even one on another session). So keys go through a writable helper client attached to a tiny
 * separate session (sh-keys) and `send-keys -c <helper> -t <pane>`. Raw paste-buffer bytes are no
 * substitute: Claude Code's form text fields take pasted escape sequences literally.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { roomCode, readLog, strip } from './snap.ts';
import type { LogEntry } from './snap.ts';
import * as paths from './lib/paths.ts';
import { readJson, jsonl, esc } from './lib/io.ts';
import { panelRows, subagentRows, cardState, planState, joinLineIn, pinIn, admitCardState } from './lib/panes.ts';
import type { DialogState } from './lib/panes.ts';

/**
 * A command line: positional args in `_`, each `--name value` as a string, each flag (FLAGS) as true. The options
 * the commands read are named; any other is kept as given.
 */
export interface Opts {
  _: string[];
  absent?: true; 'latest-plan'?: true; fresh?: true; new?: true;
  timeout?: string; what?: string; kind?: string; from?: string; via?: string; count?: string; after?: string;
  'text-has'?: string; 'task-done'?: string; quiet?: string; save?: string; below?: string; key?: string;
  owner?: string; subject?: string; status?: string; id?: string; not?: string; field?: string; dwell?: string;
  all?: string; seats?: string; remote?: string; ok?: string;
  [k: string]: string | string[] | true | undefined;
}
/** One subcommand: (opts, --timeout in s) -> its exit code. */
export type Command = (o: Opts, T: number) => Promise<number>;
/** members.json's room Claude (lib/room-claude.ts writes it). */
interface RoomClaude { session_id?: string, job?: string, pid?: number }
/** A task of <room>/tasks.json. */
interface RoomTask { id?: string | number, status?: string, owner?: string, subject?: string }
/** A transcript line, as far as the idle wait reads it. */
interface TranscriptLine { type?: string, timestamp?: string, message?: { stop_reason?: string } }
/** A row of `claude agents --json`. */
interface AgentRow { id?: string, sessionId?: string }

const REPO = paths.REPO;
const SNAP_DIR = () => (process.env.SNAP_DIR ? path.resolve(process.env.SNAP_DIR) : path.join(REPO, 'docs/rebuild/screens'));

const tmux = (...a: string[]): string => execFileSync('tmux', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const tgt = (s: string): string => (s.includes(':') ? s : `${s}:`);

export const KEY_BYTES: Record<string, string> = {
  Enter: '\r', Esc: '\x1b', Escape: '\x1b', Tab: '\t', BTab: '\x1b[Z', Space: ' ', BSpace: '\x7f',
  Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D', 'C-c': '\x03', 'C-d': '\x04', 'C-j': '\n',
  'C-a': '\x01', 'C-e': '\x05', 'C-u': '\x15', 'C-l': '\x0c', PageDown: '\x1b[6~', PageUp: '\x1b[5~',
};
const SEND_KEYS: Record<string, string> = { Esc: 'Escape', Space: 'Space', BSpace: 'BSpace', BTab: 'BTab' };

function readonlyAttached(session: string): boolean {
  try { return tmux('list-clients', '-t', session, '-F', '#{client_readonly}').split('\n').some(l => l.trim() === '1'); } catch { return false; }
}

let bufN = 0;
function pasteRaw(session: string, bytes: string): void {
  const buf = `shdemo-${process.pid}-${bufN++}`;
  tmux('set-buffer', '-b', buf, '--', bytes);
  // -r: keep LF as LF (default turns LF into CR); -d: delete the buffer afterwards
  tmux('paste-buffer', '-r', '-d', '-b', buf, '-t', tgt(session));
}

function typeText(session: string, text: string): void { pasteRaw(session, text); }

/**
 * The film's typing (SH_DEMO_TYPING=1): a key at a time, so a capture shows the words being typed. A small varied
 * delay per key, a little more after a space or a comma, about 4.5 s for a long line at most (each key is a send-keys -l
 * through the helper client). Text with a newline is pasted (a typed newline would submit).
 */
const filmTyping = () => process.env.SH_DEMO_TYPING === '1';
export function keyDelays(text: string, seed: number = text.length): number[] {
  const per = Math.max(12, Math.min(55, Math.round(4500 / Math.max(1, text.length))));
  let x = seed || 1;
  return [...text].map(ch => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const jitter = 0.6 + (x % 1000) / 1250; // 0.6–1.4
    return Math.round(per * jitter + (/[ ,.;:?!]/.test(ch) ? per : 0));
  });
}
async function typeHuman(session: string, text: string): Promise<void> {
  if (text.includes('\n')) return pasteRaw(session, text);
  const c = await helperClient();
  const ds = keyDelays(text);
  const chars = [...text];
  for (const [i, ch] of chars.entries()) {
    tmux('send-keys', '-c', c, '-l', '-t', tgt(session), '--', ch);
    await sleep(ds[i] ?? 0);
  }
}

const KEYS_SESSION = 'sh-keys';
function writableClient(session: string): string | null {
  try { return tmux('list-clients', '-t', session, '-F', '#{client_name} #{client_readonly}').split('\n').map(l => l.trim().split(' ')).find(([n, ro]) => n && ro === '0')?.[0] || null; } catch { return null; }
}
async function helperClient(): Promise<string> {
  let c = writableClient(KEYS_SESSION);
  if (c) return c;
  try { tmux('has-session', '-t', KEYS_SESSION); } catch { tmux('new-session', '-d', '-s', KEYS_SESSION, '-x', '20', '-y', '5', 'sleep 1000000'); }
  // a writable client needs a tty: script(1) gives it one; stdin is a pipe that never sends a byte
  spawn('sh', ['-c', `sleep 1000000 | script -q /dev/null tmux attach -t ${KEYS_SESSION} >/dev/null 2>&1`], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30 && !(c = writableClient(KEYS_SESSION)); i++) await sleep(100);
  if (!c) throw new Error('could not attach the sh-keys helper client');
  return c;
}

async function keys(session: string, list: string[], gap = 120): Promise<void> {
  // always via the helper: with no writable client anywhere tmux falls back to some read-only one
  const via = ['-c', await helperClient()];
  for (const k of list) {
    if (!(k in KEY_BYTES) && k.length !== 1) throw new Error(`unknown key ${k}`);
    tmux('send-keys', ...via, '-t', tgt(session), SEND_KEYS[k] || k);
    await sleep(k === 'Esc' || k === 'Escape' ? 400 : gap); // a lone ESC needs a pause or it merges with the next key
  }
}

async function literal(session: string, text: string): Promise<void> {
  if (filmTyping()) return typeHuman(session, text);
  tmux('send-keys', '-c', await helperClient(), '-l', '-t', tgt(session), '--', text);
}

function pane(session: string): string { return strip(tmux('capture-pane', '-p', '-J', '-t', tgt(session))); }

function record(what: string, ok: boolean, ms: number): void {
  try {
    fs.mkdirSync(SNAP_DIR(), { recursive: true });
    fs.appendFileSync(path.join(SNAP_DIR(), 'waits.jsonl'), JSON.stringify({ scene: process.env.DEMO_SCENE || '', what, ok, ms, time: new Date().toISOString() }) + '\n');
  } catch { /* best effort */ }
}

/** Poll fn until it returns a truthy value (returned) or timeoutS passes (false). recordMet: false records only a timeout. */
let nudged = 0;
async function until<T>(what: string, timeoutS: number, fn: () => T, { recordMet = true } = {}): Promise<T | false> {
  const t0 = Date.now();
  for (;;) {
    let v: T | false;
    try { v = fn(); } catch { v = false; }
    if (v) {
      if (recordMet) record(what, true, Date.now() - t0);
      process.stderr.write(`  ✓ ${what} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
      return v;
    }
    if (timeoutS > 0 && Date.now() - t0 > timeoutS * 1000) { record(what, false, Date.now() - t0); process.stderr.write(`  ✗ timeout ${timeoutS}s: ${what}\n`); return false; }
    if (!(timeoutS > 0) && Date.now() - (nudged || t0) > 60_000) {
      nudged = Date.now();
      process.stderr.write(`  … still waiting for you (${Math.round((Date.now() - t0) / 60_000)} min, no time limit): ${what}\n`);
    }
    await sleep(700);
  }
}


const HOME_DIR = paths.home;
const roomFile = (f: string): string => path.join(HOME_DIR(), 'rooms', roomCode() || '-', f);
const roomClaudeMember = (): RoomClaude => readJson<{ claude?: RoomClaude }>(roomFile('members.json'), {}).claude || {};
function roomClaudeTranscript(): string | null {
  const o = roomClaudeMember();
  if (!o.session_id) return null;
  const proj = paths.projectsDir();
  for (const d of fs.readdirSync(proj)) {
    const f = path.join(proj, d, `${o.session_id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
function filterLog(o: Opts): LogEntry[] {
  const code = roomCode();
  let es = readLog(code);
  const after = o.after;
  if (after != null) es = es.filter(e => e.id > +after);
  const kind = o.kind;
  if (kind) { const ks = kind.split(','); es = es.filter(e => ks.includes(e.kind ?? '')); }
  if (o.from) es = es.filter(e => e.from === o.from);
  if (o.via) es = es.filter(e => e.via === o.via);
  const has = o['text-has'];
  if (has) es = es.filter(e => String(e.text || '').includes(has));
  if (o['latest-plan']) {
    const lp = readLog(code).filter(e => e.kind === 'plan_rev' && e.plan_hash).at(-1);
    es = lp ? es.filter(e => e.plan_hash === lp.plan_hash) : [];
  }
  return es;
}

const FLAGS = ['absent', 'latest-plan', 'fresh', 'new']; // options that take no value

export function opts(args: string[]): Opts {
  const o: Opts = { _: [] };
  const it = args.values();
  for (const a of it) {
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (FLAGS.includes(k)) o[k] = true; else o[k] = it.next().value;
    } else o._.push(a);
  }
  return o;
}

async function ready(session: string, timeoutS: number): Promise<boolean> {
  const t0 = Date.now();
  let trusted = false;
  while (Date.now() - t0 < timeoutS * 1000) {
    const p = pane(session);
    if (/trust this folder/i.test(p) && /Yes, I trust this folder/.test(p)) {
      const lines = p.split('\n');
      const cur = lines.findIndex(l => /^\s*❯/.test(l));
      const yes = lines.findIndex(l => /Yes, I trust this folder/.test(l));
      if (cur === yes) { await keys(session, ['Enter']); trusted = true; process.stderr.write('  ✓ trust dialog: chose "Yes, I trust this folder"\n'); await sleep(1500); continue; }
      await keys(session, [cur >= 0 && cur > yes ? 'Up' : 'Down']);
      await sleep(300);
      continue;
    }
    // any other first-run dialog is never answered blindly: we just time out and report it
    if (/❯/.test(p) && /(for shortcuts|mode on|shift\+tab|\? for|Try ")/i.test(p)) {
      record(`${session} ready${trusted ? ' (trusted)' : ''}`, true, Date.now() - t0);
      return true;
    }
    await sleep(700);
  }
  record(`${session} ready`, false, Date.now() - t0);
  process.stderr.write(`  ✗ ${session}: prompt not ready after ${timeoutS}s\n`);
  return false;
}

async function submit(session: string, text: string): Promise<void> {
  if (filmTyping()) await typeHuman(session, text); else typeText(session, text);
  await sleep(500);
  await keys(session, ['Enter']);
  if (!text.startsWith('/')) return;
  // the slash picker may take the first Enter as "accept completion": check the input line
  await sleep(1200);
  const cmd = esc(text.split(' ')[0] ?? '');
  // the input line is the ❯ line right under a ──── rule (submitted prompts also show as ❯ lines)
  const p = pane(session).split('\n');
  const input = p.filter((l, i) => /^\s*❯/.test(l) && i > 0 && /^\s*─{10,}/.test(p[i - 1] ?? '')).at(-1) || '';
  if (new RegExp(`❯\\s*${cmd}`).test(input)) await keys(session, ['Enter']);
}

// ---- commands: one function per subcommand, (o, T) => exit code; o from opts(), T = --timeout (60; 0 = no limit)

const rest = (o: Opts): string => o._.slice(1).join(' ');
/** The i-th positional argument, which the command needs: a usage error when it is missing. */
const arg = (o: Opts, i: number): string => {
  const v = o._[i];
  if (v === undefined) throw new Error(`missing argument ${i + 1}`);
  return v;
};
const exit = (ok: unknown): number => (ok ? 0 : 1);
const print = (v: unknown): boolean => process.stdout.write(v + '\n');

async function selectRow(o: Opts): Promise<number> {
  const session = arg(o, 0), label = arg(o, 1);
  const re = new RegExp(`^❯\\s+(└\\s*)?[⏺◯●]\\s+${esc(label)}(\\s|$)`, 'm');
  for (let i = 0; i < 8; i++) {
    if (re.test(pane(session))) { record(`${session}: panel cursor on ${label}`, true, 0); return 0; }
    await keys(session, [o.key || 'Down']);
    await sleep(700);
  }
  record(`${session}: panel cursor on ${label}`, false, 0);
  process.stderr.write(`  ✗ ${session}: could not select the ${label} row\n`);
  return 1;
}

/** The pane text below the last line matching `below` (a regex source; '' when no line matches), or all of it. */
export function paneBelow(text: string, below?: string | null): string {
  if (!below) return text;
  const lines = text.split('\n');
  const re = new RegExp(below);
  let i = -1;
  lines.forEach((l, n) => { if (re.test(l)) i = n; });
  return i < 0 ? '' : lines.slice(i + 1).join('\n');
}

/** The texts of re's matches in now that were not in before (re's source, matched line-wise and globally). */
export function newMatches(src: string, before: string, now: string): string[] {
  const all = (t: string): string[] => [...String(t || '').matchAll(new RegExp(src, 'gm'))].map(m => m[0]);
  const old = new Set(all(before));
  return all(now).filter(m => !old.has(m));
}

async function waitPane(o: Opts, T: number): Promise<number> {
  const session = arg(o, 0), src = arg(o, 1);
  const re = new RegExp(src, 'm');
  const what = o.what || `${session} pane ${o.absent ? '!~' : '~'} /${src}/${o.below ? ` below /${o.below}/` : ''}${o.new ? ' (new)' : ''}`;
  const text = () => paneBelow(pane(session), o.below);
  const before = o.new ? text() : '';
  return exit(await until(what, T, () => (o.absent ? !re.test(text()) : o.new ? newMatches(src, before, text()).length > 0 : re.test(text()))));
}

async function waitSubagentRow(o: Opts, T: number): Promise<number> {
  const session = arg(o, 0);
  const save = o.save;
  const rows = await until(o.what || `${session}: a subagent's row in the agent panel`, T, () => {
    const p = pane(session);
    const r = subagentRows(p, roomCode() ?? '');
    if (!r.length) return false;
    if (save) { fs.mkdirSync(path.dirname(save), { recursive: true }); fs.writeFileSync(save, p + '\n'); }
    return r;
  });
  if (rows) print(rows.map(r => r.line).join('\n'));
  return exit(rows);
}

/** A pane's text without spinner glyphs and elapsed counters (they change while nothing else does). */
const paintBody = (p: string): string => p.replace(/\d+[smh]\b|[✻✶✳✢·✽*]/g, '');

async function waitPaint(o: Opts, T: number): Promise<number> {
  const session = arg(o, 0);
  const quiet = (o.quiet == null ? 1 : +o.quiet) * 1000;
  let last: string | null = null, since = 0;
  return exit(await until(o.what || `${session} painted`, T, () => {
    const body = paintBody(pane(session));
    if (!body.trim() || body !== last) { last = body; since = Date.now(); return false; }
    return Date.now() - since >= quiet;
  }, { recordMet: false }));
}

async function waitExited(o: Opts, T: number): Promise<number> {
  const session = arg(o, 0);
  return exit(await until(o.what || `${session}'s claude exited`, T,
    () => tmux('display-message', '-p', '-t', tgt(session), '#{pane_dead}').trim() === '1'));
}

async function waitRoom(_o: Opts, T: number): Promise<number> {
  const code = await until('room dir exists', T, () => roomCode());
  if (code) print(code);
  return exit(code);
}

async function waitLog(o: Opts, T: number): Promise<number> {
  const n = +(o.count || 1);
  const what = o.what || `log: ${n}× ${o.kind}${o.from ? ` from ${o.from}` : ''}${o.via ? ` via=${o.via}` : ''}${o['latest-plan'] ? ' on latest plan' : ''}`;
  return exit(await until(what, T, () => filterLog(o).length >= n));
}

async function approveUntil(o: Opts, T: number): Promise<number> {
  const session = arg(o, 0);
  const n = +(o.count || 1);
  const byTask = o['task-done'] != null;
  const target = byTask ? `task #${o['task-done']} completed` : `${n}× ${o.kind}${o.from ? ` from ${o.from}` : ''}`;
  const what = o.what || `${session}: approve its Claude's permission dialogs until ${target}`;
  let approvals = 0, last = 0, met = 0, calm = 0;
  const quietMs = +(o.quiet || 0) * 1000;
  const done = byTask
    ? () => roomTasks().some(t => String(t.id) === String(o['task-done']) && t.status === 'completed')
    : () => filterLog(o).length >= n;
  const ok = await until(what + (quietMs ? `, then its background agents finish` : ''), T, () => {
    const p = pane(session);
    if (!met && done()) met = Date.now();
    if (met && !quietMs) return true;
    if (met) {
      const busy = /Do you want to /.test(p) || panelRows(p).some(r => !r.nested && r.label !== roomCode());
      if (busy) calm = 0; else if (!calm) calm = Date.now();
      if (calm && Date.now() - calm >= quietMs) return true;
    }
    const m = /Do you want to ([^\n?]*)\?/.exec(p);
    if (m && /❯\s*1\. Yes/.test(p) && Date.now() - last > 2500) {
      last = Date.now();
      const two = /^\s*2\. Yes, (and|allow)/m.test(p);
      approvals++;
      record(`${session}: human approved "${(m[1] ?? '').trim().slice(0, 80)}" (${two ? '2. Yes, and…' : '1. Yes'})`, true, 0);
      // fire and forget; the next poll sees the result
      keys(session, two ? ['Down', 'Enter'] : ['Enter']).catch(() => {});
    }
    return false;
  });
  process.stderr.write(`  (${approvals} permission dialog${approvals === 1 ? '' : 's'} approved)\n`);
  return exit(ok);
}

async function waitHolds(o: Opts, T: number): Promise<number> {
  const seat = arg(o, 0), name = arg(o, 1);
  return exit(await until(o.what || `${seat}'s room holds ${name}'s row`, T, () => {
    const doc = readJson<{ holds?: { at: string, members?: string[] } } | null>(roomFile(path.join('members', seat, 'session.json')), null);
    const h = doc && doc.holds;
    return !!h && Date.now() - Date.parse(h.at) < 90_000 && (h.members || []).includes(name);
  }));
}

async function memberField(o: Opts): Promise<number> {
  const ms = readJson<Record<string, Record<string, unknown> | undefined> | null>(roomFile('members.json'), null);
  if (!ms) throw new Error(`cannot read ${roomFile('members.json')}`);
  print(String((ms[arg(o, 0)] || {})[arg(o, 1)] ?? ''));
  return 0;
}

async function waitMember(o: Opts, T: number): Promise<number> {
  const name = arg(o, 0), field = arg(o, 1);
  return exit(await until(o.what || `${name}'s ${field} changes`, T, () => {
    const v = (readJson<Record<string, Record<string, unknown> | undefined>>(roomFile('members.json'), {})[name] || {})[field];
    return v != null && String(v) !== String(o.not);
  }));
}

async function waitIdle(o: Opts, T: number): Promise<number> {
  const session = arg(o, 0);
  const quiet = (o.quiet == null ? 3 : +o.quiet) * 1000;
  let last: string | null = null, since = 0;
  return exit(await until(o.what || `${session} idle`, T, () => {
    const p = pane(session);
    // the scripted human declines unplanned work: a permission dialog gets Esc (recorded in waits.jsonl)
    if (/Do you want to proceed\?|Do you want to (make this edit|create)/.test(p) && /Esc to cancel/.test(p)) {
      record(`${session}: the human declined a permission dialog (Esc): ${(/^\s*(\S.*)\n\s*Run shell command|Do you want to [^\n]*/m.exec(p) || [''])[0].trim().slice(0, 80)}`, true, 0);
      keys(session, ['Esc']).catch(() => {});
      last = null; return false;
    }
    const busy = /esc to interrupt/.test(p) || cardState(p) || planState(p);
    const body = paintBody(p);
    if (busy || body !== last) { last = body; since = Date.now(); return false; }
    return Date.now() - since >= quiet;
  }));
}

/** Answer a proposal open in the plan view: Not yet = Esc, Agree = the "Yes" that keeps the mode, Object = change + note. */
async function answerPlanView(session: string, pv: DialogState, choice: string, note: string, dwell?: string): Promise<number> {
  if (choice === 'Not yet') { await keys(session, ['Escape']); record(`${session}: closed the plan view (Esc)`, true, 0); return 0; }
  // read it all, as a person would: PgDn to the end, where the hook's line names the proposal and the "Yes" that keeps the mode
  // (--dwell: a rest on the first page that shows that part)
  const dwellRe = dwell ? new RegExp(dwell, 'm') : null;
  let dwelt = false;
  const rest = async (): Promise<void> => {
    if (!dwellRe || dwelt || !dwellRe.test(pane(session))) return;
    dwelt = true;
    await sleep(1500);
    record(`${session}: rested 1.5 s on the plan page that shows /${dwell}/`, true, 1500);
  };
  await rest();
  for (let i = 0; i < 40 && !/room proposal [0-9a-f]{12}/.test(pane(session)); i++) { await keys(session, ['PageDown']); await sleep(250); await rest(); }
  const keep = (/Agree: "([^"]+)" keeps/.exec(pane(session).replace(/\s*\n\s*│?\s*/g, ' ')) || [])[1];
  const want = choice === 'Agree'
    ? pv.opts.find(x => x.label === keep) || pv.opts.find(x => /^Yes/.test(x.label))
    : pv.opts.find(x => /Tell Claude what to change|No, keep planning/.test(x.label));
  if (!want) { process.stderr.write(`no option for ${choice}\n`); return 1; }
  for (let i = 0; i < 6; i++) {
    const cur = (planState(pane(session)) || pv).opts.find(x => x.cur);
    if (!cur || cur.n === want.n) break;
    await keys(session, [cur.n < want.n ? 'Down' : 'Up']);
    await sleep(300);
  }
  if (choice === 'Object') { await literal(session, note || 'object'); await sleep(600); }
  await keys(session, ['Enter']);
  await sleep(1500);
  // an objection's note is confirmed in one more question ("Send to claude as changes requested …? Send / Discard")
  if (choice === 'Object') {
    await until(`${session}: the note's Send / Discard question`, 15, () => /❯\s*1\.\s*Send\b/.test(pane(session)));
    if (/❯\s*1\.\s*Send\b/.test(pane(session))) { await keys(session, ['Enter']); await sleep(1500); }
  }
  record(`${session}: answered in the plan view ${choice}${choice === 'Object' ? ` with note "${note}"` : ` (${want.label})`}`, true, 0);
  return 0;
}

/** Answer the fallback consent card: move onto the option, type the note (n), Enter, and confirm a review step. */
async function answerCard(session: string, choice: string, note: string): Promise<number> {
  let st = cardState(pane(session));
  const want = st?.opts.find(x => x.label === choice);
  if (!want) { process.stderr.write(`no option ${choice}\n`); return 1; }
  for (let i = 0; i < 6; i++) {
    st = cardState(pane(session));
    const cur = st && st.opts.find(x => x.cur);
    if (!cur || cur.label === choice) break;
    await keys(session, [cur.n < want.n ? 'Down' : 'Up']);
    await sleep(300);
  }
  if (note) {
    await keys(session, ['n']);
    await sleep(800);
    await literal(session, note);
    await sleep(600);
  }
  await keys(session, ['Enter']);
  await sleep(1500);
  // a review step ("Submit answers") takes one more Enter
  const p = pane(session);
  if (/Submit answers|Review your answers/i.test(p) && /❯\s*1\.\s*Submit/.test(p)) { await keys(session, ['Enter']); await sleep(800); }
  record(`${session}: answered the card ${choice}${note ? ` with note "${note}"` : ''}`, true, 0);
  return 0;
}

/** The host's join-request card (lib/remote/admission.ts): move onto "Let in" and Enter. */
async function admitCard(o: Opts, T: number): Promise<number> {
  const session = arg(o, 0);
  if (!(await until(`${session}: the join request's card open`, T, () => admitCardState(pane(session))))) return 1;
  await sleep(1200);
  for (let i = 0; i < 6; i++) {
    const st = admitCardState(pane(session));
    const cur = st && st.opts.find(x => x.cur);
    if (!cur || cur.label === 'Let in') break;
    await keys(session, ['Up']);
    await sleep(300);
  }
  await keys(session, ['Enter']);
  await sleep(1500);
  const p = pane(session);
  if (/Submit answers|Review your answers/i.test(p) && /❯\s*1\.\s*Submit/.test(p)) { await keys(session, ['Enter']); await sleep(800); }
  record(`${session}: answered the join request's card Let in`, true, 0);
  return 0;
}

async function card(o: Opts, T: number): Promise<number> {
  const [session = '', choice = '', ...noteParts] = o._;
  const note = noteParts.join(' ');
  if (!(await until(`${session}: proposal open (plan view or card)`, T, () => planState(pane(session)) || cardState(pane(session))))) return 1;
  await sleep(1200);
  const pv = planState(pane(session));
  return pv ? answerPlanView(session, pv, choice, note, o.dwell) : answerCard(session, choice, note);
}

async function waitTaskList(o: Opts, T: number): Promise<number> {
  return exit(await until(o.what || 'the room session\'s task list directory exists', T, () => fs.existsSync(paths.tasksDir(roomCode() ?? ''))));
}

const roomTasks = (): RoomTask[] => readJson<RoomTask[] | null>(roomFile('tasks.json'), []) || [];

async function waitTasks(o: Opts, T: number): Promise<number> {
  const what = o.what || `tasks.json has a task${o.id ? ' #' + o.id : ''}${o.subject ? ` "${o.subject}"` : ''}${o.owner ? ' owned by ' + o.owner : ''}${o.status ? ' ' + o.status : ''}`;
  return exit(await until(what, T, () =>
    roomTasks().some(t => (!o.id || String(t.id) === String(o.id)) && (!o.subject || t.subject === o.subject) && (!o.owner || t.owner === o.owner) && (!o.status || t.status === o.status))));
}

async function taskId(o: Opts): Promise<number> {
  const t = roomTasks().filter(x => (!o.owner || x.owner === o.owner) && (!o.subject || x.subject === o.subject)).at(-1);
  print(t ? t.id : '');
  return exit(t);
}

/** The task id the host gave the newest add suggested for owner (a task_req add after `after`), or null. */
export function taskFor(log: Array<Partial<LogEntry> & { id: number }>, owner: string | undefined, after: number | string = 0): string | null {
  const req = log.filter(e => e.kind === 'task_req' && e.op === 'add' && (e.suggest === owner || e.owner === owner) && e.id > +after).at(-1);
  const t = req && log.find(e => e.kind === 'task' && e.op === 'add' && e.req === req.id);
  return t ? String(t.task_id) : null;
}

async function taskForCmd(o: Opts, T: number): Promise<number> {
  const id = await until(o.what || `the host adds the task suggested for ${o.owner}`, T, () => taskFor(readLog(roomCode()), o.owner, o.after || 0));
  if (id) print(id);
  return exit(id);
}

async function roomClaudeTranscriptCmd(): Promise<number> {
  const f = roomClaudeTranscript();
  print(f || '');
  return exit(f);
}

async function waitRoomClaudeIdle(o: Opts, T: number): Promise<number> {
  const afterId = o.after;
  const after = afterId != null ? readLog(roomCode()).find(e => e.id === +afterId) : null;
  const t0 = (after && after.at) || new Date().toISOString();
  let n = -1, since = Date.now();
  return exit(await until(o.what || `the room Claude's turn after #${o.after || 'now'} ends`, T, () => {
    const es = jsonl<TranscriptLine>(roomClaudeTranscript() ?? '');
    if (es.length !== n) { n = es.length; since = Date.now(); return false; }
    const lastA = es.filter(e => e.type === 'assistant' && e.timestamp != null && e.timestamp > t0).at(-1);
    return !!lastA && lastA.message && lastA.message.stop_reason === 'end_turn' && Date.now() - since > 6000;
  }));
}

/** Whether `claude agents --json` output (an array) lists the room's Claude: by job id or session id (as checks/s10-leave.ts reads it). */
export const listsRoomClaude = (agents: unknown, roomClaude: RoomClaude): boolean => Array.isArray(agents) && agents.some((y: AgentRow) => (roomClaude.job && y.id === roomClaude.job) || (roomClaude.session_id && y.sessionId === roomClaude.session_id));

async function waitJobGone(o: Opts, T: number): Promise<number> {
  const roomClaude = roomClaudeMember();
  return exit(await until(o.what || `claude agents no longer lists the room's Claude job ${roomClaude.job || ''}`.trim(), T, () => {
    const agents: unknown = JSON.parse(execFileSync('claude', ['agents', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    return Array.isArray(agents) && !listsRoomClaude(agents, roomClaude);
  }));
}

/** Run a plugin hook handler (hooks/run.ts HANDLER) as the room Claude's own hook would, over the real room: the child's {status, stdout, stderr}. */
function runAsRoomClaude(handler: string, input: unknown, roomClaude: RoomClaude, env: Record<string, string> = {}): { status: number | null, stdout: string, stderr: string } {
  const r = spawnSync(process.execPath, [path.join(paths.PLUGIN, 'hooks', 'run.ts'), handler], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SUB_HUMAN_HOME: HOME_DIR(), CLAUDE_PID: String(roomClaude.pid || ''), CLAUDE_PLUGIN_ROOT: paths.PLUGIN, ...env },
  });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

async function syntheticRoomClaudePrompt(): Promise<number> {
  const roomClaude = roomClaudeMember();
  // as the mod's shim hands a typed prompt over
  const input = { hook_event_name: 'UserPromptSubmit', session_id: roomClaude.session_id, transcript_path: roomClaudeTranscript() || '', cwd: process.cwd(), prompt: 'hi', prompt_id: 'synthetic-1', permission_mode: 'plan', sub_human_origin: 'composer' };
  const r = runAsRoomClaude('at-room', input, roomClaude);
  print(JSON.stringify({ input: { prompt: input.prompt, session_id: input.session_id, pid: roomClaude.pid }, ...r }, null, 1));
  return 0;
}

async function lastId(o: Opts): Promise<number> {
  const e = filterLog(o).at(-1);
  const field = o.field;
  print(e ? (field ? e[field] ?? '' : e.id) : 0);
  return exit(e);
}

async function logMax(): Promise<number> {
  const es = readLog(roomCode());
  print(es.length ? Math.max(...es.map(e => e.id || 0)) : 0);
  return 0;
}

/** S11: a link file's shape, never its token: {mode, token: bool, invite: bool, transport}. */
async function linkShape(o: Opts): Promise<number> {
  const f = arg(o, 0);
  let st: fs.Stats;
  try { st = fs.statSync(f); } catch { return 1; }
  const l = readJson<{ transport?: unknown, token?: unknown, invite?: unknown } | null>(f, {}) || {};
  // an ssh transport's user is the login on the host (in --film your own account name): never in the evidence
  const t = l.transport && typeof l.transport === 'object' ? { ...l.transport, ...('user' in l.transport ? { user: '…' } : {}) } : l.transport;
  print(JSON.stringify({ mode: (st.mode & 0o777).toString(8), token: typeof l.token === 'string', invite: 'invite' in l, transport: t }));
  return 0;
}

async function latestPlan(): Promise<number> {
  const lp = readLog(roomCode()).filter(e => e.kind === 'plan_rev').at(-1);
  print(lp ? lp.plan_hash : '');
  return exit(lp);
}

const writeJson = (f: string, v: unknown): void => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1) + '\n'); };

async function pruneIndex(o: Opts): Promise<number> {
  const f = arg(o, 0), scenes = o._.slice(1);
  const drop = new Set(scenes);
  const index = readJson<unknown>(f, []);
  writeJson(f, (Array.isArray(index) ? index : []).filter((r: { scene?: string }) => !drop.has(r.scene ?? '')));
  return 0;
}

async function planRun(o: Opts): Promise<number> {
  const f = arg(o, 0), add = o._.slice(1);
  const all = String(o.all || '').split(' ').filter(Boolean);
  const prev: string[] = o.fresh ? [] : (readJson<{ scenes?: string[] } | null>(f, {}) || {}).scenes || [];
  const scenes = all.filter(x => prev.includes(x) || add.includes(x));
  const seats = String(o.seats || '').split(' ').filter(Boolean);
  // --remote NAME=HOME: a seat on another machine (--film's jess, over ssh) and her sub-human home there
  const remote = Object.fromEntries(String(o.remote || '').split(' ').filter(Boolean).map((kv): [string, string] => { const [k = '', v = ''] = kv.split('='); return [k, v]; }).filter(([k, v]) => k && v));
  writeJson(f, { scenes, partial: scenes.length < all.length, ...(seats.length ? { seats } : {}), ...(Object.keys(remote).length ? { remote } : {}) });
  return 0;
}

async function runWords(o: Opts): Promise<number> {
  const f = arg(o, 0), kv = o._.slice(1);
  if (kv.length % 2) throw new Error('run-words <run.json> <key> <text> …: a key with no text');
  const r = readJson<{ words?: Record<string, string> } | null>(f, {}) || {};
  const words: Record<string, string> = { ...(r.words || {}) };
  for (let i = 0; i < kv.length; i += 2) {
    const [k, v] = kv.slice(i, i + 2);
    if (k !== undefined && v !== undefined) words[k] = v;
  }
  writeJson(f, { ...r, words });
  return 0;
}

async function recordCmd(o: Opts): Promise<number> {
  record(o.what || '', o.ok !== 'false', 0);
  return 0;
}

export const COMMANDS: Record<string, Command> = {
  type: async o => { typeText(arg(o, 0), rest(o)); return 0; },
  keys: async o => { await keys(arg(o, 0), o._.slice(1)); return 0; },
  literal: async o => { await literal(arg(o, 0), rest(o)); return 0; },
  submit: async o => { await submit(arg(o, 0), rest(o)); return 0; },
  'select-row': selectRow,
  ready: async (o, T) => exit(await ready(arg(o, 0), T)),
  readonly: async o => exit(readonlyAttached(arg(o, 0))),
  pane: async o => { process.stdout.write(pane(arg(o, 0))); return 0; },
  'join-line': async o => { const l = joinLineIn(pane(arg(o, 0))); if (l) process.stdout.write(l + '\n'); return exit(!!l); },
  'join-pin': async o => { const p = pinIn(pane(arg(o, 0))); if (p) process.stdout.write(p + '\n'); return exit(!!p); },
  'admit-card': admitCard,
  'wait-pane': waitPane,
  'wait-paint': waitPaint,
  'wait-exited': waitExited,
  'wait-room': waitRoom,
  'wait-log': waitLog,
  'approve-until': approveUntil,
  'wait-holds': waitHolds,
  'member-field': memberField,
  'wait-member': waitMember,
  'wait-idle': waitIdle,
  card,
  'wait-task-list': waitTaskList,
  'wait-tasks': waitTasks,
  'task-id': taskId,
  'task-for': taskForCmd,
  'wait-subagent-row': waitSubagentRow,
  'claude-transcript': roomClaudeTranscriptCmd,
  'wait-claude-idle': waitRoomClaudeIdle,
  'wait-job-gone': waitJobGone,
  'synthetic-claude-prompt': syntheticRoomClaudePrompt,
  count: async o => { print(filterLog(o).length); return 0; },
  'last-id': lastId,
  'log-max': logMax,
  'json-string': async o => { process.stdout.write(JSON.stringify(o._.join(' '))); return 0; },
  'json-field': async o => { const v = (readJson<Record<string, unknown> | null>(arg(o, 0), {}) || {})[arg(o, 1)]; if (v != null) print(String(v)); return exit(v != null); },
  'link-shape': linkShape,
  'latest-plan': latestPlan,
  'prune-index': pruneIndex,
  'plan-run': planRun,
  'run-words': runWords,
  record: recordCmd,
};

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [cmd = '', ...args] = argv;
  const o = opts(args);
  const T = o.timeout == null ? 60 : +o.timeout; // 0 = no limit
  const run = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!run) { process.stderr.write('see the header of scripts/demo-lib.ts for usage\n'); return 2; }
  return run(o, T);
}

if (import.meta.main) main().then(c => process.exit(c), (e: unknown) => { process.stderr.write(`demo-lib: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(2); });
