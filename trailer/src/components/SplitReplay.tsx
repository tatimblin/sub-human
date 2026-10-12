import React, { useMemo } from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useVideoConfig } from 'remotion';
import { frameAt, type Capture } from '../lib/capture';
import { findRow, outputFrame, segmentAt, sourceTime, type ResolvedEdit, type ResolvedSegment, type ResolvedTag } from '../lib/edl';
import { rowText, screenRows } from '../lib/ansi';
import { COLORS, who, type SplitLayout, type SplitPane as Box } from '../design';
import { MONO, SANS } from '../fonts/fonts';
import { clampInner, SplitPane, toWindow, type InnerCam } from './SplitPane';
import { Captions } from './Captions';
import { SpeedBadge } from './SpeedBadge';
import { Wordmark } from './Wordmark';

const rowsAt = (cap: Capture, session: string, t: number) => {
  const f = frameAt(cap, session, t);
  return f ? screenRows(f.ansi, cap.meta.sessions[session]?.rows).map(rowText) : [];
};

/** Where a pane's camera wants to be for a segment. */
function targetInner(cap: Capture, seg: ResolvedSegment, box: Box): InnerCam {
  const v = seg.views?.[box.name];
  const z = box.zoom0 * (v?.zoom ?? 1);
  const halfH = box.vh / 2 / z;
  const bottomOf = (t: number) => {
    const rows = rowsAt(cap, box.name, t);
    let last = rows.length - 1;
    while (last > 0 && !rows[last]) last--;
    return (last + 1) * box.line - halfH + box.line * 0.4;
  };
  let cy = box.contentH / 2;
  let cx: number | undefined;
  if (v?.find) {
    const r = findRow(cap, box.name, seg, v.find);
    if (r != null) {
      cy = (r + 0.5) * box.line;
      // pan right if what it found ends past the window's right edge (keeping its start in view)
      const hit = findCols(cap, box.name, seg, v.find, r);
      if (hit) {
        const halfW = box.vw / 2 / z;
        const want = (hit.end + 2) * box.cell - halfW;
        cx = Math.min(want, hit.start * box.cell + halfW - 2 * box.cell);
      }
    }
    else if (v.anchor === 'bottom' || box.zoom0 === 1) cy = bottomOf(seg.srcEnd);
  } else if (v?.anchor === 'top') cy = halfH;
  else if (v?.anchor === 'bottom' || box.zoom0 === 1) cy = bottomOf(seg.srcEnd);
  return clampInner(box, z, cy, cx);
}

/** The columns of the first `find` text on row r, at the segment's end (or middle, or start). */
function findCols(cap: Capture, session: string, seg: ResolvedSegment, find: string | string[], r: number) {
  for (const want of Array.isArray(find) ? find : [find]) {
    for (const t of [seg.srcEnd - 1, (seg.srcStart + seg.srcEnd) / 2, seg.srcStart]) {
      const text = rowsAt(cap, session, t)[r] ?? '';
      const i = text.indexOf(want);
      if (i >= 0) return { start: i, end: i + want.length };
    }
  }
  return null;
}

const mixCam = (a: InnerCam, b: InnerCam, p: number): InnerCam => ({
  z: Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * p),
  cx: a.cx + (b.cx - a.cx) * p,
  cy: a.cy + (b.cy - a.cy) * p,
});

/** Stage position of a content point in a pane under its camera. */
const stagePoint = (box: Box, cam: InnerCam, x: number, y: number) => {
  const w = toWindow(box, cam, x, y);
  return { x: box.x + box.padX + w.x, y: box.y + box.bar + box.padY + w.y };
};

type Props = {
  cap: Capture;
  edit: ResolvedEdit;
  layout: SplitLayout;
  frame: number;
  roomNode: boolean;
  captions: boolean;
  subtitle?: string;
};

