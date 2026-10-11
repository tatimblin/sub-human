import React from 'react';
import { interpolate, useVideoConfig } from 'remotion';
import { segmentAt, type ResolvedEdit } from '../lib/edl';
import { COLORS, type StageLayout } from '../design';
import { MONO } from '../fonts/fonts';

/** A quiet "12×" with a clock whose hand runs at source speed, shown while a segment plays faster than 1×. */
export const SpeedBadge: React.FC<{ edit: ResolvedEdit; frame: number; layout: StageLayout; sourceMs: number; opacity?: number }> = ({
  edit,
  frame,
  layout,
  sourceMs,
  opacity = 1,
}) => {
  const { fps } = useVideoConfig();
  const { seg } = segmentAt(edit, frame);
  if (seg.rate < 1.3) return null;
  const local = frame - seg.outStart;
  const k = Math.min(
    interpolate(local, [0, fps * 0.25], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    interpolate(seg.outFrames - local, [0, fps * 0.2], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
  );
  const u = Math.min(layout.width, layout.height * 1.6) / 1728;
  const size = 26 * u;
  const angle = (sourceMs / 1000) * 36; // one turn per 10 s of source time
  return (
    <div
      style={{
        position: 'absolute',
        // bottom right, level with the caption: never over the terminals
        bottom: layout.captionBottom,
        right: layout.width * 0.03,
        display: 'flex',
        alignItems: 'center',
        gap: 10 * u,
        padding: `${8 * u}px ${14 * u}px`,
        borderRadius: 999,
        background: 'rgba(18,19,24,0.85)',
        border: `1px solid ${COLORS.hairline}`,
        opacity: opacity * k,
        fontFamily: MONO,
        fontSize: 20 * u,
        color: COLORS.textSoft,
      }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9.5" fill="none" stroke={COLORS.textFaint} strokeWidth="1.6" />
        <line x1="12" y1="12" x2="12" y2="5.5" stroke={COLORS.accent} strokeWidth="2" strokeLinecap="round" transform={`rotate(${angle} 12 12)`} />
        <circle cx="12" cy="12" r="1.4" fill={COLORS.accent} />
      </svg>
      <span style={{ color: COLORS.text }}>{seg.rate < 3 ? +seg.rate.toFixed(1) : Math.round(seg.rate)}×</span>
    </div>
  );
};
