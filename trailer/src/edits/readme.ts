import type { Edit } from '../lib/edl';
import { A, BEATS, plus } from './trailer';


/**
 * The README loop (~8 s): bob's Claude asks alice's and the answer comes back, in the split, with name plates and
 * the message tags only (no captions, no room plate). It fades at both ends, so it loops.
 */
export const readmeEdit: Edit = {
  v2: true,
  roomNode: false,
  captions: false,
  hookSeconds: 0,
  endSeconds: 0,
  segments: [
    { id: 'ask', from: plus(A.askDone, -1800), to: A.askDone, speed: 1, focus: 'bob', caption: '', views: { bob: { zoom: 1.35, find: 'ask alice' }, alice: { zoom: 1.35, anchor: 'bottom' } } },
    { id: 'ask-think', from: A.askDone, to: plus(A.aliceGotAsk, -1100), fit: 0.5, model: true, focus: 'bob', caption: '', views: { bob: { zoom: 1.35, find: 'ask alice' } } },
    { ...BEATS.askFly, caption: '' },
    { ...BEATS.aliceReads, caption: '', fit: 1.2 },
    { ...BEATS.answerFly, caption: '', to: plus(A.bobGotAnswer, 2200) },
  ],
};
