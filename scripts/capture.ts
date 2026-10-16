#!/usr/bin/env node
/**
 * capture: record the demo's panes for the trailer: trailer/capture/<take>/capture.jsonl + run.json, the format the
 * trailer renderer reads (a hand-made sample: trailer/capture/fixture/).
 *
 *   capture.ts start <dir> [--sessions alice=sh-alice,bob=sh-bob,claude=sh-claude] [--interval 100] [--take NAME]
 *                         (a frame's session is the key: demo.sh --film passes tristan=sh-tristan,jess=sh-jess,claude=sh-claude)
 *                         the poller (demo.sh --film runs it in the background): every --interval ms, `tmux capture-pane
 *                         -ep` of each session; a frame line only when that pane's text changed. A session not there
 *                         yet (sh-claude before S1) or gone for a moment is skipped. SIGTERM/SIGINT: a last poll, then
 *                         the file is finalised (meta first with every session's size and the room, then all lines by t)
 *   capture.ts mark <scene> <beat> <caption>     a marker line in the active capture (none active: does nothing)
 *   capture.ts scene <scene> start|ok|aborted [reason]   a scene's timing and status in the active take's run.json
 *   capture.ts stop [--checks FILE]              stop the active poller and wait for it to finalise; with --checks,
 *                                                put that checks.json's verdict in run.json
 *
 * Lines (t = ms since the capture started, one monotonic clock across processes: process.hrtime):
 *   {"t":0,"kind":"meta","sessions":{"alice":{"cols":120,"rows":36},…},"room":"vole-8126"}
 *   {"t":1234,"kind":"frame","session":"alice","ansi":"<capture-pane -ep, rows joined by \n>"}
 *   {"t":1300,"kind":"marker","scene":"S4","beat":"plan","caption":"…"}
 *
 * The active capture is named in $CAPTURE_ACTIVE (default trailer/capture/.active.json): {dir, pid, t0}.
 * Env: SUB_HUMAN_HOME / SUB_HUMAN_ROOM for the room code (scripts/snap.ts roomCode()).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { readJson } from './lib/io.ts';

const require = createRequire(import.meta.url);
// snap.ts loads the plugin's identity lib: only the poller's last step needs it
const snapLib = (): typeof import('./snap.ts') => require('./snap.ts');

/** A pane as grab() reads it. */
export interface Pane { ansi: string, cols: number, rows: number }
export interface Size { cols: number, rows: number }
export interface FrameLine { t: number, kind: 'frame', session: string, ansi: string }
/** The command line: positional args in `_`, each `--name value` as a key. */
export interface Opts { _: string[], [flag: string]: string | string[] | undefined }
/** The active capture file's content. */
interface Active { dir: string, pid: number, t0: string }
interface SceneRec { scene?: string, startT?: number, started?: string, endT?: number, ended?: string, status?: string, reason?: string }
interface RunJson { scenes?: unknown, [k: string]: unknown }
interface ChecksJson { _meta?: { summary?: unknown }, [scene: string]: unknown }
export interface Verdict { error?: string, summary?: unknown, failed?: string[], pass?: boolean }

const REPO = path.resolve(import.meta.dirname, '..');
const ACTIVE = () => process.env.CAPTURE_ACTIVE || path.join(REPO, 'trailer', 'capture', '.active.json');
const DEFAULT_SESSIONS = 'alice=sh-alice,bob=sh-bob,claude=sh-claude';

const now = () => process.hrtime.bigint();
const msSince = (t0: string | bigint): number => Number((now() - BigInt(t0)) / 1_000_000n);
const line = (o: unknown): string => JSON.stringify(o) + '\n';
const writeJson = (f: string, v: unknown): void => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1) + '\n'); fs.renameSync(f + '.tmp', f); };

/** "alice=sh-alice,bob=sh-bob" -> [['alice','sh-alice'], …] */
export const parseSessions = (s?: string | null): Array<[string, string]> => String(s || DEFAULT_SESSIONS).split(',').filter(Boolean).map((x): [string, string] => { const [k = '', v] = x.split('='); return [k, v || `sh-${k}`]; });

function tmux(args: string[]): Promise<string | null> {
  return new Promise(resolve => execFile('tmux', args, { encoding: 'utf8', maxBuffer: 16 << 20 }, (err, out) => resolve(err ? null : out)));
}

/** One pane: {ansi, cols, rows}, or null when the session is not there. ansi has no trailing newline. */
export async function grab(target: string): Promise<Pane | null> {
  const t = target.includes(':') ? target : `${target}:`;
  const [out, dims] = await Promise.all([tmux(['capture-pane', '-e', '-p', '-t', t]), tmux(['display-message', '-p', '-t', t, '#{pane_width} #{pane_height}'])]);
  if (out == null) return null;
  const [cols, rows] = String(dims || '').trim().split(' ').map(Number);
  return { ansi: out.replace(/\n$/, ''), cols: cols || 0, rows: rows || 0 };
}

