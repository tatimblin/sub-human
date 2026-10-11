import React from 'react';
import { AbsoluteFill, Easing, interpolate, useVideoConfig } from 'remotion';
import type { ResolvedEdit } from '../lib/edl';
import { COLORS, type StageLayout } from '../design';
import { MONO, SANS } from '../fonts/fonts';

type Block = { start: number; end: number; text: string; eyebrow?: string };

/** Consecutive segments with the same caption share one block, so the caption holds still across them. */
export function captionBlocks(edit: ResolvedEdit): Block[] {
  const out: Block[] = [];
  for (const s of edit.segments) {
    const prev = out[out.length - 1];
    if (prev && prev.text === s.captionText && prev.eyebrow === s.eyebrow) prev.end = s.outStart + s.outFrames;
    else out.push({ start: s.outStart, end: s.outStart + s.outFrames, text: s.captionText, eyebrow: s.eyebrow });
  }
  return out.filter((b) => b.text);
}

/** Captions for muted viewing: one line (two at most), an optional accent eyebrow naming the command. */
export const Captions: React.FC<{ edit: ResolvedEdit; frame: number; layout: StageLayout; opacity?: number }> = ({ edit, frame, layout, opacity = 1 }) => {
  const { fps } = useVideoConfig();
  const block = captionBlocks(edit).find((b) => frame >= b.start && frame < b.end);
  if (!block) return null;
  const local = frame - block.start;
  const fadeIn = interpolate(local, [0, fps * 0.4], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const fadeOut = interpolate(block.end - frame, [0, fps * 0.3], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const k = Math.min(fadeIn, fadeOut);
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: layout.captionBottom, opacity: opacity * k }}>
      <div
        style={{
          translate: `0 ${interpolate(fadeIn, [0, 1], [layout.captionSize * 0.35, 0])}px`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: layout.eyebrowSize * 0.7,
          maxWidth: layout.width * 0.8,
        }}
      >
        {block.eyebrow ? (
          <div
            style={{
              fontFamily: MONO,
              fontSize: layout.eyebrowSize,
              color: COLORS.accent,
              letterSpacing: '0.04em',
            }}
          >
            {block.eyebrow}
          </div>
        ) : null}
        <div
          style={{
            fontFamily: SANS,
            fontSize: layout.captionSize,
            fontWeight: 500,
            color: COLORS.text,
            letterSpacing: '-0.01em',
            lineHeight: 1.25,
            textAlign: 'center',
            textWrap: 'balance',
          }}
        >
          {block.text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
