import React from 'react';
import { Composition } from 'remotion';
import { calculateTrailerMetadata, Trailer } from './Trailer';

/**
 * Swap in a real take with one prop: `take` names a folder under trailer/capture/ (e.g.
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
          take: 'take4',
          edit: 'trailer' as const,
          seats: ['alice', 'bob'],
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
          take: 'take4',
          edit: 'trailer' as const,
          seats: ['alice', 'bob'],
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
        durationInFrames={450}
        fps={30}
        width={1280}
        height={720}
        calculateMetadata={calculateTrailerMetadata}
        defaultProps={{
          take: 'take4',
          edit: 'readme' as const,
          seats: ['alice', 'bob'],
          music: null,
          musicVolume: 0.5,
          keyClicks: false,
          scrubWords: [],
          dropRows: ['Update available! Run:', 'ctrl+g to edit', 'ctrl-g to edit', 'shift+tab to cycle', 'proposed by claude', 'Tip: '],
          compact: true,
        }}
      />
    </>
  );
};
