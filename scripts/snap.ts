#!/usr/bin/env node
/**
 * snap: capture a tmux pane with colors and record it for the walkthrough.
 *
 *   node scripts/snap.ts <tmux-session>[,<session>…] <scene-id> "<caption>"
 *
 * Writes docs/rebuild/screens/<scene>-<session>.svg and .txt (plain text; a scene's later steps, i.e.
 * new captions, get <scene>-<n>-<session>), and appends a record to
 * docs/rebuild/screens/index.json:
 *   {scene, session, caption, time, step, svg, txt, cols, rows, room?, log?: [entries], logTo?}
 * `log` is the room-log excerpt: entries appended since the latest snap of a *different* scene
 * (so every pane of one scene carries the same step window), read from
 * $SUB_HUMAN_HOME/rooms/<code>/log.jsonl. The room is $SUB_HUMAN_ROOM, else the most recently
 * modified room dir.
 *
 * Env: SNAP_DIR (default docs/rebuild/screens), SUB_HUMAN_HOME (default ~/.sub-human),
 *      SUB_HUMAN_ROOM, SNAP_TITLE_<session with - as _> (window title override).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { render } from './ansi-svg.ts';
import { home } from './lib/paths.ts';
import { readJson, jsonl } from './lib/io.ts';

/** A room-log entry as the snaps read it (plugin lib/room/types.ts Entry, loosely: a log the demo wrote). */
export interface LogEntry {
  id: number, at?: string, from?: string, via?: string, kind?: string, to?: string, text?: string | null,
  plan_hash?: unknown, refs?: unknown, approvers?: unknown, [k: string]: unknown,
}
/** A log entry as a snap record keeps it. */
export interface LogExcerpt {
  id: number, at?: string, from?: string, via?: string, kind?: string, to?: string, text?: string,
  plan_hash?: unknown, refs?: unknown, approvers?: unknown,
}
/** One record of docs/rebuild/screens/index.json. */
export interface SnapRecord {
  scene: string, session: string, caption: string, step: number, time: string, svg: string, txt: string,
  cols: number, rows: number, room?: string, logTo?: number, log?: LogExcerpt[],
}
/** A pane capture: the ANSI text and the pane's size (0 when unknown). */
export interface PaneCapture { text: string, cols: number, rows: number }
export interface SnapOpts {
  dir?: string, capture?: PaneCapture, title?: string, room?: string | null, entries?: LogEntry[],
}

const REPO = path.resolve(import.meta.dirname, '..');
const SNAP_DIR = process.env.SNAP_DIR ? path.resolve(process.env.SNAP_DIR) : path.join(REPO, 'docs/rebuild/screens');

export function roomCode(): string | null {
  if (process.env.SUB_HUMAN_ROOM) return process.env.SUB_HUMAN_ROOM;
  const dir = path.join(home(), 'rooms');
  let best: { d: string, m: number } | null = null;
  try {
    for (const d of fs.readdirSync(dir)) {
      const log = path.join(dir, d, 'log.jsonl');
      let m: number;
      // only a room with a log: a dying run's seats can leave a bare rooms/CODE/rows dir behind after the reset
      try { m = fs.statSync(log).mtimeMs; } catch { continue; }
      if (!best || m > best.m) best = { d, m };
    }
  } catch { /* no rooms yet */ }
  return best && best.d;
}

/** The room's log entries (a torn last line is skipped). */
export const readLog = (code: string | null | undefined): LogEntry[] => (code ? jsonl<LogEntry>(path.join(home(), 'rooms', code, 'log.jsonl')) : []);

