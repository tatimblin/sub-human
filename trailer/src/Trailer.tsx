import React, { useMemo } from 'react';
import { Audio } from '@remotion/media';
import { linearTiming, TransitionSeries } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  type CalculateMetadataFunction,
} from 'remotion';
import { loadCapture, type Capture } from './lib/capture';
import { stripAnsi } from './lib/ansi';
import { outputFrame, resolveEdit, type Edit, type ResolvedEdit } from './lib/edl';
import { useTake } from './lib/useTake';
import { COLORS, TAGLINE, sideLayout, splitLayout, stackedLayout, type SplitLayout, type StageLayout } from './design';
import { Replay } from './components/Replay';
import { SplitReplay } from './components/SplitReplay';
import { Wordmark } from './components/Wordmark';
import { EndCard } from './scenes/EndCard';
import { MONO, SANS } from './fonts/fonts';
import { CastContext } from './cast';
import { castFor, storyFor, styleFor } from './takes';

export type TrailerProps = {
  /** a folder under trailer/capture/ holding capture.jsonl[.gz] ("synthetic", "fixture", or a real take id) */
  take: string;
  /**
   * which cut: the trailer's, the 15 s social cut, the README loop's, in the take's default style (takes.ts: v3 for
   * take7, v2 before it); or one style by name: `-v3` native, `-v2` split screen
   */
  edit: Cut | `${Cut}-v2` | `${Cut}-v3`;
  /** the panes, left to right (or top to bottom); empty = the take's two people (takes.ts) */
  seats: string[];
  /** optional music: a URL, or a path under public/ */
  music: string | null;
  musicVolume: number;
  /** a soft click per typed key (public/sfx/key-click.wav) */
  keyClicks: boolean;
  /** extra words to scrub from every frame (a username, a hostname) */
  scrubWords: string[];
  /** rows to drop from every screen (plain-text substrings); empty = the default (the update nag) */
  dropRows: string[];
  /** cropped (stacked) panes drop blank rows to fit more in */
  compact: boolean;
};

type Cut = 'trailer' | 'social' | 'readme';

/**
 * The cut: the v2 and v3 ones come from the take's story (its cast and build, takes.ts), v3 where the story has it
 * (else v2).
 */
function editFor(take: string, cap: Capture, which: TrailerProps['edit']): Edit {
  const [cut, style = styleFor(take)] = which.split('-') as [Cut, string?];
  const story = storyFor(take, cap);
  return (style === 'v3' && story.native ? story.native : story)[cut];
}

function seatsFor(take: string, cap: Capture, seats: string[]): string[] {
  if (seats?.length) return seats;
  const c = castFor(take, cap);
  return [c.a, c.b];
}
const FADE = 20; // frames of crossfade into the end card
const HOLD = 1.2; // seconds the last replay frame holds (the end card's crossfade starts in it)

const scrubOpts = (p: TrailerProps) => ({ words: p.scrubWords, dropRows: p.dropRows?.length ? p.dropRows : undefined });

function timing(edit: Edit, resolved: ResolvedEdit, fps: number) {
  const hook = Math.round(edit.hookSeconds * fps);
  // a loop (no end card) runs straight back to its start: no hold on the last frame
  const main = hook + resolved.frames + Math.round(((edit.v2 || edit.loop) && !edit.endSeconds ? 0 : HOLD) * fps);
  const end = Math.round(edit.endSeconds * fps);
  return { hook, main, end, total: end > 0 ? main + end - FADE : main };
}

export const calculateTrailerMetadata: CalculateMetadataFunction<TrailerProps> = async ({ props, compositionId }) => {
  const fps = 30;
  const cap = await loadCapture(props.take, scrubOpts(props));
  const edit = editFor(props.take, cap, props.edit);
  const resolved = resolveEdit(cap, edit, fps);
  const t = timing(edit, resolved, fps);
  // the cut, in composition frames: handy for `npx remotion still --frame=N`
  console.log(
    `[cut] ${compositionId} take=${props.take}: ` +
      resolved.segments.map((s) => `${s.id}@${t.hook + s.outStart}+${s.outFrames}(${s.rate.toFixed(1)}x)`).join(' ') +
      (t.end ? ` end@${t.main - FADE}` : ''),
  );
  return {
    durationInFrames: timing(edit, resolved, fps).total,
    defaultOutName: `${compositionId}-${props.take}`,
  };
};

function layoutFor(width: number, height: number, cap: Capture, seats: string[], compact: boolean, edit: Edit): StageLayout | SplitLayout {
  const s = cap.meta.sessions[seats[0]] || { cols: 120, rows: 40 };
  if (edit.v2) return splitLayout(width, height, seats, s.cols, s.rows, { captions: edit.captions !== false, node: !!edit.roomNode });
  if ((width / height > 1.5 && height >= 1000) || edit.stage === 'side') return sideLayout(width, height, seats, s.cols, s.rows);
  if (height > width) return stackedLayout(width, height, seats, s.cols, { top: 96, captionZone: 230, gap: 28, mx: 44, compact });
  if (width === height) return stackedLayout(width, height, seats, s.cols, { top: 84, captionZone: 176, gap: 26, mx: 44, compact });
  return stackedLayout(width, height, seats, s.cols, { top: 14, captionZone: 84, gap: 12, mx: 30, compact });
}

