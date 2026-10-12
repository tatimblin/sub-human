import React from 'react';
import { AbsoluteFill, Easing, interpolate, useVideoConfig } from 'remotion';
import type { ResolvedEdit } from '../lib/edl';
import { COLORS, type StageLayout } from '../design';
import { people, useCast, type Cast } from '../cast';
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

type CaptionLayout = Pick<StageLayout, 'width' | 'height' | 'captionBottom' | 'captionSize' | 'eyebrowSize'>;

/** The take's two people and "the room's Claude" in their own colours (the colour always sits on the name). */
function coloured(text: string, c: Cast): React.ReactNode {
  const p = people(c);
  const key: Record<string, string> = { [c.a]: c.a, [c.b]: c.b, "room's Claude": 'claude' };
  const names = new RegExp(`(${["room's Claude", c.a, c.b].join('|')})`, 'g');
  return text.split(names).map((part, i) =>
    key[part] ? (
      <span key={i} style={{ color: p[key[part]].color, fontWeight: 650 }}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/** Captions for muted viewing: one line (two at most), an optional accent eyebrow naming the command. */
export const Captions: React.FC<{ edit: ResolvedEdit; frame: number; layout: CaptionLayout; opacity?: number; names?: boolean }> = ({ edit, frame, layout, opacity = 1, names = false }) => {
  const { fps } = useVideoConfig();
  const cast = useCast();
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
          {names ? coloured(block.text, cast) : block.text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