/**
 * The poller's state machine, apart from tmux and timers (tests drive it): feed(name, pane) returns the frame line to
 * write or null (unchanged / no pane), and remembers each session's latest size.
 */
export function framer(): { sizes: Record<string, Size>, feed(name: string, pane: Pane | null, t: number): FrameLine | null } {
  const last = new Map<string, string>(), sizes: Record<string, Size> = {};
  return {
    sizes,
    feed(name, pane, t) {
      if (!pane) return null;
      sizes[name] = { cols: pane.cols, rows: pane.rows };
      if (last.get(name) === pane.ansi) return null;
      last.set(name, pane.ansi);
      return { t, kind: 'frame', session: name, ansi: pane.ansi };
    },
  };
}

/** Each line of a file, read in chunks (a long take is hundreds of MB: more than one JS string holds). */
function* fileLines(file: string): Generator<string> {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  const buf = Buffer.alloc(1 << 20);
  let rest = Buffer.alloc(0), n: number;
  try {
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      let chunk = Buffer.concat([rest, buf.subarray(0, n)]), i: number;
      while ((i = chunk.indexOf(10)) >= 0) { yield chunk.subarray(0, i).toString('utf8'); chunk = chunk.subarray(i + 1); }
      rest = Buffer.from(chunk);
    }
    if (rest.length) yield rest.toString('utf8');
  } finally { fs.closeSync(fd); }
}

/** Rewrite a capture file: one meta line first (t 0), then every other line sorted by t (stable). Torn lines dropped. */
export function finalise(file: string, meta: { sessions?: Record<string, Size>, room?: string | null, [k: string]: unknown }): { lines: number, frames: number, markers: number } {
  const kept: Array<[number, unknown, string]> = []; // [t, kind, raw line]
  let prevMeta: { sessions?: Record<string, Size>, room?: string | null } = {};
  for (const l of fileLines(file)) {
    if (!l) continue;
    let o: { kind?: unknown, t?: unknown, sessions?: Record<string, Size>, room?: string | null };
    try { o = JSON.parse(l); } catch { continue; } // torn
    if (o.kind === 'meta') { prevMeta = o; continue; }
    kept.push([Number(o.t) || 0, o.kind, l]);
  }
  const order = kept.map((_k, i) => i).sort((a, b) => kept[a][0] - kept[b][0] || a - b);
  const m: Record<string, unknown> = { t: 0, kind: 'meta', sessions: { ...(prevMeta.sessions || {}), ...(meta.sessions || {}) }, room: meta.room || prevMeta.room || null };
  for (const k of Object.keys(meta)) if (!(k in m)) m[k] = meta[k];
  const fd = fs.openSync(file + '.tmp', 'w');
  try {
    fs.writeSync(fd, line(m));
    for (const i of order) fs.writeSync(fd, kept[i][2] + '\n');
  } finally { fs.closeSync(fd); }
  fs.renameSync(file + '.tmp', file);
  return { lines: kept.length + 1, frames: kept.filter(k => k[1] === 'frame').length, markers: kept.filter(k => k[1] === 'marker').length };
}

function roomNow(): string | null {
  try { return snapLib().roomCode() || null; } catch { return null; }
}

async function start(o: Opts): Promise<number> {
  const dir = path.resolve(o._[0] || '');
  if (!o._[0]) throw new Error('capture.ts start <dir>');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'capture.jsonl');
  const sessions = parseSessions(str(o.sessions));
  const interval = +(str(o.interval) || 100);
  const t0 = String(now());
  fs.writeFileSync(file, line({ t: 0, kind: 'meta', sessions: {}, room: null }));
  const take = str(o.take) || path.basename(dir);
  writeJson(path.join(dir, 'run.json'), { take, started: new Date().toISOString(), interval, sessions: Object.fromEntries(sessions), scenes: [] });
  writeJson(ACTIVE(), { dir, pid: process.pid, t0 });
  const fr = framer();
  let stopping = false, busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const t = msSince(t0);
      const panes = await Promise.all(sessions.map(([, s]) => grab(s)));
      const out = sessions.map(([name], i) => fr.feed(name, panes[i] ?? null, t)).filter(x => x !== null);
      if (out.length) fs.appendFileSync(file, out.map(line).join(''));
    } finally { busy = false; }
  };
  const timer = setInterval(() => { poll().catch(() => {}); }, interval);
  await poll();
  const finish = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    while (busy) await new Promise(r => setTimeout(r, 20));
    await poll();
    const n = finalise(file, { sessions: fr.sizes, room: roomNow() });
    const run = readJson<RunJson>(path.join(dir, 'run.json'), {});
    writeJson(path.join(dir, 'run.json'), { ...run, ended: new Date().toISOString(), durationMs: msSince(t0), room: roomNow(), counts: n });
    const a = readJson<Active | null>(ACTIVE(), null);
    if (a && a.pid === process.pid) fs.rmSync(ACTIVE(), { force: true });
    process.stderr.write(`capture: ${n.frames} frames, ${n.markers} markers -> ${path.relative(process.cwd(), file)}\n`);
    process.exit(0);
  };
  process.on('SIGTERM', () => { void finish(); });
  process.on('SIGINT', () => { void finish(); });
  return new Promise<number>(() => {}); // runs until signalled
}