/** One click per typed key, at the frame its key lands (only where the replay runs near real time). */
const KeyClicks: React.FC<{ cap: Capture; resolved: ResolvedEdit; offset: number }> = ({ cap, resolved, offset }) => {
  const { fps } = useVideoConfig();
  const at = useMemo(() => {
    const plain = (s: string) => stripAnsi(s).split('\n');
    const out = new Set<number>();
    for (const fs of Object.values(cap.frames)) {
      for (let i = 1; i < fs.length; i++) {
        const a = plain(fs[i - 1].ansi);
        const b = plain(fs[i].ansi);
        const diff = b.map((l, k) => (l !== a[k] ? k : -1)).filter((k) => k >= 0);
        if (diff.length !== 1) continue;
        const k = diff[0];
        if (b[k].trimEnd().length - (a[k] ?? '').trimEnd().length !== 1) continue;
        const hit = outputFrame(resolved, fs[i].t, fps);
        if (hit && hit.rate <= 2) out.add(hit.frame);
      }
    }
    return [...out].sort((x, y) => x - y);
  }, [cap, resolved, fps]);
  return (
    <>
      {at.map((f) => (
        <Sequence key={f} from={offset + f} durationInFrames={Math.round(fps * 0.2)} layout="none">
          <Audio src={staticFile('sfx/key-click.wav')} volume={0.18} />
        </Sequence>
      ))}
    </>
  );
};

