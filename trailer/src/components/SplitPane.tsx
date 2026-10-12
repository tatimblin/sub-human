import React, { useMemo } from 'react';
import { THEME, screenRows } from '../lib/ansi';
import { MONO, SANS } from '../fonts/fonts';
import type { SplitPane as Box, Who } from '../design';
import { Row } from './Terminal';

/** A pane's inner camera: zoom z (absolute, 1 = the screen's full width) and the content point (cx, cy) at the window's centre. */
export type InnerCam = { z: number; cx: number; cy: number };

/** content px -> window px (relative to the viewport's top left) */
export const toWindow = (box: Box, cam: InnerCam, x: number, y: number) => ({
  x: box.vw / 2 + (x - cam.cx) * cam.z,
  y: box.vh / 2 + (y - cam.cy) * cam.z,
});

/** Keep the camera on the content: left-aligned when cropped, no blank past the screen's top or bottom. */
export function clampInner(box: Box, z: number, cy: number, wantCx?: number): InnerCam {
  const cw = box.vw; // content width at z = 1 is the viewport's width
  const halfW = box.vw / 2 / z;
  const halfH = box.vh / 2 / z;
  // left edge pinned at column 0, unless the camera has to pan right to show what it was sent to find
  const cx = halfW >= cw / 2 ? cw / 2 : Math.max(halfW, Math.min(cw - halfW, wantCx ?? halfW));
  const ch = box.contentH;
  const m = box.line * 0.7; // a little room past the first and last rows, so a mark there is not clipped
  const y = ch + 2 * m <= halfH * 2 ? ch / 2 : Math.max(halfH - m, Math.min(ch - halfH + m, cy));
  return { z, cx, cy: y };
}

type Props = {
  ansi: string;
  box: Box;
  screenRows: number;
  cam: InnerCam;
  who: Who;
  subtitle?: string;
  /** 0..1: how far the pane steps back while the other is the beat */
  dim?: number;
  /** 0..1: the content's own fade (a dip between cuts) */
  contentOpacity?: number;
  children?: React.ReactNode;
};

/** A terminal window with its name plate, its screen seen through a camera of its own. */
export const SplitPane: React.FC<Props> = ({ ansi, box, screenRows: nrows, cam, who, subtitle, dim = 0, contentOpacity = 1, children }) => {
  const rows = useMemo(() => screenRows(ansi, nrows), [ansi, nrows]);
  const dot = box.bar * 0.22;
  const cropped = cam.z * box.vw > box.vw + 1 && cam.cx + box.vw / 2 / cam.z < box.vw - 1;
  const croppedLeft = cam.cx - box.vw / 2 / cam.z > 1;
  return (
    <div
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        background: THEME.bg,
        borderRadius: box.bar * 0.3,
        boxShadow: `0 0 0 1px ${THEME.border}, 0 ${box.bar * 0.5}px ${box.bar * 1.8}px rgba(0,0,0,0.5)`,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: box.bar,
          background: THEME.bar,
          borderBottom: `1px solid ${THEME.border}`,
          display: 'flex',
          alignItems: 'center',
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', gap: dot * 0.8, marginLeft: box.bar * 0.4 }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
            <div key={c} style={{ width: dot, height: dot, borderRadius: dot, background: c, opacity: 0.85 }} />
          ))}
        </div>
        {/* the name plate: the person's colour, always with their name */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: box.bar * 0.22,
            fontFamily: SANS,
          }}
        >
          <div style={{ width: box.bar * 0.26, height: box.bar * 0.26, borderRadius: 99, background: who.color, boxShadow: `0 0 ${box.bar * 0.3}px ${who.color}88` }} />
          <span style={{ color: who.color, fontWeight: 650, fontSize: box.bar * 0.48, letterSpacing: '-0.005em' }}>{who.name}</span>
          {subtitle ? <span style={{ color: THEME.titleFg, fontSize: box.bar * 0.36, opacity: 0.8 }}>{subtitle}</span> : null}
        </div>
      </div>
      {/* a thin line in the person's colour under the bar */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: box.bar - 1, height: Math.max(2, box.bar * 0.06), background: who.color, opacity: 0.75 }} />
      <div style={{ position: 'absolute', left: box.padX, top: box.bar + box.padY, width: box.vw, height: box.vh, overflow: 'hidden' }}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transformOrigin: '0 0',
            translate: `${box.vw / 2 - cam.cx * cam.z}px ${box.vh / 2 - cam.cy * cam.z}px`,
            scale: String(cam.z),
            fontFamily: MONO,
            fontSize: box.fontSize,
            color: THEME.fg,
            whiteSpace: 'pre',
            fontVariantLigatures: 'none',
            fontFeatureSettings: '"liga" 0, "calt" 0',
            fontKerning: 'none',
            opacity: contentOpacity,
          }}
        >
          {rows.map((row, i) => (
            <div key={i} style={{ position: 'absolute', top: i * box.line, left: 0, height: box.line }}>
              <Row row={row} box={box} />
            </div>
          ))}
        </div>
        {cropped ? (
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: box.vw * 0.07, background: `linear-gradient(to right, ${THEME.bg}00, ${THEME.bg})` }} />
        ) : null}
        {croppedLeft ? (
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: box.vw * 0.05, background: `linear-gradient(to left, ${THEME.bg}00, ${THEME.bg})` }} />
        ) : null}
        {children}
      </div>
      {dim > 0 ? <div style={{ position: 'absolute', inset: 0, top: box.bar + 2, background: '#0c0d10', opacity: dim * 0.45 }} /> : null}
    </div>
  );
};
