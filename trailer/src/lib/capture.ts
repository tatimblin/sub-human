/**
 * The capture loader: reads a take (capture/<take>/capture.jsonl, the format in /tmp/trailer-contract.md:
 * meta, frame and marker lines), scrubs personal information out of every frame, and answers "what is on
 * session S's screen at source time t" (its latest frame with frame.t <= t).
 */
import { staticFile } from 'remotion';
import { getStaticFiles } from '@remotion/studio';
import { stripAnsi } from './ansi';

export type SessionMeta = { cols: number; rows: number };
export type Meta = { t: number; kind: 'meta'; sessions: Record<string, SessionMeta>; room?: string };
export type Frame = { t: number; kind: 'frame'; session: string; ansi: string };
export type Marker = { t: number; kind: 'marker'; scene: string; beat: string; caption?: string };

export type Capture = {
  take: string;
  meta: Meta;
  /** per session, sorted by t */
  frames: Record<string, Frame[]>;
  markers: Marker[];
  /** last t seen in the file */
  end: number;
};

export type ScrubOptions = {
  /** extra literal words to replace (a username, a hostname); each becomes `with` */
  words?: string[];
  with?: string;
  /** rows whose plain text matches one of these are removed from every screen (and a blank row added at the bottom) */
  dropRows?: string[];
};

/** Rows dropped by default: the update nag. */
export const DEFAULT_DROP_ROWS = ['Update available! Run:'];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace absolute paths, home directories, user@host and .local hostnames. Runs over the ANSI text: none of
 * the patterns can match inside an escape sequence. The demo's seat dirs (/tmp/sh-demo/<seat>) become ~/app,
 * its store (/tmp/sh-demo/home…) ~/.sub-human; the room code is kept.
 */
export function scrub(ansi: string, opts: ScrubOptions = {}): string {
  let s = ansi
    .replace(/(?:\/private)?\/tmp\/sh-demo\/home\d*/g, '~/.sub-human')
    .replace(/(?:\/private)?\/tmp\/sh-demo\/(?:[A-Za-z0-9_-]+)/g, '~/app')
    .replace(/-private-tmp-sh-demo-[A-Za-z0-9_-]+/g, '-app')
    // eslint-disable-next-line no-control-regex
    .replace(/\/(?:Users|home)\/[^/\s\x1b'"`)]+/g, '~')
    .replace(/\b[A-Za-z0-9._-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:local|lan|home|internal|ts\.net)\b/g, 'you@devbox')
    .replace(/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:local|lan|internal)\b/g, 'devbox');
  for (const w of opts.words || []) {
    if (w) s = s.replace(new RegExp(`\\b${esc(w)}\\b`, 'g'), opts.with ?? 'you');
  }
  return s;
}

const plain = (line: string) => stripAnsi(line);

function dropRows(ansi: string, patterns: string[]): string {
  if (!patterns.length) return ansi;
  const lines = ansi.split('\n');
  const kept = lines.filter((l) => !patterns.some((p) => plain(l).includes(p)));
  while (kept.length < lines.length) kept.push('');
  return kept.join('\n');
}

export function parseCapture(take: string, text: string, opts: ScrubOptions = {}): Capture {
  let meta: Meta | null = null;
  const frames: Record<string, Frame[]> = {};
  const markers: Marker[] = [];
  let end = 0;
  const drop = opts.dropRows ?? DEFAULT_DROP_ROWS;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: Meta | Frame | Marker;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a torn last line from a capture still being written
    }
    end = Math.max(end, o.t || 0);
    if (o.kind === 'meta') meta = o;
    else if (o.kind === 'frame') {
      (frames[o.session] ||= []).push({ ...o, ansi: dropRows(scrub(o.ansi, opts), drop) });
    } else if (o.kind === 'marker') markers.push({ ...o, caption: o.caption ? scrub(o.caption, opts) : o.caption });
  }
  if (!meta) {
    meta = { t: 0, kind: 'meta', sessions: {} };
  }
  for (const [name, fs] of Object.entries(frames)) {
    fs.sort((a, b) => a.t - b.t);
    if (!meta.sessions[name]) meta.sessions[name] = { cols: 120, rows: 40 };
  }
  markers.sort((a, b) => a.t - b.t);
  return { take, meta, frames, markers, end };
}

/** The screen of `session` at source time t: its latest frame with frame.t <= t (its first frame before that). */
export function frameAt(cap: Capture, session: string, t: number): Frame | null {
  const fs = cap.frames[session];
  if (!fs || !fs.length) return null;
  let lo = 0;
  let hi = fs.length - 1;
  if (t < fs[0].t) return fs[0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fs[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return fs[lo];
}

/** The capture file of a take, under the public dir (public/capture -> ../capture). */
export const captureUrl = (take: string, gz = false) => staticFile(`capture/${take}/capture.jsonl${gz ? '.gz' : ''}`);

/** capture.jsonl, else capture.jsonl.gz (a take kept small in git); gzip is detected by its magic bytes. */
async function fetchTake(take: string): Promise<string> {
  // ask the public dir's listing first, so a render does not log a 404 for the form the take lacks
  const listed = new Set(getStaticFiles().map((f) => f.name));
  const gzOnly = !listed.has(`capture/${take}/capture.jsonl`) && listed.has(`capture/${take}/capture.jsonl.gz`);
  let r = await fetch(captureUrl(take, gzOnly));
  if (!r.ok && !gzOnly) r = await fetch(captureUrl(take, true));
  if (!r.ok) throw new Error(`take ${take}: no capture/${take}/capture.jsonl(.gz) (HTTP ${r.status})`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(buf);
}

const cache = new Map<string, Promise<Capture>>();

export function loadCapture(take: string, opts: ScrubOptions = {}): Promise<Capture> {
  const key = JSON.stringify([take, opts]);
  let p = cache.get(key);
  if (!p) {
    p = fetchTake(take).then((text) => parseCapture(take, text, opts));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}
