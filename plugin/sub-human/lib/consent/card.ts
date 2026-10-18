/**
 * plugin/sub-human/lib/consent/card.ts: the person's answer on an AskUserQuestion card the hooks built, for the consent
 * hook (hooks/consent.ts). The reading is mod/core/card.ts answerCard (pure), shared with the hooks module, which reads
 * the invite's copy card (mod/core/copy.ts) itself, where the invite line is.
 */
export { answerCard } from '../../mod/core/card.ts';
export type { CardAnswer, CardResponse, CardSpec } from '../../mod/core/card.ts';
