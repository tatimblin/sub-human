import type { Anchor, Edit, Segment, Tag } from '../lib/edl';
import type { Cast } from '../cast';

/**
 * The v2 trailer (~68 s, STORYBOARD.md): cold open on both test runs passing, the problem, the title, then the
 * story in a split screen that never leaves either person. Every message that crosses between panes flies as a tag
 * in its sender's colour. Anchors are `demo.sh --film`'s beats (open, join, panel, talk, claudes, plan, proposal,
 * answers, revision, agreed, split, build, subagent, handler, tests, pass) or "the moment a pane shows X", so a new
 * take re-times itself; a segment whose anchors a take lacks is skipped with an [edl] warning. Typing plays at
 * up to ~2.5x with no badge; model time is squeezed (`fit`) and marked `model`, which is the only place the speed
 * badge shows.
 *
 * Everything here is built from a take's cast (`a` opens the room, `b` joins; src/cast.ts), so the names in
 * captions, tags, marks and anchors follow the take. src/takes.ts picks the cast and the story per take: this
 * file's build (a's Claude the handler, b's the tests; take4, take5) or halves.ts's (both write code; take6).
 */
export const at = (after: Anchor, session: string, text: string | string[], offset = 0): Anchor => ({ after, session, text, offset });
/** `a` moved by ms (each alternative of an `any`; a bare beat becomes `{ beat, offset }`). */
export const plus = (a: Anchor, ms: number): Anchor => {
  if (typeof a === 'string') return { beat: a, offset: ms };
  if ('any' in a) return { any: a.any.map((x) => plus(x, ms)) };
  if ('after' in a || 'beat' in a) return { ...a, offset: (a.offset ?? 0) + ms };
  return { t: a.t + ms };
};
/** The first of several anchors the take has: a text anchor first, then a beat (or a looser text) as the fallback. */
export const any = (...xs: Anchor[]): Anchor => ({ any: xs });

/** The S1–S5 wording each pane shows, beyond the names. The defaults are take5's (demo.sh's own prompts). */
export type Words = {
  /** the room name's word ("otter" of otter-6031), from the capture's meta */
  room: string;
  /** a's @room line as b's pane shows it, and as a typed it */
  talkGot: string;
  talkFind: string;
  talkLabel: string;
  /** b's ask: typed (a prefix), the row to find, and the text that ends it */
  askTyped: string;
  askFind: string;
  askDone: string;
  askLabel: string;
  answerLabel: string;
  /** b's note on the plan */
  note: string;
  noteLabel: string;
  /** node --test's summary rows */
  testsRow: string;
  passRow: string;
};

export const wordsFor = (c: Cast, room: string): Words => ({
  room,
  talkGot: `${c.a}: ${c.b}, can you`,
  talkFind: `@room ${c.b}`,
  talkLabel: `"${c.b}, can you take the parser tests?"`,
  askTyped: `ask ${c.a.slice(0, 2)}`,
  askFind: `ask ${c.a}`,
  askDone: 'change nothing',
  askLabel: '"How does createTask pick ids?"',
  answerLabel: '"A counter: 1, 2, 3, in insertion order."',
  note: 'must 400, not 500',
  noteLabel: '"No: after=zzz must 400, not 500"',
  testsRow: 'ℹ tests 11',
  passRow: 'ℹ pass 11',
});

