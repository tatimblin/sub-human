import { ALICE_BOB, TRISTAN_JESS, type Cast } from './cast';
import type { Capture } from './lib/capture';
import { testsStory, type Story } from './edits/trailer';
import { halvesStory } from './edits/halves';

/**
 * Per take: who is in it (the cast: names and colours, name plates, captions, tag labels) and which story its
 * cuts tell. The synthetic and fixture takes are alice and bob, with bob's Claude writing the
 * tests; take7 is tristan and jess, both Claudes writing code (take6, an aborted take, is not listed). A take not
 * listed here gets the newest story, with its two people read from the capture (the first two sessions that are not
 * "claude", in the capture's order).
 */
type TakeConfig = {
  cast: Cast;
  story: (c: Cast, room: string) => Story;
  /** which cuts the plain edit names (trailer, social, readme) mean: the v2 split ones, or the v3 native ones */
  style?: 'v2' | 'v3';
};

const TESTS: TakeConfig = { cast: ALICE_BOB, story: testsStory };
export const TAKES: Record<string, TakeConfig> = {
  synthetic: TESTS,
  fixture: TESTS,
  take7: { cast: TRISTAN_JESS, story: halvesStory, style: 'v3' },
};

export function castFor(take: string, cap: Capture): Cast {
  const known = TAKES[take]?.cast;
  if (known) return known;
  const seats = Object.keys(cap.meta.sessions).filter((k) => k !== 'claude');
  return seats.length >= 2 ? { a: seats[0], b: seats[1] } : TRISTAN_JESS;
}

const cache = new Map<string, Story>();

/** The take's story, built once per take (its edits keep their identity across frames). */
export function storyFor(take: string, cap: Capture): Story {
  const c = castFor(take, cap);
  const room = (cap.meta.room ?? '').split('-')[0] || 'room';
  const key = JSON.stringify([take, c, room]);
  let s = cache.get(key);
  if (!s) {
    s = (TAKES[take]?.story ?? halvesStory)(c, room);
    cache.set(key, s);
  }
  return s;
}

/** The take's default style: v3 (native) for take7, v2 for the takes before it. */
export const styleFor = (take: string): 'v2' | 'v3' => TAKES[take]?.style ?? 'v2';
