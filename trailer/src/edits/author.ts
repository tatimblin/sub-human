import type { Edit } from '../lib/edl';
import type { Cast } from '../cast';
import { at, plus, type Story } from './trailer';
import { halvesStory } from './halves';

/**
 * take8's story (0.5.0-beta.24 and on): the halves build of take7, with the plan flow it changed. b joins from her
 * machine with the invite line and its PIN and takes her seat on its own; b's own Claude drafts the room plan and b
 * checks it first in her plan view; her Yes sends it out and it opens for a; a objects with a note, his Claude works
 * it in as v2, he sends it out, and both have agreed. Only the README loop is cut for it so far: the trailer and the
 * social cut are take7's (their plan beats look for the room's Claude, which this take has none of, and are skipped).
 */
export function authorStory(c: Cast, room: string): Story {
  const { a, b } = c;
  const s = halvesStory(c, room);
  const Z = 1.7;
  const seated = at('seated', b, "You're in room");
  // the views are open by the time their beats are marked (demo.sh marks after it sees them): look from the beat before
  // (b's own check flickers once as it opens, then stays: take its beat, which comes 0.7 s after it settles)
  const ownCheck = plus('check', -600);
  const aOpens = at('ask', a, 'Ready to code');
  const agreed = at('revision', a, 'agreed (you, ');
  const pass = at('tests', a, 'ℹ pass');

  // the README loop: one line and a PIN, a plan b checks first, the same plan in a's own view, both agree, tests pass
  const readme: Edit = {
    hookSeconds: 0,
    endSeconds: 0,
    loop: true,
    stage: 'side',
    segments: [
      { id: 'join', from: at('join', b, '/sub-h', -300), to: plus(seated, 1400), fit: 3.2, eyebrow: '/sub-human join', caption: `${b} joins from her laptop: the invite line, and the PIN ${a} told her.`, camera: { pane: b, zoom: Z, find: ["You're in room", '/sub-human'] } },
      { id: 'draft', from: at('plan', b, "let's", -300), to: ownCheck, fit: 2.6, model: true, eyebrow: 'Room plan', caption: `${b}'s Claude drafts a room plan. She checks it first.`, camera: { pane: b, zoom: Z, find: ["let's write", 'Ready to code'] } },
      { id: 'own-check', from: ownCheck, to: plus(ownCheck, 2400), speed: 1, eyebrow: 'Room plan', caption: `${b}'s Claude drafts a room plan. She checks it first.`, camera: { pane: b, zoom: 1.25, find: 'Ready to code' } },
      { id: 'a-opens', from: plus(aOpens, -200), to: plus(aOpens, 2000), speed: 1, eyebrow: 'Sign-off', caption: `Her Yes sends it out. It opens for ${a}, in his own plan view.`, camera: { pane: a, zoom: 1.25, find: 'Ready to code' } },
      { id: 'agreed', from: plus(agreed, -300), to: plus(agreed, 1800), speed: 1, eyebrow: 'Sign-off', caption: 'Each person signs off. No Claude can say yes for you.', camera: { pane: a, zoom: Z, find: 'agreed (' } },
      { id: 'pass', from: plus(pass, -200), to: plus(pass, 2200), speed: 1, eyebrow: 'npm test', caption: 'Each Claude built its half. Tests pass for both.', camera: { pane: 'both', zoom: 1.04, find: 'ℹ pass' } },
    ],
  };
  return { ...s, readme, native: s.native ? { ...s.native, readme } : undefined };
}