/** The story's moments up to the agreement (and the people's own test runs), as each pane shows them. */
export function anchorsFor(c: Cast, w: Words) {
  const { a, b } = c;
  return {
    // S1, S2
    openTyped: at('open', a, '/sub-h', -300),
    opened: at('open', a, 'opened room'),
    joinTyped: at('join', b, '/sub-h', -300),
    joined: at('join', b, "You've joined room"),
    bJoinLine: at('join', b, [`joined ${w.room}`, 'sub-human: joined']),
    aSeesJoin: at('join', a, `sub-human: ${b} joined`),
    aPanel: at('panel', a, `└ ◯ ${b}`),
    bPanel: at('panel', b, `└ ◯ ${a}`),
    // S3: @room, then b's Claude asks a's
    talkTyped: at('talk', a, '@ro', -300),
    talkSent: at('talk', a, '✓ sent'),
    bGotTalk: at('talk', b, w.talkGot),
    askTyped: at('claudes', b, w.askTyped, -300),
    askDone: at('claudes', b, w.askDone, 300),
    aGotAsk: at('claudes', a, [`Question from ${b}`, `${b}'s Claude: `]),
    bGotAnswer: at('claudes', b, `${a}'s Claude: `),
    // S4: @claude, the plan
    planTyped: at('plan', b, '@cl', -300),
    planSent: at('plan', b, '✓ sent'),
    aSeesPlanAsk: at('plan', a, '(to claude)'),
    planOpen: at('plan', a, 'Ready to code'),
    // S5: b's note, the revision, both say yes
    noteTyped: at('answers', b, '❯ 3.', -300),
    noteDone: at('answers', b, w.note, 500),
    noteSent: at('answers', b, 'User answered', 600),
    revisedOpen: at('revision', a, 'Ready to code'),
    noteInPlan: at('revision', a, `Added at ${b}'s request`),
    aYes: at('revision', a, 'You agreed to the revised'),
    bYes: at('revision', b, [`You and ${a} both agreed`, 'both agreed']),
    // the tests both people run at the end
    aRuns: at('tests', a, ['! for shell mode', '! g']),
    bPass: at('tests', b, w.testsRow),
    bPassAny: at('tests', b, 'ℹ pass'),
  };
}
export type Anchors = ReturnType<typeof anchorsFor>;

export const captionsFor = (c: Cast) => ({
  cold: 'Two people. Two Claudes. One plan.',
  problem: 'Pairing usually means one of you gives up your session.',
  open: 'Open a room. Everyone joins from their own terminal.',
  panel: "See who's in the room from your agent panel.",
  talk: '@room: talk to everyone.',
  claudes: `Your Claude can ask theirs. ${c.a} isn't interrupted.`,
  plan: "Ask the room's Claude for a plan. It opens for both of you.",
  consent: 'Each person approves. No Claude can say yes for you.',
  subagent: "Your Claude's own subagents show up in the panel too.",
  posted: 'Your Claudes keep each other posted.',
  tests: 'Tests pass for both.',
});

// the tags: each one a real message, worded as the receiving pane shows it
export function tagsFor(c: Cast, w: Words, A: Anchors) {
  const { a, b } = c;
  return {
    talk: { from: a, to: b, sender: a, toLabel: b, label: w.talkLabel, fromFind: w.talkFind, toFind: w.talkGot, arrive: A.bGotTalk, dur: 1.1 },
    ask: { from: b, to: a, sender: `${b}'s Claude`, toLabel: `${a}'s Claude`, label: w.askLabel, fromFind: w.askFind, toFind: [`Question from ${b}`, `${b}'s Claude: `], arrive: A.aGotAsk, dur: 1.1 },
    answer: { from: a, to: b, sender: `${a}'s Claude`, toLabel: `${b}'s Claude`, label: w.answerLabel, fromFind: [`Answer ${b}`, 'Searched for', 'Read 1 file', `Question from ${b}`], toFind: `${a}'s Claude: `, arrive: A.bGotAnswer, dur: 1.1 },
    planAsk: { from: b, to: ['claude', a], sender: b, label: '"@claude let\'s plan cursor paging"', fromFind: '@claude let', toFind: '(to claude)', arrive: A.aSeesPlanAsk, dur: 1.2 },
    plan: { from: 'claude', to: [a, b], sender: "the room's Claude", label: '"Plan: cursor paging for GET /tasks"', toFind: ['Plan: cursor paging', 'Ready to code'], arrive: A.planOpen, dur: 1.0 },
    note: { from: b, to: 'claude', sender: b, label: w.noteLabel, fromFind: w.note, start: 0.05, end: 0.85 },
    revised: { from: 'claude', to: [a, b], sender: "the room's Claude", label: `"Revised plan, with ${b}'s test"`, toFind: ['Ready to code'], arrive: A.revisedOpen, dur: 1.0 },
  } satisfies Record<string, Tag>;
}

/** Both panes' cameras at one zoom, each centred on the first of `find` it shows. */
export const both = (c: Cast, zoom: number, find: string | string[]) => ({ [c.a]: { zoom, find }, [c.b]: { zoom, find } });

