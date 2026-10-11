import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../design';
import { SANS } from '../fonts/fonts';

/** "sub-human" with a terminal cursor in the accent colour (it blinks once a second when `blink`). */
export const Wordmark: React.FC<{ size: number; blink?: boolean; color?: string }> = ({ size, blink = false, color = COLORS.text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const on = !blink || Math.floor(frame / (fps / 2)) % 2 === 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', fontFamily: SANS, fontSize: size, fontWeight: 650, letterSpacing: '-0.045em', color, lineHeight: 1 }}>
      <span>sub-human</span>
      <span
        style={{
          display: 'inline-block',
          width: size * 0.42,
          height: size * 0.82,
          marginLeft: size * 0.1,
          translate: `0 ${size * 0.04}px`,
          background: COLORS.accent,
          borderRadius: size * 0.04,
          opacity: on ? 1 : 0,
        }}
      />
    </div>
  );
};
