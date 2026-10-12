import type { Anchor, Edit } from '../../lib/edl';

/**
 * The ~70 s trailer's cut. Anchors are the marker beats `scripts/demo.sh --film` writes (open, join, talk, reply,
 * claudes, plan, proposal, answers, revision, agreed, split, build, claimed, handler, tested, tests, pass) or "the
 * moment a pane shows X", so a new take re-times itself. People's moments (typing, a plan opening, a note, a yes,
 * passing tests) play at or near 1× (typing at up to ~2×); model time is squeezed with `fit` and gets the speed
 * badge. Segments whose anchors a take lacks are skipped with a warning (see the [cut] line
 * `npx remotion compositions --log=verbose` prints). Screen texts follow demo.sh's own waits and Claude Code's own
 * lines, so they hold on a real take.
 */
const at = (after: string, session: string, text: string | string[], offset = 0): Anchor => ({ after, session, text, offset });

// S1, S2: alice opens the room, bob joins
export const OPEN_TYPED = at('open', 'alice', '/sub-h', -400);
export const OPEN_TYPED_DONE = at('open', 'alice', '/sub-human alice', 500);
export const OPEN_DONE = at('open', 'alice', "You've joined room", 1300);
export const JOIN_TYPED = at('join', 'bob', '/sub-h', -400);
export const JOIN_DONE = at('join', 'bob', "You've joined room", 1100);
// S3: @room, then bob's Claude asks alice's
export const TALK_TYPED = at('talk', 'alice', '@ro', -300);
export const TALK_SENT = at('talk', 'alice', '✓ sent', 500);
export const BOB_GOT_TALK = at('talk', 'bob', 'alice: bob, can you take the parser tests', -300);
export const BOB_READ_TALK = at('talk', 'bob', 'alice: bob, can you take the parser tests', 1900);
export const ASK_TYPED = at('claudes', 'bob', 'ask al', -500);
export const ASK_TYPED_DONE = at('claudes', 'bob', 'change nothing', 400);
export const ASK_SENT = at('claudes', 'bob', ['sent to alice', 'SendMessage(alice'], 2000);
export const ALICE_GOT_ASK = at('claudes', 'alice', ["Question from bob's Claude", "bob's Claude: ", 'Message from @bob.'], -200);
export const BOB_GOT_ANSWER = at('claudes', 'bob', ["alice's Claude: ", 'Message from @alice.']);
export const ANSWER_READ = at('claudes', 'bob', ["Alice's Claude answered", "alice's Claude answered"], 1700);
// S4: @claude, the plan
export const PLAN_TYPED = at('plan', 'bob', '@cl', -300);
export const PLAN_SENT = at('plan', 'bob', '✓ sent', 400);
export const ALICE_GOT_PLAN = at('plan', 'alice', ['(to claude)', '@claude'], 600);
// S5: alice says yes, bob says no with a note, the revision, both agree
export const ALICE_YES = at('answers', 'alice', ['You approved', '✓ agreed'], 1300);
export const NOTE_TYPED = at('answers', 'bob', '❯ 3.', -700);
export const NOTE_SENT = at('answers', 'bob', 'must 400, not 500', 900);
export const CARD = at('answers', 'bob', '☐ Consent', -150);
export const CARD_GONE = at('answers', 'bob', ['User answered Claude', 'I sent your change request'], -60);
// alice pages through the revised plan: her screen holds bob's note only briefly, so that moment plays slowed down
export const REVISED_NOTE = at('revision', 'alice', 'bob asked:', -50);
export const REVISED_NOTE_READ = at('revision', 'alice', 'bob asked:', 360);
export const ALICE_AGREED = at('revision', 'alice', 'You approved the revised', 1500);
export const BOB_AGREED = at('revision', 'bob', ["You've agreed", 'You agreed'], 1300);
// S6b: the build
export const BOB_GETS_TASK = at('split', 'bob', ['task "paging tests', 'is now yours'], -600);
export const BOB_HAS_TASK = at('split', 'bob', 'is now yours', 1800);
export const ALICE_CODES = at('build', 'alice', ['Update(src/', 'Write(src/'], -1200);
export const BOB_CODES = at('build', 'bob', ['Write(test/', 'Update(test/'], -1200);
export const BOB_WROTE = at('build', 'bob', ['Wrote ', 'Write(test/'], 2000);
export const BOB_PULLED = at('handler', 'bob', ["alice's handler", 'Pulled'], -400);
export const BOB_FIXED = at('handler', 'bob', 'ℹ tests', 1300);
export const ALICE_RUNS = at('tests', 'alice', ['! for shell mode', '! g'], -400);
export const ALICE_PASSES = at('tests', 'alice', 'ℹ pass');
export const ALICE_PASSED = at('tests', 'alice', 'ℹ pass', 1500);
export const BOB_RUNS = at('tests', 'bob', ['! for shell mode', '! g'], -400);
export const BOB_PASSES = at('tests', 'bob', 'ℹ pass');
export const BOB_PASSED = at('tests', 'bob', 'ℹ pass', 1400);
export const BOTH_PASSED = at('tests', 'bob', 'ℹ pass', 4000);

