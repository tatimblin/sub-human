/**
 * plugin/sub-human/lib/consent/card.ts: the person's answer on an AskUserQuestion card the hooks built. One reading
 * for every card whose answer the hooks act on: the fallback consent card (lib/proposal.ts card), a review note's
 * confirm card (Send / Discard) and a join request's card (lib/remote/admission.ts).
 * Pure: no I/O. The tool_response is Claude Code's (the person's answer in the dialog), never the
 * model's; the tool_input is the model's call, read only to tell which card the call was.
 *
 *   answerCard(spec, response, input?, {exact?}) -> CardAnswer
 *     absent   the call was not this card: its question is in neither the card shown nor the call (nor, exact
 *              false, among the answers)
 *     none     no answer from the person: an AFK auto-close (afkTimeoutMs), a followUp, no answer to this question,
 *              or (exact) a card shown other than as the hooks built it (question, labels, descriptions)
 *     other    an answer that is none of the card's labels (the person typed their own)
 *     answer   {label, notes?}: one of the card's labels, with the person's note on it (annotations)
 *   exact (default true): the card shown must be the hooks' card, option for option. The fallback consent card passes
 *   false: any call naming a pending proposal was rewritten to the hooks' card before it showed (hooks/consent.ts
 *   Pre), and its answers carry the proposal's hash in the question.
 */

/** One question of a card as the hooks built it (the AskUserQuestion input). */
export interface CardSpec { question: string; options: { label: string; description: string }[] }

/** A card question as Claude Code reports it (untrusted shape: each field checked). */
interface ShownQuestion { question?: unknown; options?: ({ label?: unknown; description?: unknown } | null | undefined)[] }

/** AskUserQuestion's tool_response, as far as a card's answer reads it. */
export interface CardResponse {
  questions?: unknown;
  answers?: unknown;
  annotations?: unknown;
  afkTimeoutMs?: unknown;
  followUp?: unknown;
}

export type CardAnswer =
  | { kind: 'absent' }
  | { kind: 'none' }
  | { kind: 'other'; label: string }
  | { kind: 'answer'; label: string; notes?: string };

const list = (v: unknown): ShownQuestion[] => (Array.isArray(v) ? v.filter((q): q is ShownQuestion => !!q && typeof q === 'object') : []);
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** The question shown is the spec's, option for option (label and description). */
function same(q: ShownQuestion, spec: CardSpec): boolean {
  const opts = Array.isArray(q.options) ? q.options : null;
  return q.question === spec.question && !!opts && opts.length === spec.options.length
    && opts.every((o, i) => { const so = spec.options[i]; return !!o && !!so && o.label === so.label && o.description === so.description; }); // as long: so is there
}

export function answerCard(spec: CardSpec, response: CardResponse | null | undefined, input?: { questions?: unknown } | null,
  { exact = true }: { exact?: boolean } = {}): CardAnswer {
  const r = response && typeof response === 'object' ? response : {};
  const shown = list(r.questions);
  const answers = record(r.answers);
  const has = !!answers && Object.hasOwn(answers, spec.question);
  const asked = [...shown, ...list(input && input.questions)].some(q => q.question === spec.question) || (!exact && has);
  if (!asked) return { kind: 'absent' };
  if (r.afkTimeoutMs || r.followUp || !answers || !has) return { kind: 'none' };
  if (exact && !shown.some(q => same(q, spec))) return { kind: 'none' };
  const label = String(answers[spec.question]);
  if (!spec.options.some(o => o.label === label)) return { kind: 'other', label };
  const note = record(record(r.annotations)?.[spec.question])?.notes;
  return typeof note === 'string' ? { kind: 'answer', label, notes: note } : { kind: 'answer', label };
}
