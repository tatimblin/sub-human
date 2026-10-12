import React, { useMemo } from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useVideoConfig } from 'remotion';
import { frameAt, type Capture } from '../lib/capture';
import { findRow, segmentAt, sourceTime, type ResolvedEdit, type ResolvedSegment } from '../lib/edl';
import { rowText } from '../lib/ansi';
import { COLORS, type PaneBox, type StageLayout } from '../design';
import { Terminal, visibleRows } from './Terminal';
import { Captions } from './Captions';
import { Callouts, type PlacedCallout } from './Callouts';
import { SpeedBadge } from './SpeedBadge';
import { Wordmark } from './Wordmark';

type Cam = { x: number; y: number; s: number };

const rowY = (box: PaneBox, row: number) => box.y + box.bar + box.padY + row * box.line + box.line / 2;

function viewCentre(layout: StageLayout) {
  return { x: layout.width / 2, y: (layout.height - layout.view.bottom + layout.view.top) / 2 };
}

function clampCam(c: Cam, layout: StageLayout): Cam {
  const v = viewCentre(layout);
  const { width: W, height: H } = layout;
  const clamp = (val: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, val)));
  return { s: c.s, x: clamp(c.x, v.x / c.s, W - (W - v.x) / c.s), y: clamp(c.y, v.y / c.s, H - (H - v.y) / c.s) };
}

/** Where the camera wants to be for a segment (stage coordinates of the point shown at the view centre). */
function targetCam(cap: Capture, seg: ResolvedSegment, layout: StageLayout): Cam {
  const v = viewCentre(layout);
  const spec = seg.camera;
  if (!spec || layout.kind === 'stacked') return { ...v, s: 1 };
  const avail = layout.height - layout.view.bottom - layout.view.top;
  if (spec.pane === 'both') {
    const s = spec.zoom ?? 1;
    let y = v.y;
    if (spec.find) {
      for (const box of layout.panes) {
        const r = findRow(cap, box.name, seg, spec.find);
        if (r != null) { y = rowY(box, r); break; }
      }
    }
    return clampCam({ x: v.x, y, s }, layout);
  }
  const box = layout.panes.find((p) => p.name === spec.pane);
  if (!box) return { ...v, s: 1 };
  const s = spec.zoom ?? Math.min((layout.width * 0.94) / box.w, (avail * 0.96) / box.h);
  let y = box.y + box.h / 2;
  if (spec.find) {
    const r = findRow(cap, box.name, seg, spec.find);
    if (r != null) y = rowY(box, r);
  }
  // keep the pane filling the view: its top edge at or above the screen's, its bottom at or below the captions'
  const lo = box.y + v.y / s;
  const hi = box.y + box.h - (layout.height - layout.view.bottom - v.y) / s;
  y = lo <= hi ? Math.max(lo, Math.min(hi, y)) : (lo + hi) / 2;
  return clampCam({ x: box.x + box.w / 2, y, s }, layout);
}

const mix = (a: Cam, b: Cam, p: number): Cam => ({
  x: a.x + (b.x - a.x) * p,
  y: a.y + (b.y - a.y) * p,
  s: Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * p),
});

type Props = {
  cap: Capture;
  edit: ResolvedEdit;
  layout: StageLayout;
  /** replay frame (0 = first frame of the first segment) */
  frame: number;
  /** 0..1: how much of the overlay (captions, callouts, badge) shows; the hook and end card fade it */
  chrome?: number;
  /** subtitle in each window's title bar */
  subtitle?: string;
  /** 0..1: the small wordmark in the corner (it steps aside while the camera is zoomed in) */
  mark?: number;
};