/** The active capture ({dir, pid, t0}) or null (none, or its poller is gone). */
function active(): Active | null {
  const a = readJson<Active | null>(ACTIVE(), null);
  if (!a || !a.dir || !a.t0) return null;
  try { process.kill(a.pid, 0); } catch { return null; }
  return a;
}

function mark(o: Opts): number {
  const a = active();
  if (!a) return 0;
  const [scene, beat, ...cap] = o._;
  fs.appendFileSync(path.join(a.dir, 'capture.jsonl'), line({ t: msSince(a.t0), kind: 'marker', scene: scene || '', beat: beat || '', caption: cap.join(' ') }));
  return 0;
}

function scene(o: Opts): number {
  const a = active();
  if (!a) return 0;
  const [name, status, ...why] = o._;
  const f = path.join(a.dir, 'run.json');
  const run = readJson<RunJson>(f, {});
  const scenes: SceneRec[] = Array.isArray(run.scenes) ? run.scenes : [];
  const t = msSince(a.t0);
  if (status === 'start') scenes.push({ scene: name, startT: t, started: new Date().toISOString() });
  else {
    let s = scenes.filter(x => x.scene === name).at(-1);
    if (!s) { s = { scene: name }; scenes.push(s); }
    Object.assign(s, { endT: t, ended: new Date().toISOString(), status }, why.length ? { reason: why.join(' ') } : {});
  }
  writeJson(f, { ...run, scenes });
  return 0;
}

/** checks.json -> {summary, failed: [SCENE: check]} for run.json */
export function verdict(checks: string): Verdict {
  const c = readJson<ChecksJson | null>(checks, null);
  if (!c) return { error: `no checks at ${checks}` };
  const failed: string[] = [];
  for (const [k, list] of Object.entries(c)) if (!k.startsWith('_') && Array.isArray(list)) { const items: Array<{ status?: string, check?: string }> = list; for (const x of items) if (x.status === 'fail') failed.push(`${k}: ${x.check}`); }
  return { summary: (c._meta || {}).summary || null, failed, pass: failed.length === 0 };
}

async function stop(o: Opts): Promise<number> {
  const a = readJson<Active | null>(ACTIVE(), null);
  if (a && a.pid) {
    try { process.kill(a.pid, 'SIGTERM'); } catch { /* gone */ }
    // done when the poller has removed the active file (its last step) or is gone; up to 2 min: finalising a long
    // take rewrites it. (An exited poller can linger as a zombie until its parent reaps it: the file says it is done.)
    const live = () => { try { process.kill(a.pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 1200 && live() && (readJson<Partial<Active> | null>(ACTIVE(), {}) || {}).pid === a.pid; i++) await new Promise(r => setTimeout(r, 100));
  }
  const oDir = str(o.dir), checks = str(o.checks);
  const dir = oDir ? path.resolve(oDir) : a && a.dir;
  if (checks && dir) {
    const f = path.join(dir, 'run.json');
    writeJson(f, { ...readJson<RunJson>(f, {}), checks: verdict(path.resolve(checks)) });
  }
  return 0;
}

/** A flag's value as a string (a flag is never `_`). */
const str = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

function opts(args: string[]): Opts {
  const o: Opts = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) o[a.slice(2)] = args[++i]; else o._.push(a);
  }
  return o;
}

const COMMANDS: Record<string, (o: Opts) => number | Promise<number>> = { start, mark, scene, stop };

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [cmd = '', ...args] = argv;
  const run = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!run) { process.stderr.write('see the header of scripts/capture.ts for usage\n'); return 2; }
  return run(opts(args));
}

if (import.meta.main) main().then(c => process.exit(c), (e: unknown) => { process.stderr.write(`capture: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(2); });