export const trailerEdit: Edit = {
  hookSeconds: 3.4,
  hookTeaser: 'proposal-both',
  endSeconds: 4.8,
  segments: [
    {
      id: 'open',
      from: OPEN_TYPED,
      to: OPEN_TYPED_DONE,
      fit: 1.3,
      eyebrow: '/sub-human',
      caption: 'alice opens a room. The room gets its own Claude.',
      camera: { pane: 'alice', zoom: 2, find: '/sub-human alice' },
    },
    {
      id: 'open-done',
      from: OPEN_TYPED_DONE,
      to: OPEN_DONE,
      fit: 2.3,
      eyebrow: '/sub-human',
      caption: 'alice opens a room. The room gets its own Claude.',
      camera: { pane: 'alice', zoom: 2, find: ["You've joined room", '/sub-human'] },
    },
    {
      id: 'join',
      from: JOIN_TYPED,
      to: JOIN_DONE,
      fit: 3,
      eyebrow: '/sub-human',
      caption: 'bob joins from his own session, with his own Claude.',
      camera: { pane: 'both' },
    },
    {
      id: 'talk',
      from: TALK_TYPED,
      to: TALK_SENT,
      fit: 3.6,
      eyebrow: '@room',
      caption: '@room sends your exact words to everyone in the room.',
      camera: { pane: 'alice', zoom: 2, find: ['@room bob', '✓ sent'] },
    },
    {
      id: 'talk-heard',
      from: BOB_GOT_TALK,
      to: BOB_READ_TALK,
      speed: 1,
      eyebrow: '@room',
      caption: '@room sends your exact words to everyone in the room.',
      camera: { pane: 'bob', zoom: 2, find: 'alice: bob, can you' },
    },
    {
      id: 'claudes',
      from: ASK_TYPED,
      to: ASK_TYPED_DONE,
      fit: 2.8,
      eyebrow: 'Claude to Claude',
      caption: "bob asks his Claude to ask alice's Claude.",
      camera: { pane: 'bob', zoom: 2, find: "ask alice's Claude" },
    },
    {
      id: 'claudes-sent',
      from: ASK_TYPED_DONE,
      to: ASK_SENT,
      fit: 1.8,
      eyebrow: 'Claude to Claude',
      caption: "bob asks his Claude to ask alice's Claude.",
      camera: { pane: 'bob', zoom: 2, find: ['sent to alice', "ask alice's Claude"] },
      callouts: [{ pane: 'bob', label: "bob's Claude", find: ['sent to alice', 'SendMessage(alice'] }],
    },
    {
      id: 'alice-reads',
      from: ALICE_GOT_ASK,
      to: BOB_GOT_ANSWER,
      fit: 2.3,
      eyebrow: 'Claude to Claude',
      caption: "alice's Claude reads the code and answers. alice isn't interrupted.",
      camera: { pane: 'alice', zoom: 2, find: ["Question from bob's Claude", "bob's Claude"] },
      callouts: [{ pane: 'alice', label: "alice's Claude", find: ['Read 1 file', 'Reading the task store', 'Read('] }],
    },
    {
      id: 'answer',
      from: BOB_GOT_ANSWER,
      to: ANSWER_READ,
      fit: 2.2,
      eyebrow: 'Claude to Claude',
      caption: "The answer comes back to bob's Claude.",
      camera: { pane: 'bob', zoom: 2, find: ["Alice's Claude answered", "alice's Claude answered", "alice's Claude: "] },
    },
    {
      id: 'plan',
      from: PLAN_TYPED,
      to: PLAN_SENT,
      fit: 3.6,
      eyebrow: '@claude',
      caption: "@claude asks the room's Claude. It plans only when asked.",
      camera: { pane: 'bob', zoom: 2, find: ['@claude let', '✓ sent'] },
    },
    {
      id: 'plan-think',
      from: PLAN_SENT,
      to: 'proposal',
      fit: 2,
      eyebrow: '@claude',
      caption: "The room's Claude reads the code and drafts a plan.",
      camera: { pane: 'both' },
    },
    {
      id: 'proposal-both',
      from: 'proposal',
      to: 'proposal+1.8s',
      speed: 1,
      eyebrow: 'Plan view',
      caption: 'The plan opens in both of their plan views.',
      camera: { pane: 'both', zoom: 1.04, find: 'Ready to code?' },
    },
    {
      id: 'proposal-zoom',
      from: 'proposal+1.8s',
      to: 'proposal+4.2s',
      speed: 1,
      eyebrow: 'Plan view',
      caption: 'The plan opens in both of their plan views.',
      camera: { pane: 'bob', zoom: 2, find: ['Plan: cursor paging', 'Here is Claude', 'Ready to code?'] },
    },
    {
      id: 'alice-yes',
      from: 'answers',
      to: ALICE_YES,
      fit: 2,
      eyebrow: 'Consent',
      caption: 'alice says yes in her own plan view.',
      camera: { pane: 'alice', zoom: 2, find: ['You approved', 'Approvers'] },
    },
    {
      id: 'answers',
      from: NOTE_TYPED,
      to: NOTE_SENT,
      fit: 3.6,
      eyebrow: 'Consent',
      caption: 'bob says no, with a note.',
      camera: { pane: 'bob', zoom: 2, find: ['must 400, not 500', 'Tell Claude what to change'] },
    },
    {
      id: 'note-card',
      from: CARD,
      to: CARD_GONE,
      speed: 0.4,
      eyebrow: 'Consent',
      caption: 'bob says no, with a note.',
      camera: { pane: 'bob', zoom: 2, find: ['☐ Consent', 'Send to claude'] },
    },
    {
      id: 'revising',
      from: CARD_GONE,
      to: 'revision',
      fit: 1.8,
      eyebrow: 'Consent',
      caption: "The room's Claude revises the plan with bob's note.",
      camera: { pane: 'both' },
    },
    {
      id: 'revision',
      from: REVISED_NOTE,
      to: REVISED_NOTE_READ,
      speed: 0.25,
      eyebrow: 'Consent',
      caption: "The room's Claude revises the plan with bob's note.",
      camera: { pane: 'alice', zoom: 2, find: ['bob asked:', '(revised)', 'Ready to code?'] },
      callouts: [{ pane: 'alice', label: "bob's note", find: 'bob asked:' }],
    },
    {
      id: 'alice-agrees',
      from: REVISED_NOTE_READ,
      to: ALICE_AGREED,
      fit: 1.8,
      eyebrow: 'Consent',
      caption: 'Both say yes to the revision. No Claude can agree for them.',
      camera: { pane: 'alice', zoom: 2, find: ['You approved the revised', 'You approved'] },
    },
    {
      id: 'bob-agrees',
      from: ALICE_AGREED,
      to: BOB_AGREED,
      fit: 2,
      eyebrow: 'Consent',
      caption: 'Both say yes to the revision. No Claude can agree for them.',
      camera: { pane: 'bob', zoom: 2, find: ["You've agreed", 'You agreed'] },
    },
    {
      id: 'split',
      from: BOB_GETS_TASK,
      to: BOB_HAS_TASK,
      fit: 2.4,
      eyebrow: 'Tasks',
      caption: 'The plan becomes two tasks: the handler for alice, the tests for bob.',
      camera: { pane: 'bob', zoom: 2, find: ['is now yours', 'pending, owner you'] },
    },
    {
      id: 'build-alice',
      from: ALICE_CODES,
      to: 'claimed+500ms',
      fit: 2.8,
      eyebrow: 'Build',
      caption: "alice's Claude writes the handler in her checkout.",
      camera: { pane: 'alice', zoom: 2, find: ['const limit', 'rawLimit', 'Update(src/'] },
      callouts: [{ pane: 'alice', label: "alice's Claude", find: ['Update(src/', 'Implement the paging handler', 'Write(src'] }],
    },
    {
      id: 'build-bob',
      from: BOB_CODES,
      to: BOB_WROTE,
      fit: 2.6,
      eyebrow: 'Build',
      caption: "bob's Claude writes the tests in his.",
      // low enough that the Write and its first lines fill the view, not the prompt above them
      camera: { pane: 'bob', zoom: 2, find: ['… +', 'Wrote ', 'Write(test/'] },
      callouts: [{ pane: 'bob', label: "bob's Claude", find: ['Write(test/', 'Update(test/'] }],
    },
    {
      id: 'tested',
      from: BOB_PULLED,
      to: BOB_FIXED,
      fit: 2.7,
      eyebrow: 'Build',
      caption: "bob's Claude tests her handler. One test fails, and the bug is in its own test.",
      camera: { pane: 'bob', zoom: 2, find: ['The failure is in my test', 'ℹ tests'] },
    },
    {
      id: 'tests',
      from: ALICE_RUNS,
      to: ALICE_PASSES,
      fit: 3,
      eyebrow: 'npm test',
      caption: 'alice pulls and runs the tests herself.',
      camera: { pane: 'alice', zoom: 2, find: ['ℹ pass', 'npm test'] },
    },
    {
      id: 'tests-alice-pass',
      from: ALICE_PASSES,
      to: ALICE_PASSED,
      speed: 1,
      eyebrow: 'npm test',
      caption: 'alice pulls and runs the tests herself.',
      camera: { pane: 'alice', zoom: 2, find: ['ℹ pass', 'npm test'] },
      callouts: [{ pane: 'alice', label: 'all pass', find: 'ℹ pass' }],
    },
    {
      id: 'tests-bob',
      from: BOB_RUNS,
      to: BOB_PASSES,
      fit: 2.2,
      eyebrow: 'npm test',
      caption: 'So does bob.',
      camera: { pane: 'bob', zoom: 2, find: ['ℹ pass', 'npm test'] },
    },
    {
      id: 'tests-bob-pass',
      from: BOB_PASSES,
      to: BOB_PASSED,
      speed: 1,
      eyebrow: 'npm test',
      caption: 'So does bob.',
      camera: { pane: 'bob', zoom: 2, find: ['ℹ pass', 'npm test'] },
      callouts: [{ pane: 'bob', label: 'all pass', find: 'ℹ pass' }],
    },
    {
      id: 'pass',
      from: BOB_PASSED,
      to: BOTH_PASSED,
      speed: 1,
      eyebrow: 'npm test',
      caption: 'Tests pass in both checkouts. Two people, two Claudes, one plan.',
      camera: { pane: 'both', zoom: 1.04, find: 'ℹ pass' },
      callouts: [
        { pane: 'alice', label: "alice's run", find: 'ℹ pass' },
        { pane: 'bob', label: "bob's run", find: 'ℹ pass' },
      ],
    },
  ],
};