/** The story beats, shared by the trailer and the shorter cuts. */
export function beatsFor(c: Cast, w: Words, A: Anchors) {
  const { a, b } = c;
  const CAPTION = captionsFor(c);
  const TAG = tagsFor(c, w, A);
  return {
    cold: { id: 'cold', from: plus(A.bPass, -500), to: plus(A.bPass, 2600), speed: 1, caption: CAPTION.cold, views: both(c, 1.3, [w.passRow, 'ℹ pass']), marks: [{ pane: a, find: w.testsRow, rows: 3 }, { pane: b, find: w.testsRow, rows: 3 }] } satisfies Segment,
    askFly: { id: 'ask-fly', from: plus(A.aGotAsk, -1100), to: plus(A.aGotAsk, 900), speed: 1, caption: CAPTION.claudes, views: { [b]: { zoom: 1.5, find: w.askFind }, [a]: { zoom: 1.5, find: [`Question from ${b}`, `${b}'s Claude: `] } }, tags: [TAG.ask] } satisfies Segment,
    aReads: {
      id: `${a}-reads`,
      from: plus(A.aGotAsk, 900),
      to: plus(A.bGotAnswer, -1100),
      fit: 1.5,
      model: true,
      focus: a,
      caption: CAPTION.claudes,
      views: { [a]: { zoom: 1.5, find: ['Searched for', 'Read 1 file', 'Reading 1 file', `Question from ${b}`] }, [b]: { zoom: 1.5, find: w.askFind } },
      marks: [{ pane: a, find: '❯', exact: true, label: `${a}'s prompt, untouched` }],
    } satisfies Segment,
    answerFly: { id: 'answer-fly', from: plus(A.bGotAnswer, -1100), to: plus(A.bGotAnswer, 1700), speed: 1, caption: CAPTION.claudes, views: { [a]: { zoom: 1.5, find: [`Answer ${b}`, 'Searched for', 'Read 1 file'] }, [b]: { zoom: 1.5, find: `${a}'s Claude: ` } }, tags: [TAG.answer] } satisfies Segment,
    planOpen: { id: 'plan-open', from: plus(A.planOpen, -300), to: plus(A.planOpen, 2200), speed: 1, caption: CAPTION.plan, views: both(c, 1.3, ['Plan: cursor paging', 'Ready to code']), tags: [TAG.plan] } satisfies Segment,
    noteInPlan: {
      id: 'note-in-plan',
      from: plus(A.noteInPlan, -250),
      to: plus(A.noteInPlan, 1300),
      speed: 1,
      dip: true,
      focus: a,
      caption: CAPTION.consent,
      views: { [a]: { zoom: 1.4, find: `Added at ${b}'s request` }, [b]: { anchor: 'bottom' } },
      marks: [{ pane: a, find: `Added at ${b}'s request`, rows: 2, who: b, label: `${b}'s note` }],
    } satisfies Segment,
    aYes: {
      id: `${a}-yes`,
      from: plus(A.aYes, -150),
      to: plus(A.aYes, 1300),
      speed: 1,
      focus: a,
      caption: CAPTION.consent,
      views: { [a]: { zoom: 1.4, find: 'You agreed to the revised' }, [b]: { anchor: 'bottom' } },
      marks: [{ pane: a, find: 'You agreed to the revised', who: a, label: `${a}: yes` }],
    } satisfies Segment,
    bYesing: {
      id: `${b}-yesing`,
      from: plus(A.bYes, -3300),
      to: plus(A.bYes, -100),
      fit: 0.9,
      model: true,
      focus: b,
      caption: CAPTION.consent,
      views: { [b]: { zoom: 1.4, find: [`You and ${a} both agreed`, 'both agreed'] }, [a]: { zoom: 1.4, find: 'You agreed to the revised' } },
    } satisfies Segment,
    bYes: {
      id: `${b}-yes`,
      from: plus(A.bYes, -100),
      to: plus(A.bYes, 1500),
      speed: 1,
      focus: b,
      caption: CAPTION.consent,
      views: { [b]: { zoom: 1.4, find: [`You and ${a} both agreed`, 'both agreed'] }, [a]: { zoom: 1.4, find: 'You agreed to the revised' } },
      marks: [
        { pane: b, find: `You and ${a} both agreed`, who: b, label: `${b}: yes` },
        { pane: b, find: '✔ decided', who: b },
      ],
    } satisfies Segment,
    /** one test-pass beat, both side by side */
    tests: { id: 'tests', from: plus(A.aRuns, -300), to: plus(A.bPassAny, 300), fit: 2.4, dip: true, caption: CAPTION.tests, views: both(c, 1.25, [w.passRow, 'ℹ pass', 'npm test']) } satisfies Segment,
    pass: { id: 'pass', from: plus(A.bPassAny, 300), to: plus(A.bPassAny, 1700), speed: 1, caption: CAPTION.tests, views: both(c, 1.25, [w.passRow, 'ℹ pass']), marks: [{ pane: a, find: w.testsRow, rows: 3 }, { pane: b, find: w.testsRow, rows: 3 }] } satisfies Segment,
  };
}
export type Beats = ReturnType<typeof beatsFor>;

