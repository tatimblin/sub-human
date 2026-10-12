import { ALICE_BOB, TRISTAN_JESS, type Cast } from './cast';
import type { Capture } from './lib/capture';
import { testsStory, type Story } from './edits/trailer';
import { halvesStory } from './edits/halves';

/**
 * Per take: who is in it (the cast: names and colours, name plates, captions, tag labels) and which story its
 * cuts tell. take4/take5 (and the synthetic and fixture takes) are alice and bob, with bob's Claude writing the
 * tests; take6 is tristan and jess, both Claudes writing code. A take not listed here gets the newest story, with
 * its two people read from the capture (the first two sessions that are not "claude", in the capture's order).
 */
type TakeConfig = { cast: Cast; story: (c: Cast, room: string) => Story };

const TESTS: TakeConfig = { cast: ALICE_BOB, story: testsStory };
export const TAKES: Record<string, TakeConfig> = {
  take4: TESTS,
  take5: TESTS,
  synthetic: TESTS,
  fixture: TESTS,
  take6: { cast: TRISTAN_JESS, story: halvesStory },
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
