import type { Anchor, Edit, Segment } from '../lib/edl';

/**
 * The v2 trailer (~68 s, STORYBOARD.md): cold open on both test runs passing, the problem, the title, then the
 * story in a split screen that never leaves either person. Every message that crosses between panes flies as a tag
 * in its sender's colour. Anchors are `demo.sh --film`'s beats (open, join, panel, talk, claudes, plan, proposal,
 * answers, revision, agreed, split, build, subagent, handler, tests, pass) or "the moment a pane shows X", so a new
 * take re-times itself; a segment whose anchors a take lacks is skipped with an [edl] warning. Typing plays at
 * up to ~2.5x with no badge; model time is squeezed (`fit`) and marked `model`, which is the only place the speed
 * badge shows.
 */
export const at = (after: string, session: string, text: string | string[], offset = 0): Anchor => ({ after, session, text, offset });
export const plus = (a: Anchor, ms: number): Anchor => (typeof a === 'object' && 'after' in a ? { ...a, offset: (a.offset ?? 0) + ms } : a);

// the story's moments, as each pane shows them
export const A = {
  // S1, S2
  openTyped: at('open', 'alice', '/sub-h', -300),
  opened: at('open', 'alice', 'opened room'),
  joinTyped: at('join', 'bob', '/sub-h', -300),
  joined: at('join', 'bob', "You've joined room"),
  bobJoinLine: at('join', 'bob', ['joined otter', 'sub-human: joined']),
  aliceSeesJoin: at('join', 'alice', 'sub-human: bob joined'),
  alicePanel: at('panel', 'alice', '└ ◯ bob'),
  bobPanel: at('panel', 'bob', '└ ◯ alice'),
  // S3: @room, then bob's Claude asks alice's
  talkTyped: at('talk', 'alice', '@ro', -300),
  talkSent: at('talk', 'alice', '✓ sent'),
  bobGotTalk: at('talk', 'bob', 'alice: bob, can you'),
  askTyped: at('claudes', 'bob', 'ask al', -300),
  askDone: at('claudes', 'bob', 'change nothing', 300),
  aliceGotAsk: at('claudes', 'alice', ['Question from bob', "bob's Claude: "]),
  bobGotAnswer: at('claudes', 'bob', "alice's Claude: "),
  // S4: @claude, the plan
  planTyped: at('plan', 'bob', '@cl', -300),
  planSent: at('plan', 'bob', '✓ sent'),
  aliceSeesPlanAsk: at('plan', 'alice', '(to claude)'),
  planOpen: at('plan', 'alice', 'Ready to code'),
  // S5: bob's note, the revision, both say yes
  noteTyped: at('answers', 'bob', '❯ 3.', -300),
  noteDone: at('answers', 'bob', 'must 400, not 500', 500),
  noteSent: at('answers', 'bob', 'User answered', 600),
  revisedOpen: at('revision', 'alice', 'Ready to code'),
  noteInPlan: at('revision', 'alice', "Added at bob's request"),
  aliceYes: at('revision', 'alice', 'You agreed to the revised'),
  bobYes: at('revision', 'bob', ['You and alice both agreed', 'both agreed']),
  // S6b: the build
  bobTask: at('split', 'bob', ['Tests for GET', 'owner you']),
  aliceCodes: at('build', 'alice', ['Update(src/', 'Write(src/']),
  subagent: at('build', 'bob', '◯ Explore'),
  handlerPushed: at('build', 'bob', ["alice's Claude: The paging handler", "alice's Claude: "]),
  // tests
  aliceRuns: at('tests', 'alice', ['! for shell mode', '! g']),
  bobPass: at('tests', 'bob', 'ℹ tests 11'),
  bobPassAny: at('tests', 'bob', 'ℹ pass'),
};