/** A take's story: its cast, wording, anchors, captions, tags and beats, and its three v2 cuts. */
export type Story = {
  cast: Cast;
  words: Words;
  A: Anchors;
  CAPTION: ReturnType<typeof captionsFor>;
  TAG: ReturnType<typeof tagsFor>;
  BEATS: Beats;
  trailer: Edit;
  social: Edit;
  readme: Edit;
  /** the v3 ("native") cuts, where the story has them (halves.ts, take7): edits/native.ts */
  native?: { trailer: Edit; social: Edit; readme: Edit };
};

/** The trailer from the cold open to both people's yes (every story shares it); the build is each story's own. */
export function storySegments(c: Cast, w: Words, A: Anchors, BEATS: Beats): Segment[] {
  const { a, b } = c;
  const CAPTION = captionsFor(c);
  const TAG = tagsFor(c, w, A);
  return [
    // 0-3 s: the result first
    BEATS.cold,
    // 3-9 s: the problem, then the title, over two fresh sessions
    { id: 'problem', from: 'open+1000ms', hold: 3.4, dip: true, room: false, drift: 1.05, caption: CAPTION.problem },
    { id: 'title', from: 'open+1000ms', hold: 2.4, room: false, overlay: 'title', caption: '' },
    // a room, b joins, the panel
    { id: 'open', from: A.openTyped, to: plus(A.opened, 800), fit: 1.7, room: false, focus: a, caption: CAPTION.open, views: { [a]: { zoom: 1.3, find: ['opened room', '/sub-human'] } } },
    { id: 'join', from: A.joinTyped, to: plus(A.bJoinLine, -300), fit: 0.9, focus: b, caption: CAPTION.open, views: { [b]: { zoom: 1.3, find: [`/sub-human:sub-human ${b}`, '/sub-human'] }, [a]: { zoom: 1.3, find: 'opened room' } } },
    {
      id: 'join-fly',
      from: plus(A.bJoinLine, -300),
      to: plus(A.aSeesJoin, 900),
      speed: 1,
      caption: CAPTION.open,
      views: { [b]: { zoom: 1.3, find: [`joined ${w.room}`, '/sub-human'] }, [a]: { zoom: 1.3, find: [`sub-human: ${b} joined`, 'opened room'] } },
      tags: [{ from: b, to: a, sender: b, toLabel: a, label: 'joined the room', fromFind: [`joined ${w.room}`, '/sub-human'], toFind: `sub-human: ${b} joined`, arrive: A.aSeesJoin, dur: 0.6 }],
    },
    { id: `panel-${a}`, from: plus(A.aPanel, -400), to: plus(A.aPanel, 1700), speed: 1, dip: true, focus: a, caption: CAPTION.panel, views: { [a]: { zoom: 1.6, anchor: 'bottom' } }, marks: [{ pane: a, find: `${w.room}-`, rows: 2 }] },
    { id: `panel-${b}`, from: plus(A.bPanel, -300), to: plus(A.bPanel, 1600), speed: 1, focus: b, caption: CAPTION.panel, views: { [b]: { zoom: 1.6, anchor: 'bottom' }, [a]: { anchor: 'bottom' } }, marks: [{ pane: b, find: `${w.room}-`, rows: 2 }] },
    // @room
    { id: 'talk', from: A.talkTyped, to: A.talkSent, fit: 2.4, dip: true, focus: a, caption: CAPTION.talk, views: { [a]: { zoom: 1.4, find: w.talkFind } } },
    { id: 'talk-fly', from: A.talkSent, to: plus(A.bGotTalk, 1100), speed: 1, caption: CAPTION.talk, views: { [a]: { zoom: 1.4, find: w.talkFind }, [b]: { zoom: 1.4, find: w.talkGot } }, tags: [TAG.talk] },
    // Claude asks Claude: the aha
    { id: 'ask', from: A.askTyped, to: A.askDone, fit: 2.4, dip: true, focus: b, caption: CAPTION.claudes, views: { [b]: { zoom: 1.5, find: w.askFind }, [a]: { zoom: 1.5, anchor: 'bottom' } } },
    { id: 'ask-think', from: A.askDone, to: plus(A.aGotAsk, -1100), fit: 0.6, model: true, focus: b, caption: CAPTION.claudes, views: { [b]: { zoom: 1.5, find: w.askFind }, [a]: { zoom: 1.5, anchor: 'bottom' } } },
    BEATS.askFly,
    BEATS.aReads,
    BEATS.answerFly,
    // the plan, for both
    { id: 'plan', from: A.planTyped, to: A.planSent, fit: 2, dip: true, focus: b, caption: CAPTION.plan, views: { [b]: { zoom: 1.35, find: '@claude let' } } },
    { id: 'plan-ask', from: A.planSent, to: plus(A.aSeesPlanAsk, 500), speed: 1, caption: CAPTION.plan, views: { [b]: { zoom: 1.35, find: '@claude let' }, [a]: { zoom: 1.35, find: '(to claude)' } }, tags: [TAG.planAsk] },
    { id: 'plan-think', from: plus(A.aSeesPlanAsk, 500), to: plus(A.planOpen, -300), fit: 1.3, model: true, caption: CAPTION.plan },
    BEATS.planOpen,
    // consent, as one beat: b says no with a note, the revision carries it, both say yes
    { id: 'note', from: A.noteTyped, to: A.noteDone, fit: 2.3, dip: true, focus: b, caption: CAPTION.consent, views: { [b]: { zoom: 1.08, find: [w.note, 'Tell Claude what to change'] } }, marks: [{ pane: b, find: w.note, who: b, label: `${b}'s note` }] },
    { id: 'note-sent', from: A.noteDone, to: A.noteSent, fit: 1.2, model: true, focus: b, caption: CAPTION.consent, views: { [b]: { zoom: 1.45, find: ['User answered', w.note] } }, tags: [TAG.note] },
    { id: 'revising', from: A.noteSent, to: plus(A.revisedOpen, -900), fit: 0.8, model: true, caption: CAPTION.consent },
    { id: 'revised', from: plus(A.revisedOpen, -900), to: plus(A.revisedOpen, 800), speed: 1, caption: CAPTION.consent, views: both(c, 1.3, ['Plan: cursor paging', 'Ready to code']), tags: [TAG.revised] },
    BEATS.noteInPlan,
    BEATS.aYes,
    BEATS.bYesing,
    BEATS.bYes,
  ];
}