/** The v2 replay: both panes always on screen, each with its own camera, name plates, message tags and captions. */
export const SplitReplay: React.FC<Props> = ({ cap, edit, layout, frame, roomNode, captions, subtitle }) => {
  const { fps } = useVideoConfig();
  const f = Math.max(0, Math.min(edit.frames - 1, frame));
  const { seg, index } = segmentAt(edit, f);
  const t = sourceTime(edit, f, fps);
  const local = f - seg.outStart;
  const u = layout.u;

  const targets = useMemo(() => layout.panes.map((box) => edit.segments.map((s) => targetInner(cap, s, box))), [cap, edit, layout]);
  const camOf = (pi: number): InnerCam => {
    const tg = targets[pi];
    let c = tg[0];
    for (let k = 1; k <= index; k++) {
      if (edit.segments[k].dip) {
        c = tg[k];
        continue;
      }
      const len = k === index ? local : edit.segments[k].outFrames;
      const p = spring({ frame: len, fps, config: { damping: 200, mass: 1 }, durationInFrames: Math.round(fps * 0.9) });
      c = mixCam(c, tg[k], p);
    }
    return c;
  };
  const drift = seg.drift ? interpolate(local, [0, seg.outFrames], [1, seg.drift], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1;
  const cams = layout.panes.map((box, i) => {
    const c = camOf(i);
    return drift === 1 ? c : clampInner(box, c.z * drift, c.cy);
  });

  // a dip to dark across a cut to another part of the take
  const next = edit.segments[index + 1];
  const dipIn = seg.dip ? interpolate(local, [0, 9], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1;
  const dipOut = next?.dip ? interpolate(seg.outFrames - local, [0, 7], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1;
  const content = Math.min(dipIn, dipOut);

  // the pane the beat is about; the other steps back (eased across the cut)
  const dimOf = (name: string) => {
    const was = index > 0 ? edit.segments[index - 1].focus : undefined;
    const d = (fo: string | undefined) => (fo && fo !== name ? 1 : 0);
    const p = interpolate(local, [0, fps * 0.4], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    return d(was) + (d(seg.focus) - d(was)) * p;
  };

  const markIn = interpolate(local, [fps * 0.2, fps * 0.55], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const markOut = interpolate(seg.outFrames - local, [0, fps * 0.2], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const panes = layout.panes.map((box, pi) => {
    const fr = frameAt(cap, box.name, t);
    const ansi = fr ? fr.ansi : '';
    const nrows = cap.meta.sessions[box.name]?.rows ?? 36;
    const cam = cams[pi];
    const rows = ansi ? screenRows(ansi, nrows).map(rowText) : [];
    const marks = (seg.marks || []).filter((m) => m.pane === box.name);
    return (
      <SplitPane key={box.name} ansi={ansi} box={box} screenRows={nrows} cam={cam} who={who(box.name)} subtitle={subtitle} dim={dimOf(box.name)} contentOpacity={content}>
        {marks.map((m) => {
          const wants = Array.isArray(m.find) ? m.find : [m.find];
          let r = -1;
          for (const w of wants) {
            for (let i = rows.length - 1; i >= 0; i--) if (m.exact ? rows[i].trim() === w : rows[i].includes(w)) { r = i; break; }
            if (r >= 0) break;
          }
          if (r < 0) return null;
          const n = m.rows ?? 1;
          let len = 0;
          for (let i = r; i < r + n && i < rows.length; i++) len = Math.max(len, rows[i].length);
          const first = rows[r].search(/\S/);
          const a = toWindow(box, cam, Math.max(0, first - 0.8) * box.cell, r * box.line);
          const b = toWindow(box, cam, (len + 0.8) * box.cell, (r + n) * box.line);
          const color = who(m.who ?? box.name).color;
          const k = markIn * markOut * content;
          return (
            <React.Fragment key={`${m.pane}-${wants[0]}`}>
              <div
                style={{
                  position: 'absolute',
                  left: a.x,
                  top: a.y - 3 * u,
                  width: Math.min(box.vw - a.x - 4, b.x - a.x),
                  height: b.y - a.y + 6 * u,
                  border: `${2.5 * u}px solid ${color}`,
                  borderRadius: 8 * u,
                  background: `${color}1f`,
                  opacity: k,
                  scale: String(interpolate(markIn, [0, 1], [1.04, 1])),
                }}
              />
              {m.label ? (
                <div
                  style={{
                    position: 'absolute',
                    right: Math.max(4 * u, box.vw - Math.min(box.vw - 4, b.x) + 14 * u),
                    top: a.y - 3 * u,
                    translate: '0 -62%',
                    padding: `${4 * u}px ${12 * u}px`,
                    borderRadius: 999,
                    background: color,
                    color: '#0c0d10',
                    fontFamily: SANS,
                    fontWeight: 650,
                    fontSize: layout.plateSize * 0.95,
                    whiteSpace: 'nowrap',
                    opacity: k,
                  }}
                >
                  {m.label}
                </div>
              ) : null}
            </React.Fragment>
          );
        })}
      </SplitPane>
    );
  });

  // message tags, anywhere in the cut that is in flight now
  const tags: React.ReactNode[] = [];
  const involvesNode: number[] = [];
  edit.segments.forEach((s, si) => {
    (s.tags || []).forEach((g, gi) => {
      const span = tagSpan(edit, s, g, fps);
      if (f < span.start - 8 || f > span.end + 16) return;
      if (g.from === 'claude' || [g.to].flat().includes('claude')) involvesNode.push(f < span.end ? f - span.start : f - span.end);
      for (const dest of [g.to].flat()) {
        tags.push(<FlyingTag key={`${si}-${gi}-${dest}`} cap={cap} layout={layout} cams={cams} seg={s} tag={g} dest={dest} f={f} span={span} t={t} />);
      }
    });
  });

  // the room's Claude's plate: hidden where a segment says the room does not exist yet
  const shown = (s?: ResolvedSegment) => (s ? s.room !== false : false);
  const prev = edit.segments[index - 1];
  const roomK = shown(seg)
    ? prev && !shown(prev)
      ? interpolate(local, [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
      : 1
    : 0;

  const titleK =
    seg.overlay === 'title'
      ? Math.min(
          interpolate(local, [0, fps * 0.5], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) }),
          interpolate(seg.outFrames - local, [0, fps * 0.35], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        )
      : 0;

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ filter: titleK > 0 ? `blur(${titleK * 5 * u}px)` : undefined, opacity: 1 - titleK * 0.45 }}>{panes}</AbsoluteFill>
      {roomNode && roomK > 0 ? <RoomNode layout={layout} pulse={involvesNode} k={roomK} /> : null}
      {tags}
      {titleK > 0 ? <Title layout={layout} k={titleK} local={local} /> : null}
      {captions ? (
        <>
          <AbsoluteFill
            style={{
              top: 'auto',
              height: layout.view.bottom * 1.1,
              background: `linear-gradient(to bottom, ${COLORS.bg}00 0%, ${COLORS.bg}d0 40%, ${COLORS.bg} 100%)`,
            }}
          />
          <Captions edit={edit} frame={f} layout={layout} names />
          <SpeedBadge edit={edit} frame={f} layout={layout} sourceMs={t} modelOnly />
        </>
      ) : null}
    </AbsoluteFill>
  );
};

type Span = { start: number; end: number };

function tagSpan(edit: ResolvedEdit, s: ResolvedSegment, g: ResolvedTag, fps: number): Span {
  let end = s.outStart + Math.round((g.end ?? 0.85) * s.outFrames);
  if (g.arriveT != null) {
    const o = outputFrame(edit, g.arriveT, fps);
    if (o) end = o.frame;
  }
  const start = g.start != null ? s.outStart + Math.round(g.start * s.outFrames) : end - Math.round((g.dur ?? 1) * fps);
  return { start, end: Math.max(end, start + 6) };
}

/** The room's Claude: not a pane, a plate between the two (tags fly to and from it). */
const RoomNode: React.FC<{ layout: SplitLayout; pulse: number[]; k: number }> = ({ layout, pulse, k }) => {
  const c = who('claude');
  const s = layout.plateSize;
  const glow = pulse.length ? Math.max(...pulse.map((d) => interpolate(Math.abs(d), [0, 14], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }))) : 0;
  return (
    <div
      style={{
        position: 'absolute',
        left: layout.node.x,
        top: layout.node.y,
        translate: '-50% -50%',
        display: 'flex',
        alignItems: 'center',
        gap: s * 0.45,
        padding: `${s * 0.32}px ${s * 0.8}px`,
        borderRadius: 999,
        background: `rgba(18,19,24,0.92)`,
        border: `${Math.max(1.5, s * 0.08)}px solid ${c.color}`,
        boxShadow: `0 0 ${s * (0.6 + glow * 1.6)}px ${c.color}${glow > 0.05 ? 'aa' : '44'}`,
        scale: String((1 + glow * 0.08) * interpolate(k, [0, 1], [0.8, 1])),
        opacity: k,
        fontFamily: SANS,
        whiteSpace: 'nowrap',
      }}
    >
      <div style={{ width: s * 0.5, height: s * 0.5, borderRadius: 99, background: c.color }} />
      <span style={{ color: c.color, fontWeight: 650, fontSize: s }}>{c.name}</span>
    </div>
  );
};

/** A message on its way: a card in the sender's colour, flying on an arc and landing with a ring. */
const FlyingTag: React.FC<{ cap: Capture; layout: SplitLayout; cams: InnerCam[]; seg: ResolvedSegment; tag: ResolvedTag; dest: string; f: number; span: Span; t: number }> = ({
  cap,
  layout,
  cams,
  seg,
  tag,
  dest,
  f,
  span,
  t,
}) => {
  const u = layout.u;
  const point = (name: string, find: string | string[] | undefined, times: number[]) => {
    if (name === 'claude') return { x: layout.node.x, y: layout.node.y + layout.plateSize * 0.6 };
    const pi = layout.panes.findIndex((p) => p.name === name);
    const box = layout.panes[pi];
    if (!box) return { x: layout.width / 2, y: layout.height / 2 };
    const cam = cams[pi];
    const r = find ? findRow(cap, name, seg, find, times) : null;
    let pt = stagePoint(box, cam, Math.min(box.vw / 2, box.vw / cam.z / 2), cam.cy);
    if (r != null) {
      const rows = rowsAt(cap, name, times.find((x) => x >= 0) ?? t);
      const text = rows[r] ?? '';
      const x0 = Math.max(0, text.search(/\S/));
      const x1 = Math.min(text.length, x0 + 40);
      pt = stagePoint(box, cam, ((x0 + x1) / 2) * box.cell, (r + 0.5) * box.line);
    }
    // never outside the pane's window: a row scrolled out of view lands at the window's edge
    const m = 40 * u;
    const left = box.x + box.padX + m;
    const top = box.y + box.bar + box.padY + m;
    return { x: Math.max(left, Math.min(left + box.vw - 2 * m, pt.x)), y: Math.max(top, Math.min(top + box.vh - 2 * m, pt.y)) };
  };
  const departT = Math.max(seg.srcStart, t - 1);
  const a = point(tag.from, tag.fromFind, [t, departT, seg.srcStart, seg.srcEnd]);
  const arr = tag.arriveT ?? seg.srcEnd;
  const b = point(dest, tag.toFind, [arr + 50, arr + 1500, seg.srcEnd + 2000, seg.srcEnd + 6000]);
  const p = interpolate(f, [span.start, span.end], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.5, 0, 0.25, 1) });
  // the arc bows up between side-by-side panes, sideways between stacked ones; to and from the room's Claude it
  // only leans a little
  const node = tag.from === 'claude' || dest === 'claude';
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const lift = node
    ? { x: (b.x > a.x ? -1 : 1) * dist * 0.12, y: 0 }
    : layout.dir === 'row'
      ? { x: 0, y: -Math.min(220 * u, Math.abs(b.x - a.x) * 0.3 + 60 * u) }
      : { x: Math.min(260 * u, Math.abs(b.y - a.y) * 0.35 + 60 * u), y: 0 };
  const cx = (a.x + b.x) / 2 + lift.x;
  const cy = (a.y + b.y) / 2 + lift.y;
  const q = (s: number, p0: number, p1: number, p2: number) => (1 - s) * (1 - s) * p0 + 2 * (1 - s) * s * p1 + s * s * p2;
  const fs = layout.plateSize;
  // keep the whole card on screen (its centre follows the path)
  const cardW = Math.min(560 * u, Math.max(tag.label.length * fs * 0.53, (tag.sender.length + (tag.toLabel ?? dest).length + 4) * fs * 0.5) + fs * 1.6);
  const cardH = fs * 2.6;
  const x = Math.max(cardW / 2 + 12 * u, Math.min(layout.width - cardW / 2 - 12 * u, q(p, a.x, cx, b.x)));
  const y = Math.max(cardH / 2 + 8 * u, Math.min(layout.height - cardH / 2 - 8 * u, q(p, a.y, cy, b.y)));
  const popIn = interpolate(f, [span.start - 8, span.start], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const land = interpolate(f, [span.end, span.end + 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const ring = interpolate(f, [span.end - 2, span.end + 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const c = who(tag.from);
  const toName = dest === 'claude' ? who('claude').name : dest;
  // trail: a few fading dots behind the card
  const trail = [0.06, 0.12, 0.18].map((d, i) => {
    const s = Math.max(0, p - d);
    return p > d && p < 1 ? (
      <div key={i} style={{ position: 'absolute', left: q(s, a.x, cx, b.x), top: q(s, a.y, cy, b.y), width: 9 * u, height: 9 * u, borderRadius: 99, background: c.color, translate: '-50% -50%', opacity: 0.5 - i * 0.14 }} />
    ) : null;
  });
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {trail}
      {ring > 0 && ring < 1 ? (
        <div
          style={{
            position: 'absolute',
            left: b.x,
            top: b.y,
            width: 120 * u * ring,
            height: 120 * u * ring,
            borderRadius: 999,
            border: `${3 * u}px solid ${c.color}`,
            translate: '-50% -50%',
            opacity: 1 - ring,
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: x,
          top: y,
          translate: '-50% -50%',
          scale: String(interpolate(popIn, [0, 1], [0.7, 1]) * interpolate(land, [0, 1], [1, 0.8])),
          opacity: popIn * (1 - land),
          maxWidth: 560 * u,
          padding: `${fs * 0.45}px ${fs * 0.75}px`,
          borderRadius: fs * 0.6,
          background: 'rgba(16,17,22,0.96)',
          border: `${Math.max(1.5, 2 * u)}px solid ${c.color}`,
          boxShadow: `0 ${10 * u}px ${36 * u}px rgba(0,0,0,0.6), 0 0 ${22 * u}px ${c.color}55`,
          display: 'flex',
          flexDirection: 'column',
          gap: fs * 0.2,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: fs * 0.35, fontFamily: SANS, fontSize: fs * 0.82, fontWeight: 650, whiteSpace: 'nowrap' }}>
          <div style={{ width: fs * 0.42, height: fs * 0.42, borderRadius: 99, background: c.color }} />
          <span style={{ color: c.color }}>{tag.sender}</span>
          <span style={{ color: COLORS.textFaint }}>→</span>
          <span style={{ color: who(dest).color }}>{tag.to === dest && tag.toLabel ? tag.toLabel : toName}</span>
        </div>
        <div style={{ fontFamily: MONO, fontSize: fs * 0.88, color: COLORS.text, lineHeight: 1.3 }}>{tag.label}</div>
      </div>
    </AbsoluteFill>
  );
};

/** The title, over the split. */
const Title: React.FC<{ layout: SplitLayout; k: number; local: number }> = ({ layout, k, local }) => {
  const u = layout.u;
  const { fps } = useVideoConfig();
  const sub = interpolate(local, [fps * 0.25, fps * 0.9], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: k }}>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 55% 45% at 50% 50%, ${COLORS.bg}f2 0%, ${COLORS.bg}a0 60%, ${COLORS.bg}00 100%)` }} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 30 * u, translate: `0 ${(1 - k) * 16 * u}px` }}>
        <Wordmark size={140 * u} />
        <div
          style={{
            opacity: sub,
            translate: `0 ${(1 - sub) * 12 * u}px`,
            fontFamily: SANS,
            fontSize: 46 * u,
            fontWeight: 500,
            color: COLORS.text,
            letterSpacing: '-0.01em',
            textAlign: 'center',
            maxWidth: layout.width * 0.86,
          }}
        >
          Pair up without giving up your own Claude.
        </div>
      </div>
    </AbsoluteFill>
  );
};
