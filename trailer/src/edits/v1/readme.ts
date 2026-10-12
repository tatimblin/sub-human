import type { Edit } from '../../lib/edl';
import { ALICE_CODES, BOB_AGREED, BOB_CODES, BOB_PASSED, BOB_PASSES, BOB_WROTE, CARD_GONE, NOTE_SENT, NOTE_TYPED, PLAN_SENT, PLAN_TYPED, REVISED_NOTE_READ } from './trailer';

/**
 * The ~15 s README loop: @claude, the plan in both views, bob's objection, the revision both agree to, each Claude
 * building its half, the tests passing. No hook or end card; it fades at both ends.
 */
export const readmeEdit: Edit = {
  hookSeconds: 0,
  endSeconds: 0,
  segments: [
    { id: 'plan', from: PLAN_TYPED, to: PLAN_SENT, fit: 1.8, eyebrow: '@claude', caption: "@claude asks the room's Claude for a plan", camera: { pane: 'bob' } },
    { id: 'plan-think', from: PLAN_SENT, to: 'proposal', fit: 0.7, eyebrow: '@claude', caption: "@claude asks the room's Claude for a plan", camera: { pane: 'both' } },
    { id: 'proposal', from: 'proposal', to: 'proposal+2s', fit: 1.6, eyebrow: 'plan view', caption: 'It opens in both plan views', camera: { pane: 'both' } },
    { id: 'answers', from: NOTE_TYPED, to: NOTE_SENT, fit: 2.2, eyebrow: 'consent', caption: 'bob says no, with a note', camera: { pane: 'bob' } },
    { id: 'revising', from: CARD_GONE, to: 'revision', fit: 0.7, eyebrow: 'consent', caption: 'The plan is revised. Both agree.', camera: { pane: 'both' } },
    { id: 'agreed', from: REVISED_NOTE_READ, to: BOB_AGREED, fit: 1.5, eyebrow: 'consent', caption: 'The plan is revised. Both agree.', camera: { pane: 'both' } },
    { id: 'build-alice', from: ALICE_CODES, to: 'claimed+500ms', fit: 1.4, eyebrow: 'build', caption: 'Each Claude builds its half', camera: { pane: 'alice' } },
    { id: 'build-bob', from: BOB_CODES, to: BOB_WROTE, fit: 1.2, eyebrow: 'build', caption: 'Each Claude builds its half', camera: { pane: 'bob' } },
    { id: 'tests', from: 'tests', to: BOB_PASSES, fit: 1.6, eyebrow: 'npm test', caption: 'Tests pass in both checkouts', camera: { pane: 'both' } },
    { id: 'pass', from: BOB_PASSES, to: BOB_PASSED, fit: 1.6, eyebrow: 'npm test', caption: 'Tests pass in both checkouts', camera: { pane: 'both' } },
  ],
};