/** The 15 s social cut, about 4 s a beat: the green split, Claude asks Claude, the plan and both yeses, then the install line. */
export function socialEdit(s: Pick<Story, 'A' | 'BEATS' | 'TAG'>): Edit {
  const { A, BEATS, TAG } = s;
  const asks = 'Your Claude can ask theirs.';
  const plan = 'Plan together. Each person approves.';
  return {
    v2: true,
    roomNode: true,
    hookSeconds: 0,
    endSeconds: 3.3,
    endCard: 'short',
    segments: [
      { ...BEATS.cold, from: plus(A.bPass, -300), to: plus(A.bPass, 2100) },
      { ...BEATS.askFly, dip: true, caption: asks, from: plus(A.aGotAsk, -1000), to: plus(A.aGotAsk, 500) },
      { ...BEATS.aReads, caption: asks, fit: 0.6, marks: [] },
      { ...BEATS.answerFly, caption: asks, from: plus(A.bGotAnswer, -1100), to: plus(A.bGotAnswer, 500) },
      { ...BEATS.planOpen, dip: true, caption: plan, from: plus(A.planOpen, -900), to: plus(A.planOpen, 700), tags: [TAG.plan] },
      { ...BEATS.noteInPlan, caption: plan, from: plus(A.noteInPlan, 1050), to: plus(A.noteInPlan, 2100) },
      { ...BEATS.aYes, caption: plan, to: plus(A.aYes, 800) },
      { ...BEATS.bYes, caption: plan, to: plus(A.bYes, 1200) },
    ],
  };
}

/**
 * The README loop (~8 s): b's Claude asks a's and the answer comes back, in the split, with name plates and the
 * message tags only (no captions, no room plate). It fades at both ends, so it loops.
 */
