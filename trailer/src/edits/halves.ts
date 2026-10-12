import type { Edit, Tag } from '../lib/edl';
import type { Cast } from '../cast';
import { anchorsFor, any, at, beatsFor, captionsFor, plus, readmeEdit, socialEdit, storySegments, tagsFor, wordsFor, type Story, type Words } from './trailer';

/**
 * The take6 story: both people's Claudes write real code. a's Claude the store (src/store.js: listTasks with an
 * opaque cursor), b's Claude the HTTP handler (src/server.js: ?limit&after, 400 on a bad cursor), each with its own
 * tests. b's Claude waits for a's "pushed" message, then pulls and runs npm test; then both people run it.
 *
 * Tuning against a real take: every build anchor is a beat first (demo.sh --film's markers: split, build,
 * subagent, claimed, store or handler, tested, tests, pass) refined by what a pane shows, with the bare beat as the
 * fallback (`any(text, beat)`). The text each one looks for is in WORDS and BUILD below: adjust those first, then
 * the offsets in the segments. `npx remotion compositions --log=verbose | grep '\[cut\]'` prints the resolved cut,
 * and an `[edl]` line names any segment the take lacks.
 */

/** S1–S5 as the take shows them: take5's wording with the new names, unless set here. */
const WORDS = (c: Cast, room: string): Words => ({
  ...wordsFor(c, room),
  // node --test's counts differ from take5's 11: any summary row
  testsRow: 'ℹ tests',
  passRow: 'ℹ pass',
});

/** The build's moments, as each pane shows them. */
const BUILD = (c: Cast) => {
  const { a, b } = c;
  // the beat a's Claude's "pushed" falls in: demo.sh may call it "store" or (as in take5) "handler"
  const pushedBeat = any('store', 'handler', 'tested');
  return {
    /** the two tasks on the room's list, as each pane shows them */
    aTaskFind: ['store.js', 'listTasks', 'owner you'],
    bTaskFind: ['server.js', 'handler', 'owner you'],
    bTask: any(at('split', b, ['server.js', 'handler', 'owner you']), plus('split', 4000)),
    /** each Claude writing its half */
    aCodeFind: ['Update(src/store', 'Write(src/store', 'Update(src/', 'Write(src/'],
    bCodeFind: ['Update(src/server', 'Write(src/server', 'Update(src/', 'Write(src/'],
    aCodes: any(at('build', a, ['Update(src/store', 'Write(src/store', 'Update(src/', 'Write(src/']), plus('build', 3000)),
    /** a subagent row in a panel: the beat lands when it shows */
    subagent: any('subagent', at('build', b, '◯ Explore'), at('build', a, '◯ Explore')),
    /** a's Claude tells b's the store is pushed (b's pane shows it) */
    pushedFind: [`${a}'s Claude: The store`, `${a}'s Claude: `],
    pushedFromFind: ['Pushed', `telling ${b}`, `${b}'s Claude`],
    pushed: any(at('build', b, [`${a}'s Claude: The store`, `${a}'s Claude: `]), pushedBeat),
    /** b's Claude pulls and runs npm test against a's store */
    bTestedFind: ['Bash(npm test', 'npm test', 'Bash(git pull'],
    bPulls: any(at(pushedBeat, b, ['Bash(git pull', 'git pull']), plus(pushedBeat, 1500)),
    bTested: any(at(pushedBeat, b, ['ℹ pass', 'Bash(npm test', 'tests pass']), 'tested'),
  };
};

export function halvesStory(c: Cast, room: string): Story {
  const { a, b } = c;
  const words = WORDS(c, room);
  const A = anchorsFor(c, words);
  const CAPTION = captionsFor(c);
  const TAG = tagsFor(c, words, A);
  const BEATS = beatsFor(c, words, A);
  const B = BUILD(c);
  const build = `Each Claude builds its half: ${a}'s the store, ${b}'s the API.`;
  const pushed: Tag = { from: a, to: b, sender: `${a}'s Claude`, toLabel: `${b}'s Claude`, label: '"The store is pushed. You can pull."', fromFind: B.pushedFromFind, toFind: B.pushedFind, arrive: B.pushed, dur: 1.1 };
  const trailer: Edit = {
    v2: true,
    roomNode: true,
    hookSeconds: 0,
    endSeconds: 4.6,
    endCard: 'full',
    segments: [
      ...storySegments(c, words, A, BEATS),
      // the split: one task each, a's the store, b's the handler
      {
        id: 'tasks',
        from: plus(B.bTask, -300),
        to: plus(B.bTask, 1800),
        speed: 1,
        dip: true,
        caption: build,
        views: { [a]: { zoom: 1.4, find: B.aTaskFind }, [b]: { zoom: 1.4, find: B.bTaskFind } },
        marks: [
          { pane: a, find: B.aTaskFind, who: a, label: `${a}'s task` },
          { pane: b, find: B.bTaskFind, who: b, label: `${b}'s task` },
        ],
      },
      // both Claudes write code, side by side (model time)
      { id: 'build', from: plus(B.aCodes, -400), to: plus(B.subagent, -300), fit: 2.2, model: true, dip: true, caption: build, views: { [a]: { zoom: 1.3, find: B.aCodeFind }, [b]: { zoom: 1.3, find: B.bCodeFind } } },
      {
        id: 'subagent',
        from: plus(B.subagent, -300),
        to: plus(B.subagent, 2300),
        speed: 1,
        caption: CAPTION.subagent,
        views: { [a]: { zoom: 1.6, anchor: 'bottom' }, [b]: { zoom: 1.6, anchor: 'bottom' } },
        marks: [
          { pane: a, find: '◯ Explore', who: a, label: 'a subagent' },
          { pane: b, find: '◯ Explore', who: b, label: 'a subagent' },
        ],
      },
      { id: 'build-on', from: plus(B.subagent, 2300), to: plus(B.pushed, -1300), fit: 1.6, model: true, caption: build, views: { [a]: { zoom: 1.3, find: B.aCodeFind }, [b]: { zoom: 1.3, find: B.bCodeFind } } },
      // a's Claude: "pushed"; b's Claude pulls and runs the tests against it
      { id: 'pushed', from: plus(B.pushed, -1300), to: plus(B.pushed, 1500), speed: 1, dip: true, caption: CAPTION.posted, views: { [a]: { zoom: 1.35, find: B.pushedFromFind }, [b]: { zoom: 1.35, find: B.pushedFind } }, tags: [pushed] },
      {
        id: 'pulled',
        from: plus(B.bPulls, -300),
        to: plus(B.bTested, 1200),
        fit: 2,
        model: true,
        focus: b,
        caption: CAPTION.posted,
        views: { [b]: { zoom: 1.35, find: B.bTestedFind }, [a]: { zoom: 1.3, anchor: 'bottom' } },
        marks: [{ pane: b, find: B.bTestedFind, who: b, label: `${b}'s Claude runs the tests` }],
      },
      BEATS.tests,
      BEATS.pass,
    ],
  };
  const s = { cast: c, words, A, CAPTION, TAG, BEATS };
  return { ...s, trailer, social: socialEdit(s), readme: readmeEdit(s) };
}
