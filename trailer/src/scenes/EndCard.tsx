import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS, TAGLINE } from '../design';
import { MONO, SANS } from '../fonts/fonts';
import { Wordmark } from '../components/Wordmark';

/** The install lines, verbatim from the README. */
export const INSTALL = ['/plugin marketplace add tatimblin/sub-human', '/plugin install sub-human@sub-human'];
export const REPO = 'github.com/tatimblin/sub-human';

const rise = (frame: number, at: number, fps: number) => {
  const p = interpolate(frame, [at, at + fps * 0.7], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return { opacity: p, translate: `0 ${(1 - p) * 18}px` };
};

/**
 * The call to action. `full` and `short` (the v2 cuts): the tagline, the two /plugin lines, "Then run /sub-human."
 * and the repo (`short`, for the 15 s cut, comes up faster). `v1`: the take4 cut's card. `native` (`native-short`):
 * the v1 card with "Then run /sub-human." in its last line (the v3 cuts).
 */
export const EndCard: React.FC<{ variant?: 'v1' | 'full' | 'short' | 'native' | 'native-short' }> = ({ variant = 'full' }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = Math.min(width / 1920, height / 1080) * (width < height * 1.2 ? 1.45 : 1);
  const k = variant === 'short' || variant === 'native-short' ? 0.55 : 1; // the short card's lines arrive sooner
  const native = variant === 'native' || variant === 'native-short';
  const v1 = variant === 'v1' || native;
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
          <Wordmark size={(v1 ? 112 : 84) * u} blink />
        </div>
        {v1 ? (
          <div style={{ ...rise(frame, fps * 0.25 * k, fps), fontFamily: SANS, fontSize: 36 * u, color: COLORS.textSoft, letterSpacing: '-0.01em', textAlign: 'center', maxWidth: width * 0.84 }}>
            {TAGLINE}
          </div>
        ) : (
          <div style={{ ...rise(frame, fps * 0.2 * k, fps), fontFamily: SANS, fontSize: 56 * u, fontWeight: 600, color: COLORS.text, letterSpacing: '-0.025em', lineHeight: 1.15, textAlign: 'center', textWrap: 'balance', maxWidth: width * 0.9 }}>
            {TAGLINE}
          </div>
        )}
        <div
          style={{
            ...rise(frame, fps * 0.6 * k, fps),
            marginTop: (v1 ? 26 : 10) * u,
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
            <div key={line} style={{ ...rise(frame, fps * (0.75 + i * 0.18) * k, fps), fontFamily: MONO, fontSize: 34 * u, color: COLORS.text, whiteSpace: 'pre' }}>
              {v1 ? null : <span style={{ color: COLORS.accent }}>{'❯ '}</span>}
              {line}
            </div>
          ))}
        </div>
        {native ? (
          <div style={{ ...rise(frame, fps * 1.3 * k, fps), display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 * u, textAlign: 'center' }}>
            <div style={{ fontFamily: SANS, fontSize: 30 * u, color: COLORS.textSoft, letterSpacing: '-0.005em' }}>
              Then run <span style={{ fontFamily: MONO, color: COLORS.text }}>/sub-human</span>.
            </div>
            <div style={{ fontFamily: MONO, fontSize: 24 * u, color: COLORS.textFaint }}>{REPO}</div>
          </div>
        ) : v1 ? (
          <div style={{ ...rise(frame, fps * 1.3, fps), fontFamily: SANS, fontSize: 24 * u, color: COLORS.textFaint, letterSpacing: '0.005em', textAlign: 'center' }}>
            Then restart Claude Code. <span style={{ color: COLORS.textSoft }}>{REPO}</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 * u }}>
            <div style={{ ...rise(frame, fps * 1.15 * k, fps), fontFamily: SANS, fontSize: 34 * u, color: COLORS.textSoft, textAlign: 'center' }}>
              Then run <span style={{ fontFamily: MONO, color: COLORS.text }}>/sub-human</span>.
            </div>
            <div style={{ ...rise(frame, fps * 1.4 * k, fps), fontFamily: MONO, fontSize: 26 * u, color: COLORS.textFaint, textAlign: 'center' }}>{REPO}</div>
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