/** The two (or more) terminals at one replay frame, with the camera, captions, callouts and speed badge. */
export const Replay: React.FC<Props> = ({ cap, edit, layout, frame, chrome = 1, subtitle, mark = 0 }) => {
  const { fps } = useVideoConfig();
  const f = Math.max(0, Math.min(edit.frames - 1, frame));
  const { seg, index } = segmentAt(edit, f);
  const t = sourceTime(edit, f, fps);

  // camera: each segment eases from wherever the previous one left it
  const targets = useMemo(() => edit.segments.map((s) => targetCam(cap, s, layout)), [cap, edit, layout]);
  const camAt = (i: number, local: number): Cam => {
    let from = targets[0];
    for (let k = 0; k <= i; k++) {
      const len = k === i ? local : edit.segments[k].outFrames;
      const p = spring({ frame: len, fps, config: { damping: 200, mass: 1.1 }, durationInFrames: Math.round(fps * 1.1) });
      from = mix(from, targets[k], k === 0 ? 1 : p);
    }
    return from;
  };
  const cam = camAt(index, f - seg.outStart);
  const v = viewCentre(layout);

  const focus = seg.camera?.pane;
  const modelOnly = useMemo(() => edit.segments.some((s) => s.model), [edit]);
  const placed: PlacedCallout[] = [];
  const panes = layout.panes.map((box) => {
    const fr = frameAt(cap, box.name, t);
    const ansi = fr ? fr.ansi : '';
    const nrows = cap.meta.sessions[box.name]?.rows ?? 40;
    for (const c of seg.callouts || []) {
      if (c.pane !== box.name || !ansi) continue;
      const rows = visibleRows(ansi, nrows, box);
      const wants = Array.isArray(c.find) ? c.find : [c.find];
      const want = wants.find((w) => rows.some((r) => rowText(r.row).includes(w)));
      for (let r = rows.length - 1; want && r >= 0; r--) {
        const txt = rowText(rows[r].row);
        if (!txt.includes(want)) continue;
        const sx = box.x + box.padX + txt.length * box.cell + box.cell * 1.5;
        const sy = rowY(box, r);
        placed.push({
          key: `${seg.id}-${c.pane}-${c.label}`,
          label: c.label,
          x: (sx - cam.x) * cam.s + v.x,
          y: (sy - cam.y) * cam.s + v.y,
          right: Math.min(layout.width, (box.x + box.w - cam.x) * cam.s + v.x),
        });
        break;
      }
    }
    // in the stacked layout the camera never moves: the pane not in focus steps back instead
    const dimmed = layout.kind === 'stacked' && focus && focus !== 'both' && focus !== box.name;
    return (
      <Terminal
        key={box.name}
        ansi={ansi}
        box={box}
        screenRows={nrows}
        title={box.name}
        subtitle={subtitle}
        style={{ opacity: dimmed ? 0.5 : 1 }}
      />
    );
  });

  const local = f - seg.outStart;
  const calloutIn = interpolate(local, [fps * 0.35, fps * 0.75], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const calloutOut = interpolate(seg.outFrames - local, [0, fps * 0.25], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          transformOrigin: '0 0',
          translate: `${v.x - cam.x * cam.s}px ${v.y - cam.y * cam.s}px`,
          scale: String(cam.s),
        }}
      >
        {panes}
      </AbsoluteFill>
      {/* a scrim under the captions, so zoomed text never fights them */}
      <AbsoluteFill
        style={{
          top: 'auto',
          height: layout.view.bottom * 1.25,
          background: `linear-gradient(to bottom, rgba(12,13,16,0) 0%, ${COLORS.bg}e6 45%, ${COLORS.bg} 100%)`,
          opacity: chrome * interpolate(cam.s, [1, 1.15], [0.55, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        }}
      />
      {mark > 0 ? (
        <div
          style={{
            position: 'absolute',
            top: layout.height * 0.037,
            left: layout.width * 0.027,
            opacity: mark * 0.7 * interpolate(cam.s, [1, 1.03], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
          }}
        >
          <Wordmark size={layout.height * 0.026} color={COLORS.textSoft} />
        </div>
      ) : null}
      <Callouts items={placed} progress={Math.min(calloutIn, calloutOut) * chrome} scale={layout.height / 1080} />
      <Captions edit={edit} frame={f} layout={layout} opacity={chrome} />
      {/* an edit that marks its model time (v3) badges only that; the v1 cuts badge every sped-up segment */}
      <SpeedBadge edit={edit} frame={f} layout={layout} sourceMs={t} opacity={chrome} modelOnly={modelOnly} />
    </AbsoluteFill>
  );
};
