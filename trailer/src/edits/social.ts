import type { Edit } from '../lib/edl';
import { A, BEATS, TAG, plus } from './trailer';


/**
 * The 15 s social cut, about 4 s a beat: the green split, Claude asks Claude, the plan and both people's yes,
 * then the install line.
 */
export const socialEdit: Edit = {
  v2: true,
  roomNode: true,
  hookSeconds: 0,
  endSeconds: 3.3,
  endCard: 'short',
  segments: [
    { ...BEATS.cold, from: plus(A.bobPass, -300), to: plus(A.bobPass, 2100) },
    { ...BEATS.askFly, dip: true, caption: 'Your Claude can ask theirs.', from: plus(A.aliceGotAsk, -1000), to: plus(A.aliceGotAsk, 500) },
    { ...BEATS.aliceReads, caption: 'Your Claude can ask theirs.', fit: 0.6, marks: [] },
    { ...BEATS.answerFly, caption: 'Your Claude can ask theirs.', from: plus(A.bobGotAnswer, -1100), to: plus(A.bobGotAnswer, 500) },
    { ...BEATS.planOpen, dip: true, caption: 'Plan together. Each person approves.', from: plus(A.planOpen, -900), to: plus(A.planOpen, 700), tags: [TAG.plan] },
    { ...BEATS.noteInPlan, caption: 'Plan together. Each person approves.', from: plus(A.noteInPlan, 1050), to: plus(A.noteInPlan, 2100) },
    { ...BEATS.aliceYes, caption: 'Plan together. Each person approves.', to: plus(A.aliceYes, 800) },
    { ...BEATS.bobYes, caption: 'Plan together. Each person approves.', to: plus(A.bobYes, 1200) },
  ],
};