export const CAPTION = {
  cold: 'Two people. Two Claudes. One plan.',
  problem: 'Pairing usually means one of you gives up your session.',
  open: 'Open a room. Everyone joins from their own terminal.',
  panel: "See who's in the room from your agent panel.",
  talk: '@room: talk to everyone.',
  claudes: "Your Claude can ask theirs. alice isn't interrupted.",
  plan: "Ask the room's Claude for a plan. It opens for both of you.",
  consent: 'Each person approves. No Claude can say yes for you.',
  build: 'Each Claude builds its half, in its own checkout.',
  subagent: "Your Claude's own subagents show up in the panel too.",
  handler: 'Your Claudes keep each other posted.',
  tests: 'Tests pass for both.',
};

// the tags: each one a real message, worded as the receiving pane shows it
export const TAG = {
  talk: { from: 'alice', to: 'bob', sender: 'alice', toLabel: 'bob', label: '"bob, can you take the parser tests?"', fromFind: '@room bob', toFind: 'alice: bob, can you', arrive: A.bobGotTalk, dur: 1.1 },
  ask: { from: 'bob', to: 'alice', sender: "bob's Claude", toLabel: "alice's Claude", label: '"How does createTask pick ids?"', fromFind: 'ask alice', toFind: ['Question from bob', "bob's Claude: "], arrive: A.aliceGotAsk, dur: 1.1 },
  answer: { from: 'alice', to: 'bob', sender: "alice's Claude", toLabel: "bob's Claude", label: '"A counter: 1, 2, 3, in insertion order."', fromFind: ['Answer bob', 'Searched for', 'Question from bob'], toFind: "alice's Claude: ", arrive: A.bobGotAnswer, dur: 1.1 },
  planAsk: { from: 'bob', to: ['claude', 'alice'], sender: 'bob', label: '"@claude let\'s plan cursor paging"', fromFind: '@claude let', toFind: '(to claude)', arrive: A.aliceSeesPlanAsk, dur: 1.2 },
  plan: { from: 'claude', to: ['alice', 'bob'], sender: "the room's Claude", label: '"Plan: cursor paging for GET /tasks"', toFind: ['Plan: cursor paging', 'Ready to code'], arrive: A.planOpen, dur: 1.0 },
  note: { from: 'bob', to: 'claude', sender: 'bob', label: '"No: after=zzz must 400, not 500"', fromFind: 'must 400, not 500', start: 0.05, end: 0.85 },
  revised: { from: 'claude', to: ['alice', 'bob'], sender: "the room's Claude", label: '"Revised plan, with bob\'s test"', toFind: ['Ready to code'], arrive: A.revisedOpen, dur: 1.0 },
  handler: { from: 'alice', to: 'bob', sender: "alice's Claude", toLabel: "bob's Claude", label: '"The handler is pushed. You can pull."', fromFind: ['Pushed the handler', 'telling bob'], toFind: ["alice's Claude: The paging", "alice's Claude: "], arrive: A.handlerPushed, dur: 1.1 },
};

const both = (zoom: number, find: string | string[]) => ({ alice: { zoom, find }, bob: { zoom, find } });