function clip(v: unknown, n: number): string { const s = String(v == null ? '' : v); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function excerpt(e: LogEntry): LogExcerpt {
  const o: LogExcerpt = { id: e.id, at: e.at, from: e.from, via: e.via, kind: e.kind };
  if (e.to && e.to !== 'room') o.to = e.to;
  if (e.text != null) o.text = clip(e.text, 600);
  for (const k of ['plan_hash', 'refs', 'approvers'] as const) if (e[k] != null) o[k] = e[k];
  return o;
}

function loadIndex(file: string): SnapRecord[] {
  const v = readJson<unknown>(file, []);
  return Array.isArray(v) ? v : [];
}

function capture(session: string): PaneCapture {
  const target = session.includes(':') ? session : `${session}:`;
  const text = execFileSync('tmux', ['capture-pane', '-e', '-p', '-t', target], { encoding: 'utf8' });
  let cols = 0, rows = 0;
  try {
    const dims = execFileSync('tmux', ['display-message', '-p', '-t', target, '#{pane_width} #{pane_height}'], { encoding: 'utf8' }).trim().split(' ');
    cols = +dims[0] || 0; rows = +dims[1] || 0;
  } catch { /* fine: size from content */ }
  return { text, cols, rows };
}

export const strip = (s: string): string => s.replace(/\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[()*+#]./g, '');

function titleFor(session: string, scene: string): string {
  const env = process.env['SNAP_TITLE_' + session.replace(/[^A-Za-z0-9]/g, '_')];
  if (env) return env;
  const seat = session.replace(/^shd?-/, '');
  return `${seat} · ${scene}`;
}

/** Snap one session; returns the index record. `cap` may be injected (tests). */
export function snap(session: string, scene: string, caption: string, opts: SnapOpts = {}): SnapRecord {
  const dir = opts.dir || SNAP_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const cap = opts.capture || capture(session);
  const indexFile = path.join(dir, 'index.json');
  const index = loadIndex(indexFile);
  // a scene can have several steps (captions): step 1 is <scene>-<session>, step n is <scene>-<n>-<session>
  const captions = [...new Set(index.filter(r => r.scene === scene).map(r => r.caption))];
  const step = (captions.includes(caption) ? captions.indexOf(caption) : captions.length) + 1;
  const base = (step === 1 ? `${scene}-${session}` : `${scene}-${step}-${session}`).replace(/[^A-Za-z0-9._-]/g, '_');
  fs.writeFileSync(path.join(dir, base + '.svg'), render(cap.text, { title: opts.title || titleFor(session, scene), cols: cap.cols, rows: cap.rows }));
  fs.writeFileSync(path.join(dir, base + '.txt'), strip(cap.text));
  fs.writeFileSync(path.join(dir, base + '.ansi'), cap.text); // colors kept: metrics counts red lines from it

  const rec: SnapRecord = { scene, session, caption, step, time: new Date().toISOString(), svg: base + '.svg', txt: base + '.txt', cols: cap.cols, rows: cap.rows };
  const code = opts.room !== undefined ? opts.room : roomCode();
  if (code) {
    const entries = opts.entries || readLog(code);
    const prev = index.filter(r => r.scene !== scene && r.room === code && typeof r.logTo === 'number').at(-1);
    const from = prev?.logTo ?? 0;
    rec.room = code;
    rec.logTo = entries.length ? Math.max(...entries.map(e => e.id || 0)) : 0;
    rec.log = entries.filter(e => (e.id || 0) > from).map(excerpt);
  }
  index.push(rec);
  fs.writeFileSync(indexFile + '.tmp', JSON.stringify(index, null, 1) + '\n');
  fs.renameSync(indexFile + '.tmp', indexFile);
  return rec;
}

if (import.meta.main) {
  const [sessions, scene, caption = ''] = process.argv.slice(2);
  if (!sessions || !scene) {
    process.stderr.write('usage: snap.ts <tmux-session>[,<session>…] <scene-id> "<caption>"\n');
    process.exit(2);
  }
  let failed = 0;
  for (const s of sessions.split(',').filter(Boolean)) {
    try {
      const r = snap(s, scene, caption);
      process.stdout.write(`snap ${scene} ${s} -> ${path.relative(process.cwd(), path.join(SNAP_DIR, r.svg))}${r.log ? ` (+${r.log.length} log)` : ''}\n`);
    } catch (e) {
      failed++;
      process.stderr.write(`snap ${scene} ${s} failed: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}\n`);
    }
  }
  process.exit(failed ? 1 : 0);
}
