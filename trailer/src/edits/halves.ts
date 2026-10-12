import type { Edit, Segment, Tag } from '../lib/edl';
import { nativeCuts } from './native';
import type { Cast } from '../cast';
import { anchorsFor, any, at, beatsFor, captionsFor, plus, readmeEdit, socialEdit, storySegments, tagsFor, wordsFor, type Story, type Words } from './trailer';

/**
 * The halves story (take7 on): both people's Claudes write real code. a's Claude the store (src/store.js: listTasks
 * with an opaque cursor), b's Claude the HTTP handler (src/server.js: 400 on a bad cursor), each with its own tests.
 * In take7, b's Claude sends an Explore subagent to read the store, a's Claude pushes the store and tells b's, b's
 * pulls it, builds the handler on it, then pulls again and runs npm test on both halves; then both people run it.
 *
 * Tuning against a real take: every build anchor is a beat first (demo.sh --film's markers: split, build,
 * subagent, claimed, pushed, handoff, pulled, tested, tests, pass) refined by what a pane shows, with the bare beat as
 * the fallback (`any(text, beat)`). The text each one looks for is in WORDS and BUILD below: adjust those first, then
 * the offsets in the segments. `npx remotion compositions --log=verbose | grep '\[cut\]'` prints the resolved cut,
 * and an `[edl]` line names any segment the take lacks.
 */

/** S1–S5 as take7 shows them (demo.sh's film prompts), beyond the names. */
export const WORDS = (c: Cast, room: string): Words => ({
  ...wordsFor(c, room),
  talkLabel: `"${c.b}, can you take the HTTP side of paging?"`,
  answerLabel: '"A counter: nextId++ from 1, in insertion order."',
  noteLabel: '"No: a garbled cursor must 400, not 500"',
  // node --test's counts differ from take5's 11: any summary row
  testsRow: 'ℹ tests',
  passRow: 'ℹ pass',
});

/** The build's moments, as each pane shows them. */
export const BUILD = (c: Cast) => {
  const { a, b } = c;
  return {
    /** the two tasks on the room's list: a's Claude lists both, b's pane gets its own */
    aTaskFind: ['Yours: add listTasks', 'listTasks', 'store.js'],
    bTaskFind: ['task "HTTP: GET', 'owner you'],
    bTask: any(at('split', b, 'owner you'), plus('split', 4000)),
    /** each Claude writing its half */
    aCodeFind: ['Write(test/store', 'Update(src/store', 'Update(src/', 'Write(src/'],
    bCodeFind: ['Write(test/server', 'Update(src/server', 'Update(src/', 'Write(src/'],
    aCodes: any(at('build', a, ['Update(src/store', 'Write(src/store', 'Update(src/', 'Write(src/']), plus('build', 3000)),
    /** b's prompt sends the Explore subagent; the beat lands when its panel row shows */
    bAskFind: ['send an Explore', 'claim #'],
    subagent: any(at('build', b, '◯ Explore'), 'subagent'),
    /** a's Claude tells b's the store is pushed (b's pane shows it) */
    pushedFind: [`${a}'s Claude: listTasks is pushed`, `${a}'s Claude: `],
    pushedFromFind: ['Pushed to main', 'Calling plugin:sub-human:room', `${b}'s Claude`],
    pushed: any(at('pushed', b, [`${a}'s Claude: listTasks is pushed`, `${a}'s Claude: `]), 'handoff'),
    /** b's Claude pulls the store */
    bPullFind: ['Bash(git pull', 'git pull'],
    bPulls: any(at('handoff', b, 'Bash(git pull'), 'pulled'),
    /** b's Claude builds the handler on it */
    bCodes: any(at('pulled', b, ['Update(src/server', 'Write(src/server']), plus('pulled', 3000)),
    /** b's Claude pulls again and runs npm test on both halves, then says it passed */
    bTestFind: ['I built the', 'Pulling main and running'],
    bTests: any(at('pulled', b, 'npm test 2>&1'), at('pulled', b, 'Pulling main and running tests'), plus('tested', -12000)),
    bTested: any(at('pulled', b, ['npm test passes 10', 'I built the']), 'tested'),
  };
};

/** take7's story beats, a little tighter than take5's: the build has more beats to show. */
function tuned(x: Segment, A: ReturnType<typeof anchorsFor>, c: Cast): Segment {
  switch (x.id) {
    case 'problem':
      return { ...x, hold: 3 };
    case 'note':
      return { ...x, fit: 2 };
    default:
      if (x.id === `panel-${c.a}`) return { ...x, to: plus(A.aPanel, 1300) };
      if (x.id === `panel-${c.b}`) return { ...x, to: plus(A.bPanel, 1300) };
      return x;
  }
}