export function readmeEdit(s: Pick<Story, 'cast' | 'words' | 'A' | 'BEATS'>): Edit {
  const { cast: c, words: w, A, BEATS } = s;
  return {
    v2: true,
    roomNode: false,
    captions: false,
    hookSeconds: 0,
    endSeconds: 0,
    segments: [
      { id: 'ask', from: plus(A.askDone, -1800), to: A.askDone, speed: 1, focus: c.b, caption: '', views: { [c.b]: { zoom: 1.35, find: w.askFind }, [c.a]: { zoom: 1.35, anchor: 'bottom' } } },
      { id: 'ask-think', from: A.askDone, to: plus(A.aGotAsk, -1100), fit: 0.5, model: true, focus: c.b, caption: '', views: { [c.b]: { zoom: 1.35, find: w.askFind } } },
      { ...BEATS.askFly, caption: '' },
      { ...BEATS.aReads, caption: '', fit: 1.2 },
      { ...BEATS.answerFly, caption: '', to: plus(A.bGotAnswer, 2200) },
    ],
  };
}

/**
 * The take4/take5 story: a's Claude writes the handler and b's Claude the tests (after an Explore subagent of its
 * own reads the code), a's Claude tells b's when the handler is pushed, and both people run npm test.
 */
export function testsStory(c: Cast, room: string): Story {
  const { a, b } = c;
  const words = wordsFor(c, room);
  const A = anchorsFor(c, words);
  const CAPTION = captionsFor(c);
  const TAG = tagsFor(c, words, A);
  const BEATS = beatsFor(c, words, A);
  const B = {
    bTask: at('split', b, ['Tests for GET', 'owner you']),
    aCodes: at('build', a, ['Update(src/', 'Write(src/']),
    subagent: at('build', b, '◯ Explore'),
    handlerPushed: at('build', b, [`${a}'s Claude: The paging handler`, `${a}'s Claude: `]),
  };
  const handler: Tag = { from: a, to: b, sender: `${a}'s Claude`, toLabel: `${b}'s Claude`, label: '"The handler is pushed. You can pull."', fromFind: ['Pushed the handler', `telling ${b}`], toFind: [`${a}'s Claude: The paging`, `${a}'s Claude: `], arrive: B.handlerPushed, dur: 1.1 };
  const build = 'Each Claude builds its half, in its own checkout.';
  const trailer: Edit = {
    v2: true,
    roomNode: true,
    hookSeconds: 0,
    endSeconds: 4.6,
    endCard: 'full',
    segments: [
      ...storySegments(c, words, A, BEATS),
      // the build
      { id: 'tasks', from: plus(B.bTask, -300), to: plus(B.bTask, 1500), speed: 1, dip: true, focus: b, caption: build, views: { [b]: { zoom: 1.4, find: ['Tests for GET', 'owner you'] }, [a]: { zoom: 1.4, anchor: 'bottom' } }, marks: [{ pane: b, find: 'Tests for GET', who: b, label: `${b}'s task` }] },
      { id: 'build', from: plus(B.aCodes, -400), to: plus(B.subagent, -300), fit: 1.7, model: true, dip: true, caption: build, views: { [a]: { zoom: 1.3, find: ['Update(src/', 'Write(src/'] }, [b]: { zoom: 1.3, anchor: 'bottom' } } },
      { id: 'subagent', from: plus(B.subagent, -300), to: plus(B.subagent, 2300), speed: 1, focus: b, caption: CAPTION.subagent, views: { [a]: { zoom: 1.3, find: ['+  return', 'function listTasks', 'Update(src/'] }, [b]: { zoom: 1.6, anchor: 'bottom' } }, marks: [{ pane: b, find: '◯ Explore', who: b, label: 'a subagent' }] },
      { id: 'handler', from: plus(B.handlerPushed, -1300), to: plus(B.handlerPushed, 1500), speed: 1, dip: true, caption: CAPTION.posted, views: { [a]: { zoom: 1.35, find: ['Pushed the handler', `telling ${b}`] }, [b]: { zoom: 1.35, find: [`${a}'s Claude: The paging`, `${a}'s Claude: `] } }, tags: [handler] },
      BEATS.tests,
      BEATS.pass,
    ],
  };
  const s = { cast: c, words, A, CAPTION, TAG, BEATS };
  return { ...s, trailer, social: socialEdit(s), readme: readmeEdit(s) };
}
