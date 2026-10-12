import type { Edit, Segment } from '../lib/edl';
import type { Cast } from '../cast';
import { any, at, plus, type Anchors, type Words } from './trailer';
import type { BUILD } from './halves';

/**
 * The v3 ("native") cuts of the halves story (take7): take7's beats in the take4 cut's visual language. Real
 * terminal windows side by side, one stage camera that pushes in on the pane that matters (`camera`), plain
 * captions below with an accent eyebrow, a few small callout labels, and the v1 title and end card. No message
 * tags, name plates, per-person colours or boxed marks: a message between Claudes shows as the line it is, in the
 * pane that receives it. Side by side only where both sides matter (the join, the plan opening, both tests passing).
 * Typing plays at up to ~2.5x with no badge; model time is `model`, the only place the speed badge shows.
 */
type Build = ReturnType<typeof BUILD>;

export function nativeCaptions(c: Cast) {
  return {
    open: 'Open a room. Everyone joins from their own terminal.',
    panel: "See who's in the room from your agent panel.",
    talk: '@room: talk to everyone.',
    claudes: `Your Claude can ask theirs. ${c.a} isn't interrupted.`,
    plan: "Ask the room's Claude for a plan. It opens for both of you.",
    consent: 'Each person approves. No Claude can say yes for you.',
    build: `Each Claude builds its half: ${c.a}'s the store, ${c.b}'s the API.`,
    subagent: "Your Claude's own subagents show up in the panel too.",
    posted: 'Your Claudes keep each other posted.',
    tests: 'Tests pass for both.',
  };
}

