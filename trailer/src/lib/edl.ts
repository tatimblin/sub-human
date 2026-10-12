/**
 * Edit decision lists: which stretches of a take play, and how fast. An edit is an ordered list of segments
 * [from, to) in source time, keyed off the take's markers, each played at a speed (1 = real time) or squeezed
 * to fit a number of output seconds. Anything between segments is cut. The resolved edit maps every output
 * frame to a source time, which is what the terminals replay.
 */
import { frameAt, type Capture } from './capture';
import { rowText, screenRows, stripAnsi } from './ansi';

/**
 * Where a segment starts or ends:
 *  - "plan"              the first marker whose beat is "plan" (or "S4:plan" to name the scene too)
 *  - "plan+2.5s"         offset from it (also "-1s", "+800ms")
 *  - { t: 12000 }         an absolute source time (ms)
 *  - { beat, offset }     the same as the string form
 *  - { after, session, text, offset? }   the first frame of `session` at or after anchor `after` where `text`
 *                         (or any of several) appears: shows up more often than on the frame before. Robust to how
 *                         long a real model took, and to the same text already being on screen.
 */
export type Anchor =
  | string
  | { t: number }
  | { beat: string; offset?: number }
  | { after: Anchor; session: string; text: string | string[]; offset?: number };

export type CameraSpec = {
  /** which pane the camera favours: one seat, or both side by side */
  pane: string | 'both';
  /** scale; 1 shows the whole stage */
  zoom?: number;
  /** centre on the row holding this text, or the first of several that is there (searched at the segment's end) */
  find?: string | string[];
};

export type Callout = {
  pane: string;
  label: string;
  /** point at the row holding this text, or the first of several that is on screen */
  find: string | string[];
};

/** v2: one pane's own camera (zoom within its half). */
export type PaneView = {
  /** relative to the layout's default framing (1) */
  zoom?: number;
  /** centre on the row holding this text, or the first of several that is there (searched at the segment's end) */
  find?: string | string[];
  /** or hold to the top or bottom of the screen (the bottom bar: the agent panel) */
  anchor?: 'top' | 'bottom';
};

/** A message crossing between panes: a tag in the sender's colour flies from one to the other. */
export type Tag = {
  from: string; // a seat, or "claude" (the room's Claude)
  to: string | string[];
  /** who it is from, as the tag's header says it ("bob's Claude", "bob"); the colour is `from`'s */
  sender: string;
  /** who it is for, as the header says it (default: the destination's name) */
  toLabel?: string;
  label: string;
  /** the row it leaves from / lands on (else the pane's middle) */
  fromFind?: string | string[];
  toFind?: string | string[];
  /** it lands when this source time plays (else at `end` of the segment) */
  arrive?: Anchor;
  /** flight, in output seconds (default 1) */
  dur?: number;
  /** or by fraction of the segment */
  start?: number;
  end?: number;
};

/** A rectangle drawn round the rows holding some text, in the colour of `who`, with an optional label. */
export type Mark = {
  pane: string;
  find: string | string[];
  /** match a whole row (trimmed), not a substring: "❯" is the empty prompt */
  exact?: boolean;
  rows?: number;
  who?: string;
  label?: string;
};

export type Segment = {
  id: string;
  from: Anchor;
  /** not needed with `hold` */
  to?: Anchor;
  /** freeze on `from` for this many output seconds (the title, a message in flight) */
  hold?: number;
  /** playback rate; default 1 */
  speed?: number;
  /** model time: the speed badge shows over it (and only over it) */
  model?: boolean;
  /** v2: each pane's camera; panes not named keep their default framing */
  views?: Record<string, PaneView>;
  /** v2: a slow push in across the segment (both panes' zoom grows to this factor; for holds) */
  drift?: number;
  /** v2: the pane the beat is about (the other steps back a little) */
  focus?: string;
  tags?: Tag[];
  marks?: Mark[];
  /** v2: false hides the room's Claude's plate (before the room exists) */
  room?: boolean;
  /** v2: the title over the split */
  overlay?: 'title';
  /** a cut to somewhere else in the take: the screens dip to dark between */
  dip?: boolean;
  /** squeeze to this many output seconds (never slower than 1x); wins over speed */
  fit?: number;
  /** caption text; defaults to the caption of the latest marker at `from` */
  caption?: string;
  /** a short label over the caption: the command or idea the beat shows */
  eyebrow?: string;
  camera?: CameraSpec;
  callouts?: Callout[];
};

export type Edit = {
  /** seconds of title over the first frame before the replay runs */
  hookSeconds: number;
  /** the segment whose last frame shows, blurred, behind the title (default: the first frame of the replay) */
  hookTeaser?: string;
  /** seconds of end card */
  endSeconds: number;
  /** v2: the split-screen cut (panes zoom within their halves, name plates, message tags, no hook) */
  v2?: boolean;
  /** v2: the room's Claude's plate between the panes (tags fly to and from it) */
  roomNode?: boolean;
  /** v2: captions (off for the README loop: name plates only) */
  captions?: boolean;
  /** v2: the end card's form */
  endCard?: 'full' | 'short';
  segments: Segment[];
};

export type ResolvedTag = Tag & { arriveT: number | null };

export type ResolvedSegment = Omit<Segment, 'tags'> & {
  tags?: ResolvedTag[];
  srcStart: number;
  srcEnd: number;
  rate: number;
  outStart: number; // frame, relative to the replay's start
  outFrames: number;
  captionText: string;
};

export type ResolvedEdit = { segments: ResolvedSegment[]; frames: number; warnings: string[] };

const OFFSET = /^(.*?)([+-]\d+(?:\.\d+)?)(ms|s)$/;

