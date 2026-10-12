/**
 * The capture loader: reads a take (capture/<take>/capture.jsonl, the format in /tmp/trailer-contract.md:
 * meta, frame and marker lines), scrubs personal information out of every frame, and answers "what is on
 * session S's screen at source time t" (its latest frame with frame.t <= t).
 */
import { staticFile } from 'remotion';
import { getStaticFiles } from '@remotion/studio';
import { parseCapture, type Capture, type Frame, type ScrubOptions } from './scrub';

export * from './scrub';

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
