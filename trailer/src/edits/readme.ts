import type { Edit } from '../lib/edl';
import { ALICE_GOT_PLAN, NOTE_SENT } from './trailer';

/** The ~15 s README loop: from @claude to passing tests, fast. No hook or end card; it fades at both ends. */
export const readmeEdit: Edit = {
  hookSeconds: 0,
  endSeconds: 0,
  segments: [
    { id: 'plan', from: 'plan', to: ALICE_GOT_PLAN, fit: 1.8, eyebrow: '@claude', caption: "@claude asks the room's Claude for a plan", camera: { pane: 'bob' } },
    { id: 'plan-think', from: ALICE_GOT_PLAN, to: 'proposal', fit: 0.8, eyebrow: '@claude', caption: "@claude asks the room's Claude for a plan", camera: { pane: 'both' } },
    { id: 'proposal', from: 'proposal', to: 'answers', fit: 2, eyebrow: 'plan view', caption: 'It opens in both plan views', camera: { pane: 'both' } },
    { id: 'answers', from: 'answers', to: NOTE_SENT, fit: 2.4, eyebrow: 'consent', caption: 'alice agrees; bob says no, with a note', camera: { pane: 'bob' } },
    { id: 'revising', from: NOTE_SENT, to: 'revision', fit: 0.6, eyebrow: 'consent', caption: 'The plan is revised', camera: { pane: 'both' } },
    { id: 'revision', from: 'revision', to: 'revision+3.5s', fit: 1.2, eyebrow: 'consent', caption: 'The plan is revised', camera: { pane: 'both' } },
    { id: 'agreed', from: 'revision+3.5s', to: 'split', fit: 1.4, eyebrow: 'consent', caption: 'Both agree, each in their own session', camera: { pane: 'both' } },
    { id: 'build', from: 'build', to: 'handler', fit: 1.6, eyebrow: 'build', caption: 'Each Claude builds its half', camera: { pane: 'both' } },
    { id: 'tests', from: 'tested', to: 'pass', fit: 1.2, eyebrow: 'npm test', caption: 'Tests pass in both checkouts', camera: { pane: 'both' } },
    { id: 'pass', from: 'pass', to: 'pass+4.5s', fit: 1.3, eyebrow: 'npm test', caption: 'Tests pass in both checkouts', camera: { pane: 'both' } },
  ],
};