function occurrences(ansi: string, texts: string[]): number {
  const s = stripAnsi(ansi);
  let n = 0;
  for (const t of texts) for (let i = s.indexOf(t); i >= 0; i = s.indexOf(t, i + t.length)) n++;
  return n;
}

export function resolveAnchor(cap: Capture, a: Anchor): number | null {
  if (typeof a === 'string') {
    const m = OFFSET.exec(a);
    if (m) {
      const base = resolveAnchor(cap, m[1]);
      return base == null ? null : base + parseFloat(m[2]) * (m[3] === 's' ? 1000 : 1);
    }
    if (a === 'start') return 0;
    if (a === 'end') return cap.end;
    const [scene, beat] = a.includes(':') ? a.split(':') : [null, a];
    const mk = cap.markers.find((k) => k.beat === beat && (!scene || k.scene === scene));
    return mk ? mk.t : null;
  }
  if ('t' in a) return a.t;
  if ('beat' in a) {
    const base = resolveAnchor(cap, a.beat);
    return base == null ? null : base + (a.offset || 0);
  }
  const from = resolveAnchor(cap, a.after);
  if (from == null) return null;
  const fs = cap.frames[a.session] || [];
  const texts = Array.isArray(a.text) ? a.text : [a.text];
  for (let i = 0; i < fs.length; i++) {
    if (fs[i].t < from) continue;
    const before = i > 0 ? occurrences(fs[i - 1].ansi, texts) : 0;
    if (occurrences(fs[i].ansi, texts) > before) return fs[i].t + (a.offset || 0);
  }
  return null;
}

const describe = (a: Anchor) => (typeof a === 'string' ? a : JSON.stringify(a));

export function resolveEdit(cap: Capture, edit: Edit, fps: number): ResolvedEdit {
  const warnings: string[] = [];
  const segments: ResolvedSegment[] = [];
  let out = 0;
  for (const seg of edit.segments) {
    const a = resolveAnchor(cap, seg.from);
    const tags = seg.tags?.map((g) => ({ ...g, arriveT: g.arrive != null ? resolveAnchor(cap, g.arrive) : null }));
    if (seg.hold) {
      if (a == null) {
        warnings.push(`segment ${seg.id}: no anchor ${describe(seg.from)} in take ${cap.take}; skipped`);
        continue;
      }
      const outFrames = Math.max(1, Math.round(seg.hold * fps));
      const marker = [...cap.markers].reverse().find((k) => k.t <= a + 1);
      segments.push({ ...seg, tags, srcStart: a, srcEnd: a, rate: 0, outStart: out, outFrames, captionText: seg.caption ?? marker?.caption ?? '' });
      out += outFrames;
      continue;
    }
    const b = seg.to == null ? null : resolveAnchor(cap, seg.to);
    if (a == null || b == null) {
      warnings.push(`segment ${seg.id}: no anchor ${a == null ? describe(seg.from) : describe(seg.to ?? '(none)')} in take ${cap.take}; skipped`);
      continue;
    }
    if (b <= a) {
      warnings.push(`segment ${seg.id}: ends (${b} ms) before it starts (${a} ms); skipped`);
      continue;
    }
    const len = b - a;
    const rate = seg.fit ? Math.max(1, len / (seg.fit * 1000)) : seg.speed || 1;
    const outFrames = Math.max(1, Math.round((len / rate / 1000) * fps));
    const marker = [...cap.markers].reverse().find((k) => k.t <= a + 1);
    segments.push({ ...seg, tags, srcStart: a, srcEnd: b, rate, outStart: out, outFrames, captionText: seg.caption ?? marker?.caption ?? '' });
    out += outFrames;
  }
  for (const w of warnings) console.warn('[edl] ' + w);
  return { segments, frames: Math.max(1, out), warnings };
}

/** The segment playing at replay frame f (clamped to the first/last). */
export function segmentAt(edit: ResolvedEdit, f: number): { seg: ResolvedSegment; index: number } {
  const segs = edit.segments;
  if (!segs.length) throw new Error('empty edit: no segment resolved against this take');
  let i = 0;
  while (i < segs.length - 1 && f >= segs[i + 1].outStart) i++;
  return { seg: segs[i], index: i };
}

/** Source time (ms) shown at replay frame f. */
export function sourceTime(edit: ResolvedEdit, f: number, fps: number): number {
  const { seg } = segmentAt(edit, f);
  if (seg.rate === 0) return seg.srcStart;
  const local = Math.max(0, Math.min(seg.outFrames, f - seg.outStart));
  return Math.min(seg.srcEnd, seg.srcStart + (local / fps) * 1000 * seg.rate);
}

/** Replay frames at which source time t plays (none if it was cut). */
export function outputFrame(edit: ResolvedEdit, t: number, fps: number): { frame: number; rate: number } | null {
  for (const s of edit.segments) {
    if (s.rate === 0) continue;
    if (t >= s.srcStart && t < s.srcEnd) return { frame: s.outStart + Math.floor(((t - s.srcStart) / s.rate / 1000) * fps), rate: s.rate };
  }
  return null;
}

/** The row (0-based, in the session's screen) holding `text` near the end of a segment, or null. */
export function findRow(cap: Capture, session: string, seg: { srcStart: number; srcEnd: number }, text: string | string[], times?: number[]): number | null {
  const rows = cap.meta.sessions[session]?.rows;
  for (const want of Array.isArray(text) ? text : [text]) {
    for (const t of times ?? [seg.srcEnd - 1, (seg.srcStart + seg.srcEnd) / 2, seg.srcStart]) {
      const f = frameAt(cap, session, t);
      if (!f) continue;
      const r = screenRows(f.ansi, rows);
      for (let i = r.length - 1; i >= 0; i--) if (rowText(r[i]).includes(want)) return i;
    }
  }
  return null;
}
