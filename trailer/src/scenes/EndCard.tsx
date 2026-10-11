import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../design';
import { MONO, SANS } from '../fonts/fonts';
import { Wordmark } from '../components/Wordmark';

/** The install lines, verbatim from the README. */
export const INSTALL = ['/plugin marketplace add tatimblin/sub-human', '/plugin install sub-human@sub-human'];

const rise = (frame: number, at: number, fps: number) => {
  const p = interpolate(frame, [at, at + fps * 0.7], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return { opacity: p, translate: `0 ${(1 - p) * 18}px` };
};

export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = Math.min(width / 1920, height / 1080) * (width < height * 1.2 ? 1.45 : 1);
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse 70% 60% at 50% 42%, ${COLORS.bgLift} 0%, ${COLORS.bg} 70%)`,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 34 * u }}>
        <div style={rise(frame, 0, fps)}>
          <Wordmark size={112 * u} blink />
        </div>
        <div style={{ ...rise(frame, fps * 0.25, fps), fontFamily: SANS, fontSize: 36 * u, color: COLORS.textSoft, letterSpacing: '-0.01em', textAlign: 'center', maxWidth: width * 0.84 }}>
          Pair up in Claude Code without giving up your own session.
        </div>
        <div
          style={{
            ...rise(frame, fps * 0.6, fps),
            marginTop: 26 * u,
            background: COLORS.bgLift,
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: 18 * u,
            padding: `${30 * u}px ${44 * u}px`,
            display: 'flex',
            flexDirection: 'column',
            gap: 18 * u,
            boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
          }}
        >
          {INSTALL.map((line, i) => (
            <div key={line} style={{ ...rise(frame, fps * (0.75 + i * 0.18), fps), fontFamily: MONO, fontSize: 34 * u, color: COLORS.text, whiteSpace: 'pre' }}>
              {line}
            </div>
          ))}
        </div>
        <div style={{ ...rise(frame, fps * 1.3, fps), fontFamily: SANS, fontSize: 24 * u, color: COLORS.textFaint, letterSpacing: '0.005em', textAlign: 'center' }}>
          Then restart Claude Code. <span style={{ color: COLORS.textSoft }}>github.com/tatimblin/sub-human</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