/** The story beats, shared by the trailer and the shorter cuts. */
export const BEATS = {
  cold: { id: 'cold', from: plus(A.bobPass, -500), to: plus(A.bobPass, 2600), speed: 1, caption: CAPTION.cold, views: both(1.3, ['ℹ pass 11', 'ℹ pass']), marks: [{ pane: 'alice', find: 'ℹ tests 11', rows: 3 }, { pane: 'bob', find: 'ℹ tests 11', rows: 3 }] } satisfies Segment,
  askFly: { id: 'ask-fly', from: plus(A.aliceGotAsk, -1100), to: plus(A.aliceGotAsk, 900), speed: 1, caption: CAPTION.claudes, views: { bob: { zoom: 1.5, find: 'ask alice' }, alice: { zoom: 1.5, find: ['Question from bob', "bob's Claude: "] } }, tags: [TAG.ask] } satisfies Segment,
  aliceReads: {
    id: 'alice-reads',
    from: plus(A.aliceGotAsk, 900),
    to: plus(A.bobGotAnswer, -1100),
    fit: 1.5,
    model: true,
    focus: 'alice',
    caption: CAPTION.claudes,
    views: { alice: { zoom: 1.5, find: ['Searched for', 'Question from bob'] }, bob: { zoom: 1.5, find: 'ask alice' } },
    marks: [{ pane: 'alice', find: '❯', exact: true, label: "alice's prompt, untouched" }],
  } satisfies Segment,
  answerFly: { id: 'answer-fly', from: plus(A.bobGotAnswer, -1100), to: plus(A.bobGotAnswer, 1700), speed: 1, caption: CAPTION.claudes, views: { alice: { zoom: 1.5, find: ['Answer bob', 'Searched for'] }, bob: { zoom: 1.5, find: "alice's Claude: " } }, tags: [TAG.answer] } satisfies Segment,
  planOpen: { id: 'plan-open', from: plus(A.planOpen, -300), to: plus(A.planOpen, 2200), speed: 1, caption: CAPTION.plan, views: both(1.3, ['Plan: cursor paging', 'Ready to code']), tags: [TAG.plan] } satisfies Segment,
  noteInPlan: {
    id: 'note-in-plan',
    from: plus(A.noteInPlan, -250),
    to: plus(A.noteInPlan, 1300),
    speed: 1,
    dip: true,
    focus: 'alice',
    caption: CAPTION.consent,
    views: { alice: { zoom: 1.4, find: "Added at bob's request" }, bob: { anchor: 'bottom' } },
    marks: [{ pane: 'alice', find: "Added at bob's request", rows: 2, who: 'bob', label: "bob's note" }],
  } satisfies Segment,
  aliceYes: {
    id: 'alice-yes',
    from: plus(A.aliceYes, -150),
    to: plus(A.aliceYes, 1300),
    speed: 1,
    focus: 'alice',
    caption: CAPTION.consent,
    views: { alice: { zoom: 1.4, find: 'You agreed to the revised' }, bob: { anchor: 'bottom' } },
    marks: [{ pane: 'alice', find: 'You agreed to the revised', who: 'alice', label: 'alice: yes' }],
  } satisfies Segment,
  bobYesing: {
    id: 'bob-yesing',
    from: plus(A.bobYes, -3300),
    to: plus(A.bobYes, -100),
    fit: 0.9,
    model: true,
    focus: 'bob',
    caption: CAPTION.consent,
    views: { bob: { zoom: 1.4, find: ['You and alice both agreed', 'both agreed'] }, alice: { zoom: 1.4, find: 'You agreed to the revised' } },
  } satisfies Segment,
  bobYes: {
    id: 'bob-yes',
    from: plus(A.bobYes, -100),
    to: plus(A.bobYes, 1500),
    speed: 1,
    focus: 'bob',
    caption: CAPTION.consent,
    views: { bob: { zoom: 1.4, find: ['You and alice both agreed', 'both agreed'] }, alice: { zoom: 1.4, find: 'You agreed to the revised' } },
    marks: [
      { pane: 'bob', find: 'You and alice both agreed', who: 'bob', label: 'bob: yes' },
      { pane: 'bob', find: '✔ decided', who: 'bob' },
    ],
  } satisfies Segment,
};