export function nativeCuts(c: Cast, w: Words, A: Anchors, B: Build): { trailer: Edit; social: Edit; readme: Edit } {
  const { a, b } = c;
  const C = nativeCaptions(c);
  const Z = 2; // the push-in on one pane (v1's)
  const noteRow = `Added at ${b}'s request`;
  const bothYes = [`You and ${a} both agreed`, 'both agreed'];
  const askSent = [`sent to ${a}`, `SendMessage(${a}`];
  const aReadFind = ['Read 1 file', 'Searched for', `Question from ${b}`, `${b}'s Claude: `];
  const answerFind = [`${a}'s Claude replied`, `${a}'s Claude: `];
  /** the ask leaving b's pane (it shows a moment after a's pane has the question) */
  const sentLine = any(at('claudes', b, askSent), plus(A.aGotAsk, 300));

  // the beats every cut shares
  const S = {
    askTyped: { id: 'ask', from: A.askTyped, to: A.askDone, fit: 2.6, eyebrow: 'Claude to Claude', caption: C.claudes, camera: { pane: b, zoom: Z, find: w.askFind } },
    // jess's Claude thinks (model time), then its SendMessage line shows in her pane
    askSent: { id: 'ask-sent', from: A.askDone, to: plus(sentLine, -100), fit: 1, model: true, eyebrow: 'Claude to Claude', caption: C.claudes, camera: { pane: b, zoom: Z, find: [...askSent, w.askFind] } },
    askSentLine: {
      id: 'ask-sent-line',
      from: plus(sentLine, -100),
      to: plus(sentLine, 1300),
      speed: 1,
      eyebrow: 'Claude to Claude',
      caption: C.claudes,
      camera: { pane: b, zoom: Z, find: [...askSent, w.askFind] },
      callouts: [{ pane: b, label: `${b}'s Claude`, find: askSent }],
    },
    aReads: {
      id: `${a}-reads`,
      from: plus(A.aGotAsk, -200),
      to: plus(A.bGotAnswer, -300),
      fit: 2.6,
      model: true,
      eyebrow: 'Claude to Claude',
      caption: C.claudes,
      camera: { pane: a, zoom: Z, find: aReadFind },
      callouts: [{ pane: a, label: `${a}'s Claude`, find: aReadFind }],
    },
    answer: { id: 'answer', from: plus(A.bGotAnswer, -300), to: plus(A.bGotAnswer, 2600), fit: 2.2, eyebrow: 'Claude to Claude', caption: C.claudes, camera: { pane: b, zoom: Z, find: answerFind } },
    planBoth: {
      id: 'plan-both',
      from: plus(A.planOpen, -300),
      to: plus(A.planOpen, 2300),
      speed: 1,
      eyebrow: 'Plan view',
      caption: C.plan,
      camera: { pane: 'both', zoom: 1.04, find: 'Ready to code' },
      callouts: [{ pane: b, label: "the room's Claude", find: "Here is Claude's plan" }],
    },
    noteInPlan: {
      id: 'note-in-plan',
      from: plus(A.noteInPlan, -250),
      to: plus(A.noteInPlan, 1500),
      speed: 0.7,
      eyebrow: 'Consent',
      caption: C.consent,
      camera: { pane: a, zoom: Z, find: noteRow },
      callouts: [{ pane: a, label: `${b}'s note`, find: noteRow }],
    },
    aYes: { id: `${a}-yes`, from: plus(A.aYes, -150), to: plus(A.aYes, 1300), speed: 1, eyebrow: 'Consent', caption: C.consent, camera: { pane: a, zoom: Z, find: 'You agreed to the revised' } },
    bYesing: { id: `${b}-yesing`, from: plus(A.bYes, -3300), to: plus(A.bYes, -100), fit: 0.8, model: true, eyebrow: 'Consent', caption: C.consent, camera: { pane: b, zoom: Z, find: bothYes } },
    bYes: { id: `${b}-yes`, from: plus(A.bYes, -100), to: plus(A.bYes, 1500), speed: 1, eyebrow: 'Consent', caption: C.consent, camera: { pane: b, zoom: Z, find: bothYes } },
    tests: { id: 'tests', from: plus(A.aRuns, -300), to: plus(A.bPassAny, 300), fit: 2.4, eyebrow: 'npm test', caption: C.tests, camera: { pane: 'both', zoom: 1.04, find: [w.passRow, 'npm test'] } },
    pass: {
      id: 'pass',
      from: plus(A.bPassAny, 300),
      to: plus(A.bPassAny, 2200),
      speed: 1,
      eyebrow: 'npm test',
      caption: C.tests,
      camera: { pane: 'both', zoom: 1.04, find: w.passRow },
      callouts: [
        { pane: a, label: `${a}'s run`, find: w.passRow },
        { pane: b, label: `${b}'s run`, find: w.passRow },
      ],
    },
  } satisfies Record<string, Segment>;

  const trailer: Edit = {
    hookSeconds: 3.4,
    hookTeaser: 'plan-both',
    endSeconds: 4.8,
    endCard: 'native',
    segments: [
      // a room, b joins, the panel
      { id: 'open', from: A.openTyped, to: plus(A.opened, 900), fit: 2.2, eyebrow: '/sub-human', caption: C.open, camera: { pane: a, zoom: Z, find: ['opened room', '/sub-human'] } },
      { id: 'join', from: A.joinTyped, to: plus(A.aSeesJoin, 900), fit: 3, eyebrow: '/sub-human', caption: C.open, camera: { pane: 'both' } },
      {
        id: 'panel',
        from: plus(A.aPanel, -400),
        to: plus(A.aPanel, 1700),
        speed: 1,
        eyebrow: 'Agent panel',
        caption: C.panel,
        camera: { pane: a, zoom: Z, find: `└ ◯ ${b}` },
      },
      // @room
      { id: 'talk', from: A.talkTyped, to: A.talkSent, fit: 2.4, eyebrow: '@room', caption: C.talk, camera: { pane: a, zoom: Z, find: [w.talkFind, '✓ sent'] } },
      { id: 'talk-heard', from: plus(A.bGotTalk, -300), to: plus(A.bGotTalk, 1600), speed: 1, eyebrow: '@room', caption: C.talk, camera: { pane: b, zoom: Z, find: w.talkGot } },
      // Claude asks Claude: the aha
      S.askTyped,
      S.askSent,
      S.askSentLine,
      S.aReads,
      S.answer,
      // the plan, for both
      { id: 'plan', from: A.planTyped, to: A.planSent, fit: 2.4, eyebrow: '@claude', caption: C.plan, camera: { pane: b, zoom: Z, find: ['@claude let', '✓ sent'] } },
      { id: 'plan-think', from: A.planSent, to: plus(A.planOpen, -300), fit: 1.5, model: true, eyebrow: '@claude', caption: C.plan, camera: { pane: 'both' } },
      S.planBoth,
      { id: 'plan-zoom', from: plus(A.planOpen, 2300), to: plus(A.planOpen, 4300), speed: 1, eyebrow: 'Plan view', caption: C.plan, camera: { pane: b, zoom: Z, find: ['Plan: cursor paging', 'Ready to code'] } },
      // consent, as one beat: b's note, the revision carries it, both say yes
      { id: 'note', from: A.noteTyped, to: A.noteDone, fit: 2.5, eyebrow: 'Consent', caption: C.consent, camera: { pane: b, zoom: Z, find: [w.note, 'Tell Claude what to change'] } },
      { id: 'revising', from: A.noteDone, to: plus(A.noteInPlan, -250), fit: 1.5, model: true, eyebrow: 'Consent', caption: C.consent, camera: { pane: 'both' } },
      S.noteInPlan,
      S.aYes,
      S.bYesing,
      S.bYes,
      // the build: one task each
      { id: 'tasks', from: plus(B.bTask, -300), to: plus(B.bTask, 1500), speed: 1, eyebrow: 'Build', caption: C.build, camera: { pane: b, zoom: Z, find: B.bTaskFind } },
      {
        id: 'build',
        from: plus(B.aCodes, -400),
        to: plus(B.subagent, -300),
        fit: 2.2,
        model: true,
        eyebrow: 'Build',
        caption: C.build,
        camera: { pane: a, zoom: Z, find: B.aCodeFind },
        callouts: [{ pane: a, label: `${a}'s Claude`, find: B.aCodeFind }],
      },
      {
        id: 'subagent',
        from: plus(B.subagent, -300),
        to: plus(B.subagent, 2000),
        speed: 1,
        eyebrow: 'Agent panel',
        caption: C.subagent,
        camera: { pane: b, zoom: Z, find: '◯ Explore' },
        callouts: [{ pane: b, label: 'a subagent', find: '◯ Explore' }],
      },
      // the camera stays with b while a's Claude finishes: the next thing to see lands in b's pane
      { id: 'build-on', from: plus(B.subagent, 2000), to: plus(B.pushed, -500), fit: 1.2, model: true, eyebrow: 'Build', caption: C.build, camera: { pane: b, zoom: Z, find: B.pushedFind } },
      // a's Claude tells b's: the line arrives in b's pane
      { id: 'pushed', from: plus(B.pushed, -500), to: plus(B.pushed, 2000), speed: 1, eyebrow: 'Claude to Claude', caption: C.posted, camera: { pane: b, zoom: Z, find: B.pushedFind } },
      {
        id: 'pulled',
        from: plus(B.bPulls, -300),
        to: plus(B.bPulls, 1500),
        fit: 1.2,
        eyebrow: 'Claude to Claude',
        caption: C.posted,
        camera: { pane: b, zoom: Z, find: B.bPullFind },
        callouts: [{ pane: b, label: `${b}'s Claude`, find: B.bPullFind }],
      },
      { id: 'handler', from: plus(B.bCodes, -400), to: plus(B.bTests, -300), fit: 1.4, model: true, eyebrow: 'Build', caption: C.posted, camera: { pane: b, zoom: Z, find: B.bCodeFind } },
      { id: 'b-tests', from: plus(B.bTests, -300), to: plus(B.bTested, 1400), fit: 2.2, model: true, eyebrow: 'npm test', caption: C.posted, camera: { pane: b, zoom: Z, find: ['npm test passes 10 of 10', ...B.bTestFind] } },
      // one tests-pass beat, side by side
      S.tests,
      S.pass,
    ],
  };

  const asks = 'Your Claude can ask theirs.';
  const plan = 'Plan together. Each person approves.';
  const social: Edit = {
    hookSeconds: 0,
    endSeconds: 3.3,
    endCard: 'native-short',
    segments: [
      { ...S.pass, id: 'cold', from: plus(A.bPassAny, -300), to: plus(A.bPassAny, 1700), eyebrow: undefined, caption: 'Two people. Two Claudes. One plan.' },
      { ...S.askSent, from: plus(A.askDone, -900), fit: 1, eyebrow: undefined, caption: asks },
      { ...S.askSentLine, to: plus(sentLine, 900), eyebrow: undefined, caption: asks },
      { ...S.aReads, fit: 1.2, eyebrow: undefined, caption: asks },
      { ...S.answer, to: plus(A.bGotAnswer, 1400), fit: 1, eyebrow: undefined, caption: asks },
      { ...S.planBoth, from: plus(A.planOpen, -600), to: plus(A.planOpen, 1200), eyebrow: undefined, caption: plan },
      { ...S.noteInPlan, from: plus(A.noteInPlan, -100), to: plus(A.noteInPlan, 900), speed: 1, eyebrow: undefined, caption: plan },
      { ...S.aYes, to: plus(A.aYes, 900), eyebrow: undefined, caption: plan },
      { ...S.bYes, to: plus(A.bYes, 1000), eyebrow: undefined, caption: plan },
    ],
  };

  // the README loop: b's Claude asks a's, a's reads the code, the answer lands in b's pane
  const readme: Edit = {
    hookSeconds: 0,
    endSeconds: 0,
    loop: true,
    stage: 'side',
    segments: [
      { ...S.askTyped, from: plus(A.askDone, -1500), speed: 1, fit: undefined },
      { ...S.askSent, fit: 0.7 },
      S.askSentLine,
      { ...S.aReads, fit: 1.8 },
      { ...S.answer, to: plus(A.bGotAnswer, 3000), fit: 2.4 },
    ],
  };
  return { trailer, social, readme };
}
