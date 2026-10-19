import React from 'react';
import { Composition } from 'remotion';
import { calculateTrailerMetadata, Trailer } from './Trailer';

/**
 * Trailer (16:9) and TrailerSquare share one cut; Social15 is the 15 s cut, ReadmeLoop the README GIF's loop. Each is
 * the take's default style (v3 native for take7, v2 split screen before it); `edit: "trailer-v2"` / `"trailer-v3"`
 * pick one. Swap in a real take with one prop: `take` names a folder under trailer/capture/ (e.g.
 * `npx remotion render Trailer --props='{"take":"2026-10-12-1530"}'`). Durations come from the take.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Trailer"
        component={Trailer}
        durationInFrames={2250}
        fps={30}
        width={1920}
        height={1080}
        calculateMetadata={calculateTrailerMetadata}
        defaultProps={{
          take: 'take7',
          edit: 'trailer' as const,
          seats: [] as string[],
          music: null,
          musicVolume: 0.5,
          keyClicks: false,
          scrubWords: [],
          dropRows: [],
          compact: false,
        }}
      />
      <Composition
        id="TrailerSquare"
        component={Trailer}
        durationInFrames={2250}
        fps={30}
        width={1080}
        height={1080}
        calculateMetadata={calculateTrailerMetadata}
        defaultProps={{
          take: 'take7',
          edit: 'trailer' as const,
          seats: [] as string[],
          music: null,
          musicVolume: 0.5,
          keyClicks: false,
          scrubWords: [],
          dropRows: [],
          compact: false,
        }}
      />
      <Composition
        id="Social15"
        component={Trailer}
        durationInFrames={450}
        fps={30}
        width={1080}
        height={1350}
        calculateMetadata={calculateTrailerMetadata}
        defaultProps={{
          take: 'take7',
          edit: 'social' as const,
          seats: [] as string[],
          music: null,
          musicVolume: 0.5,
          keyClicks: false,
          scrubWords: [],
          dropRows: [],
          compact: false,
        }}
      />
      <Composition
        id="ReadmeLoop"
        component={Trailer}
        durationInFrames={240}
        fps={30}
        width={1280}
        height={720}
        calculateMetadata={calculateTrailerMetadata}
        defaultProps={{
          take: 'take8',
          edit: 'readme' as const,
          seats: [] as string[],
          music: null,
          musicVolume: 0.5,
          keyClicks: false,
          scrubWords: ['tristantimblin'],
          dropRows: [],
          compact: false,
        }}
      />
    </>
  );
};