export const trailerEdit: Edit = {
  v2: true,
  roomNode: true,
  hookSeconds: 0,
  endSeconds: 4.6,
  endCard: 'full',
  segments: [
    // 0-3 s: the result first
    BEATS.cold,
    // 3-9 s: the problem, then the title, over two fresh sessions
    { id: 'problem', from: 'open+1000ms', hold: 3.4, dip: true, room: false, drift: 1.05, caption: CAPTION.problem },
    { id: 'title', from: 'open+1000ms', hold: 2.4, room: false, overlay: 'title', caption: '' },
    // a room, bob joins, the panel
    { id: 'open', from: A.openTyped, to: plus(A.opened, 800), fit: 1.7, room: false, focus: 'alice', caption: CAPTION.open, views: { alice: { zoom: 1.3, find: ['opened room', '/sub-human'] } } },
    { id: 'join', from: A.joinTyped, to: plus(A.bobJoinLine, -300), fit: 0.9, focus: 'bob', caption: CAPTION.open, views: { bob: { zoom: 1.3, find: ['/sub-human:sub-human bob', '/sub-human'] }, alice: { zoom: 1.3, find: 'opened room' } } },
    {
      id: 'join-fly',
      from: plus(A.bobJoinLine, -300),
      to: plus(A.aliceSeesJoin, 900),
      speed: 1,
      caption: CAPTION.open,
      views: { bob: { zoom: 1.3, find: ['joined otter', '/sub-human'] }, alice: { zoom: 1.3, find: ['sub-human: bob joined', 'opened room'] } },
      tags: [{ from: 'bob', to: 'alice', sender: 'bob', toLabel: 'alice', label: 'joined the room', fromFind: ['joined otter', '/sub-human'], toFind: 'sub-human: bob joined', arrive: A.aliceSeesJoin, dur: 0.6 }],
    },
    { id: 'panel-alice', from: plus(A.alicePanel, -400), to: plus(A.alicePanel, 1700), speed: 1, dip: true, focus: 'alice', caption: CAPTION.panel, views: { alice: { zoom: 1.6, anchor: 'bottom' } }, marks: [{ pane: 'alice', find: 'otter-', rows: 2 }] },
    { id: 'panel-bob', from: plus(A.bobPanel, -300), to: plus(A.bobPanel, 1600), speed: 1, focus: 'bob', caption: CAPTION.panel, views: { bob: { zoom: 1.6, anchor: 'bottom' }, alice: { anchor: 'bottom' } }, marks: [{ pane: 'bob', find: 'otter-', rows: 2 }] },
    // @room
    { id: 'talk', from: A.talkTyped, to: A.talkSent, fit: 2.4, dip: true, focus: 'alice', caption: CAPTION.talk, views: { alice: { zoom: 1.4, find: '@room bob' } } },
    { id: 'talk-fly', from: A.talkSent, to: plus(A.bobGotTalk, 1100), speed: 1, caption: CAPTION.talk, views: { alice: { zoom: 1.4, find: '@room bob' }, bob: { zoom: 1.4, find: 'alice: bob, can you' } }, tags: [TAG.talk] },
    // Claude asks Claude: the aha
    { id: 'ask', from: A.askTyped, to: A.askDone, fit: 2.4, dip: true, focus: 'bob', caption: CAPTION.claudes, views: { bob: { zoom: 1.5, find: 'ask alice' }, alice: { zoom: 1.5, anchor: 'bottom' } } },
    { id: 'ask-think', from: A.askDone, to: plus(A.aliceGotAsk, -1100), fit: 0.6, model: true, focus: 'bob', caption: CAPTION.claudes, views: { bob: { zoom: 1.5, find: 'ask alice' }, alice: { zoom: 1.5, anchor: 'bottom' } } },
    BEATS.askFly,
    BEATS.aliceReads,
    BEATS.answerFly,
    // the plan, for both
    { id: 'plan', from: A.planTyped, to: A.planSent, fit: 2, dip: true, focus: 'bob', caption: CAPTION.plan, views: { bob: { zoom: 1.35, find: '@claude let' } } },
    { id: 'plan-ask', from: A.planSent, to: plus(A.aliceSeesPlanAsk, 500), speed: 1, caption: CAPTION.plan, views: { bob: { zoom: 1.35, find: '@claude let' }, alice: { zoom: 1.35, find: '(to claude)' } }, tags: [TAG.planAsk] },
    { id: 'plan-think', from: plus(A.aliceSeesPlanAsk, 500), to: plus(A.planOpen, -300), fit: 1.3, model: true, caption: CAPTION.plan },
    BEATS.planOpen,
    // consent, as one beat: bob says no with a note, the revision carries it, both say yes
    { id: 'note', from: A.noteTyped, to: A.noteDone, fit: 2.3, dip: true, focus: 'bob', caption: CAPTION.consent, views: { bob: { zoom: 1.08, find: ['must 400, not 500', 'Tell Claude what to change'] } }, marks: [{ pane: 'bob', find: 'must 400, not 500', who: 'bob', label: "bob's note" }] },
    { id: 'note-sent', from: A.noteDone, to: A.noteSent, fit: 1.2, model: true, focus: 'bob', caption: CAPTION.consent, views: { bob: { zoom: 1.45, find: ['User answered', 'must 400, not 500'] } }, tags: [TAG.note] },
    { id: 'revising', from: A.noteSent, to: plus(A.revisedOpen, -900), fit: 0.8, model: true, caption: CAPTION.consent },
    { id: 'revised', from: plus(A.revisedOpen, -900), to: plus(A.revisedOpen, 800), speed: 1, caption: CAPTION.consent, views: both(1.3, ['Plan: cursor paging', 'Ready to code']), tags: [TAG.revised] },
    BEATS.noteInPlan,
    BEATS.aliceYes,
    BEATS.bobYesing,
    BEATS.bobYes,
    // the build
    { id: 'tasks', from: plus(A.bobTask, -300), to: plus(A.bobTask, 1500), speed: 1, dip: true, focus: 'bob', caption: CAPTION.build, views: { bob: { zoom: 1.4, find: ['Tests for GET', 'owner you'] }, alice: { zoom: 1.4, anchor: 'bottom' } }, marks: [{ pane: 'bob', find: 'Tests for GET', who: 'bob', label: "bob's task" }] },
    { id: 'build', from: plus(A.aliceCodes, -400), to: plus(A.subagent, -300), fit: 1.7, model: true, dip: true, caption: CAPTION.build, views: { alice: { zoom: 1.3, find: ['Update(src/', 'Write(src/'] }, bob: { zoom: 1.3, anchor: 'bottom' } } },
    { id: 'subagent', from: plus(A.subagent, -300), to: plus(A.subagent, 2300), speed: 1, focus: 'bob', caption: CAPTION.subagent, views: { alice: { zoom: 1.3, find: ['+  return', 'function listTasks', 'Update(src/'] }, bob: { zoom: 1.6, anchor: 'bottom' } }, marks: [{ pane: 'bob', find: '◯ Explore', who: 'bob', label: 'a subagent' }] },
    { id: 'handler', from: plus(A.handlerPushed, -1300), to: plus(A.handlerPushed, 1500), speed: 1, dip: true, caption: CAPTION.handler, views: { alice: { zoom: 1.35, find: ['Pushed the handler', 'telling bob'] }, bob: { zoom: 1.35, find: ["alice's Claude: The paging", "alice's Claude: "] } }, tags: [TAG.handler] },
    // one test-pass beat, both side by side
    { id: 'tests', from: plus(A.aliceRuns, -300), to: plus(A.bobPassAny, 300), fit: 2.4, dip: true, caption: CAPTION.tests, views: both(1.25, ['ℹ pass 11', 'ℹ pass', 'npm test']) },
    { id: 'pass', from: plus(A.bobPassAny, 300), to: plus(A.bobPassAny, 1700), speed: 1, caption: CAPTION.tests, views: both(1.25, ['ℹ pass 11', 'ℹ pass']), marks: [{ pane: 'alice', find: 'ℹ tests 11', rows: 3 }, { pane: 'bob', find: 'ℹ tests 11', rows: 3 }] },
  ],
};