/** The hook (title over the two panes) running into the replay. */
const Main: React.FC<{ cap: Capture; edit: Edit; resolved: ResolvedEdit; layout: StageLayout; hook: number }> = ({ cap, edit, resolved, layout, hook }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = Math.min(width / 1920, height / 1080) * (width === height ? 1.2 : 1);
  const replayFrame = Math.max(0, frame - hook);
  const teaserSeg = hook && edit.hookTeaser ? resolved.segments.find((s) => s.id === edit.hookTeaser) : undefined;
  const teaser = teaserSeg ? teaserSeg.outStart + teaserSeg.outFrames - 1 : null;
  // hook: panes sit back behind the title, then come forward as it leaves
  const out = hook ? interpolate(frame, [hook - fps * 0.9, hook], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.65, 0, 0.35, 1) }) : 1;
  const titleIn = interpolate(frame, [fps * 0.15, fps * 1.1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const tagIn = interpolate(frame, [fps * 0.6, fps * 1.5], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const panesIn = interpolate(frame, [0, fps * 0.8], [0, 1], { extrapolateRight: 'clamp' });
  const markIn = interpolate(frame, [hook, hook + fps * 0.6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  // the replay dims before the end card comes up, so the two never share the screen at full strength
  // (the README loop has no end card: it fades to the background, which is where it starts)
  const replayEnd = hook + resolved.frames;
  const endOut = edit.endSeconds
    ? interpolate(frame, [replayEnd + fps * HOLD - FADE - 8, replayEnd + fps * HOLD - 4], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.65, 0, 0.35, 1) })
    : interpolate(frame, [replayEnd - fps * 0.4, replayEnd], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: `radial-gradient(ellipse 80% 70% at 50% 40%, ${COLORS.bgLift} 0%, ${COLORS.bg} 75%)` }}>
      <AbsoluteFill
        style={{
          // with a teaser, it leaves before the live panes arrive: two blurred screens never blend
          opacity: panesIn * (teaser != null ? Math.max(0, out * 2 - 1) : interpolate(out, [0, 1], [0.3, 1])) * endOut,
          filter: out < 1 ? `blur(${(1 - out) * 6 * u}px)` : undefined,
          scale: String(interpolate(out, [0, 1], [0.965, 1])),
        }}
      >
        <Replay cap={cap} edit={resolved} layout={layout} frame={replayFrame} chrome={out} subtitle="Claude Code" mark={hook > 0 ? markIn : 0} />
      </AbsoluteFill>
      {teaser != null && out < 1 ? (
        // the hook's backdrop: both plan views open, a glimpse of where this is going
        <AbsoluteFill style={{ opacity: panesIn * 0.5 * Math.max(0, 1 - out * 2), filter: `blur(${3 * u}px)`, scale: '0.965' }}>
          <Replay cap={cap} edit={resolved} layout={layout} frame={teaser} chrome={0} subtitle="Claude Code" />
        </AbsoluteFill>
      ) : null}
      {hook ? (
        <AbsoluteFill
          style={{
            opacity: (1 - out) * panesIn,
            background: `radial-gradient(ellipse 48% 40% at 50% 50%, ${COLORS.bg}f0 0%, ${COLORS.bg}b0 55%, ${COLORS.bg}00 100%)`,
          }}
        />
      ) : null}
      {hook ? (
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: 1 - out, pointerEvents: 'none' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 30 * u, translate: `0 ${-out * 40 * u}px` }}>
            <div style={{ opacity: titleIn * 0.95, fontFamily: MONO, fontSize: 22 * u, color: COLORS.accent, letterSpacing: '0.06em' }}>
              a Claude Code plugin
            </div>
            <div style={{ opacity: titleIn, translate: `0 ${(1 - titleIn) * 24 * u}px` }}>
              <Wordmark size={148 * u} />
            </div>
            <div
              style={{
                opacity: tagIn,
                translate: `0 ${(1 - tagIn) * 16 * u}px`,
                fontFamily: SANS,
                fontSize: 40 * u,
                color: COLORS.textSoft,
                letterSpacing: '-0.01em',
                textAlign: 'center',
                maxWidth: width * 0.8,
              }}
            >
              {TAGLINE}
            </div>
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};

/** The v2 cut: the split replay from its first frame (no hook), dimming before the end card (or fading, for a loop). */
const SplitMain: React.FC<{ cap: Capture; edit: Edit; resolved: ResolvedEdit; layout: SplitLayout }> = ({ cap, edit, resolved, layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const end = resolved.frames;
  const opacity = edit.endSeconds
    ? interpolate(frame, [end + fps * HOLD - FADE - 8, end + fps * HOLD - 4], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.65, 0, 0.35, 1) })
    : Math.min(
        interpolate(frame, [0, fps * 0.25], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        interpolate(frame, [end - fps * 0.35, end], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
      );
  return (
    <AbsoluteFill style={{ background: `radial-gradient(ellipse 80% 70% at 50% 40%, ${COLORS.bgLift} 0%, ${COLORS.bg} 75%)` }}>
      <AbsoluteFill style={{ opacity }}>
        <SplitReplay cap={cap} edit={resolved} layout={layout} frame={frame} roomNode={!!edit.roomNode} captions={edit.captions !== false} subtitle="Claude Code" />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const Trailer: React.FC<TrailerProps> = (props) => {
  const { fps, width, height } = useVideoConfig();
  const cap = useTake(props.take, scrubOpts(props));
  const edit = useMemo(() => (cap ? editFor(props.take, cap, props.edit) : null), [cap, props.take, props.edit]);
  const resolved = useMemo(() => (cap && edit ? resolveEdit(cap, edit, fps) : null), [cap, edit, fps]);
  const layout = useMemo(
    () => (cap && edit ? layoutFor(width, height, cap, seatsFor(props.take, cap, props.seats), props.compact, edit) : null),
    [cap, width, height, props.take, props.seats, props.compact, edit],
  );
  if (!cap || !edit || !resolved || !layout) return <AbsoluteFill style={{ background: COLORS.bg }} />;
  const t = timing(edit, resolved, fps);
  const music = props.music ? (/^(https?:|data:)/.test(props.music) ? props.music : staticFile(props.music)) : null;
  return (
    <CastContext.Provider value={castFor(props.take, cap)}>
    <AbsoluteFill style={{ background: COLORS.bg }}>
      {t.end > 0 ? (
        <TransitionSeries>
          <TransitionSeries.Sequence name="Hook and replay" durationInFrames={t.main} premountFor={fps}>
            {layout.kind === 'split' ? <SplitMain cap={cap} edit={edit} resolved={resolved} layout={layout} /> : <Main cap={cap} edit={edit} resolved={resolved} layout={layout} hook={t.hook} />}
          </TransitionSeries.Sequence>
          <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: FADE })} />
          <TransitionSeries.Sequence name="End card" durationInFrames={t.end} premountFor={fps}>
            <EndCard variant={edit.endCard ?? (edit.v2 ? 'full' : 'v1')} />
          </TransitionSeries.Sequence>
        </TransitionSeries>
      ) : layout.kind === 'split' ? (
        <SplitMain cap={cap} edit={edit} resolved={resolved} layout={layout} />
      ) : (
        <Main cap={cap} edit={edit} resolved={resolved} layout={layout} hook={t.hook} />
      )}
      {props.keyClicks ? <KeyClicks cap={cap} resolved={resolved} offset={t.hook} /> : null}
      {music ? (
        <Audio
          src={music}
          volume={(f) =>
            props.musicVolume *
            Math.min(
              interpolate(f, [0, fps * 1.5], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
              interpolate(f, [t.total - fps * 2.5, t.total], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
            )
          }
        />
      ) : null}
    </AbsoluteFill>
    </CastContext.Provider>
  );
};