export function halvesStory(c: Cast, room: string): Story {
  const { a, b } = c;
  const words = WORDS(c, room);
  const A = anchorsFor(c, words);
  const CAPTION = captionsFor(c);
  const TAG = tagsFor(c, words, A);
  const shared = beatsFor(c, words, A);
  // the note in the revised plan: a wider camera, so the row's start isn't cropped
  const BEATS = { ...shared, noteInPlan: { ...shared.noteInPlan, views: { [a]: { zoom: 1.15, find: `Added at ${b}'s request` }, [b]: { anchor: 'bottom' as const } } } };
  const B = BUILD(c);
  const build = `Each Claude builds its half: ${a}'s the store, ${b}'s the API.`;
  const pushed: Tag = { from: a, to: b, sender: `${a}'s Claude`, toLabel: `${b}'s Claude`, label: '"listTasks is pushed to main."', fromFind: B.pushedFromFind, toFind: B.pushedFind, arrive: B.pushed, dur: 1.1 };
  const trailer: Edit = {
    v2: true,
    roomNode: true,
    hookSeconds: 0,
    endSeconds: 4.6,
    endCard: 'full',
    segments: [
      ...storySegments(c, words, A, BEATS).map((x) => tuned(x, A, c)),
      // the split: one task each, a's the store, b's the handler
      {
        id: 'tasks',
        from: plus(B.bTask, -300),
        to: plus(B.bTask, 1500),
        speed: 1,
        dip: true,
        caption: build,
        views: { [a]: { zoom: 1.4, find: B.aTaskFind }, [b]: { zoom: 1.4, find: B.bTaskFind } },
        marks: [
          { pane: a, find: B.aTaskFind, who: a, label: `${a}'s task` },
          { pane: b, find: B.bTaskFind, who: b, label: `${b}'s task` },
        ],
      },
      // a's Claude writes the store and its test (model time); b's sends a subagent to read it
      { id: 'build', from: plus(B.aCodes, -400), to: plus(B.subagent, -300), fit: 2, model: true, dip: true, caption: build, views: { [a]: { zoom: 1.3, find: B.aCodeFind }, [b]: { zoom: 1.3, find: B.bAskFind } } },
      {
        id: 'subagent',
        from: plus(B.subagent, -300),
        to: plus(B.subagent, 1800),
        speed: 1,
        focus: b,
        caption: CAPTION.subagent,
        views: { [a]: { zoom: 1.3, find: B.aCodeFind }, [b]: { zoom: 1.6, anchor: 'bottom' } },
        marks: [{ pane: b, find: '◯ Explore', who: b, label: 'a subagent' }],
      },
      { id: 'build-on', from: plus(B.subagent, 1800), to: plus(B.pushed, -1500), fit: 0.8, model: true, caption: build, views: { [a]: { zoom: 1.3, find: ['Pushed to main', ...B.aCodeFind] }, [b]: { zoom: 1.3, anchor: 'bottom' } } },
      // a's Claude: "pushed"; b's Claude pulls it
      { id: 'pushed', from: plus(B.pushed, -1500), to: plus(B.pushed, 1300), speed: 1, dip: true, caption: CAPTION.posted, views: { [a]: { zoom: 1.35, find: B.pushedFromFind }, [b]: { zoom: 1.35, find: B.pushedFind } }, tags: [pushed] },
      {
        id: 'pulled',
        from: plus(B.bPulls, -300),
        to: plus(B.bPulls, 1500),
        fit: 1.2,
        focus: b,
        caption: CAPTION.posted,
        views: { [b]: { zoom: 1.35, find: B.bPullFind }, [a]: { zoom: 1.3, anchor: 'bottom' } },
        marks: [{ pane: b, find: B.bPullFind, who: b, label: `${b}'s Claude pulls the store` }],
      },
      // b's Claude builds the handler on it (model time), then runs both halves' tests
      { id: 'handler', from: plus(B.bCodes, -400), to: plus(B.bTests, -300), fit: 1.5, model: true, focus: b, caption: build, views: { [b]: { zoom: 1.3, find: B.bCodeFind }, [a]: { zoom: 1.3, anchor: 'bottom' } } },
      {
        id: 'b-testing',
        from: plus(B.bTests, -300),
        to: plus(B.bTested, -100),
        fit: 1.3,
        model: true,
        focus: b,
        caption: CAPTION.posted,
        views: { [b]: { zoom: 1.35, find: B.bTestFind }, [a]: { zoom: 1.3, anchor: 'bottom' } },
        // a short label: the pull-and-test row is narrow
        marks: [{ pane: b, find: B.bTestFind, who: b, label: 'npm test, both halves' }],
      },
      // its report: both halves' tests pass in b's checkout
      {
        id: 'b-tested',
        from: plus(B.bTested, -100),
        to: plus(B.bTested, 1400),
        speed: 1,
        focus: b,
        caption: CAPTION.posted,
        views: { [b]: { zoom: 1.15, find: ['npm test passes 10 of 10', ...B.bTestFind] }, [a]: { zoom: 1.3, anchor: 'bottom' } },
        // no label: it would cover the row's "npm test passes …"
        marks: [{ pane: b, find: B.bTestFind, rows: 2, who: b }],
      },
      { ...BEATS.tests, fit: 2 },
      BEATS.pass,
    ],
  };
  const s = { cast: c, words, A, CAPTION, TAG, BEATS };
  return { ...s, trailer, social: socialEdit(s), readme: readmeEdit(s), native: nativeCuts(c, words, A, B) };
}
