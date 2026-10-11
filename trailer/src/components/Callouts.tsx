import React from 'react';
import { AbsoluteFill, interpolate } from 'remotion';
import { COLORS } from '../design';
import { SANS } from '../fonts/fonts';

/** x, y: the dot (screen px); right: how far right the label may reach (the pane's edge, or the screen's) */
export type PlacedCallout = { key: string; label: string; x: number; y: number; right: number };

/**
 * Labels pinned beside a terminal row, in screen space (they keep their size while the camera zooms):
 * a dot at the end of the row's text, a short rule, then the label.
 */
export const Callouts: React.FC<{ items: PlacedCallout[]; progress: number; scale: number }> = ({ items, progress, scale }) => {
  if (!items.length || progress <= 0) return null;
  const fs = 22 * scale;
  const dot = 7 * scale;
  // the label goes out into the empty margin to the right of the row, so it covers as little text as it can
  const leader = (c: PlacedCallout) => {
    const labelW = c.label.length * fs * 0.56 + fs * 1.4;
    return Math.max(44 * scale, Math.min(280 * scale, c.right - 24 * scale - labelW - dot - c.x));
  };
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {items.map((c) => (
        <div
          key={c.key}
          style={{
            position: 'absolute',
            left: c.x,
            top: c.y,
            translate: `0 -50%`,
            display: 'flex',
            alignItems: 'center',
            opacity: progress,
          }}
        >
          <div style={{ width: dot, height: dot, borderRadius: dot, background: COLORS.accent, boxShadow: `0 0 0 ${3 * scale}px ${COLORS.accent}33` }} />
          <div
            style={{
              width: leader(c) * interpolate(progress, [0, 1], [0.2, 1]),
              height: Math.max(1, 1.5 * scale),
              background: COLORS.accent,
              opacity: 0.8,
            }}
          />
          <div
            style={{
              fontFamily: SANS,
              fontSize: fs,
              fontWeight: 600,
              color: COLORS.text,
              background: 'rgba(18,19,24,0.92)',
              border: `${Math.max(1, 1.5 * scale)}px solid ${COLORS.accent}`,
              borderRadius: fs * 0.5,
              padding: `${fs * 0.28}px ${fs * 0.7}px`,
              whiteSpace: 'nowrap',
              letterSpacing: '-0.005em',
              boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            }}
          >
            {c.label}
          </div>
        </div>
      ))}
    </AbsoluteFill>
  );
};
