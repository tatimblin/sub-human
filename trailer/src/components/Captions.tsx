import React from 'react';
import { AbsoluteFill, Easing, interpolate, useVideoConfig } from 'remotion';
import type { ResolvedEdit } from '../lib/edl';
import { COLORS, type StageLayout } from '../design';
import { people, useCast, type Cast } from '../cast';
import { MONO, SANS } from '../fonts/fonts';

type Block = { start: number; end: number; text: string; eyebrow?: string };

/** Consecutive segments that share `same` merge into one block, so that line holds still across them. */
function runs(edit: ResolvedEdit, same: (a: Block, s: ResolvedEdit['segments'][number]) => boolean): Block[] {
  const out: Block[] = [];
  for (const s of edit.segments) {
    const prev = out[out.length - 1];
    if (prev && same(prev, s)) prev.end = s.outStart + s.outFrames;
    else out.push({ start: s.outStart, end: s.outStart + s.outFrames, text: s.captionText, eyebrow: s.eyebrow });
  }
  return out.filter((b) => b.text);
}

/** The white caption's blocks: keyed on its text alone, so a new eyebrow over the same caption doesn't flash it. */
export const captionBlocks = (edit: ResolvedEdit): Block[] => runs(edit, (b, s) => b.text === s.captionText);

/** The orange eyebrow's blocks: keyed on caption and eyebrow, so it fades on its own when only it changes. */
const eyebrowBlocks = (edit: ResolvedEdit): Block[] =>
  runs(edit, (b, s) => b.text === s.captionText && b.eyebrow === s.eyebrow).filter((b) => b.eyebrow);

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
  const brow = eyebrowBlocks(edit).find((b) => frame >= b.start && frame < b.end);
  const fade = (b: Block) => {
    const fadeIn = interpolate(frame - b.start, [0, fps * 0.4], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) });
    const fadeOut = interpolate(b.end - frame, [0, fps * 0.3], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    return { fadeIn, k: Math.min(fadeIn, fadeOut) };
  };
  const line = fade(block);
  const eyebrow = brow ? fade(brow) : null;
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: layout.captionBottom, opacity }}>
      <div
        style={{
          translate: `0 ${interpolate(line.fadeIn, [0, 1], [layout.captionSize * 0.35, 0])}px`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: layout.eyebrowSize * 0.7,
          maxWidth: layout.width * 0.8,
        }}
      >
        {brow && eyebrow ? (
          <div
            style={{
              fontFamily: MONO,
              fontSize: layout.eyebrowSize,
              color: COLORS.accent,
              letterSpacing: '0.04em',
              opacity: Math.min(eyebrow.k, line.k),
            }}
          >
            {brow.eyebrow}
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
            opacity: line.k,
          }}
        >
          {names ? coloured(block.text, cast) : block.text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
