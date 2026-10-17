// lib/consent/card.ts answerCard: the one reading of the person's answer on a card the hooks built (the consent
// card, a note's confirm card, a join request's card).
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerCard } from '../lib/consent/card.ts';
import type { CardSpec } from '../lib/consent/card.ts';

const LET_IN = { label: 'Let in', description: 'carol joins the room from her machine.' }, REFUSE = { label: 'Refuse', description: 'carol\'s join stops.' };
const SPEC: CardSpec = { question: 'Let carol into room vole-8126? (admit 3f9c2a3f9c2a)', options: [LET_IN, REFUSE] };
const shown = (over: Partial<CardSpec> = {}) => ({ ...SPEC, header: 'Join', multiSelect: false, ...over });
const resp = (label: string | null, extra: Record<string, unknown> = {}) => ({ questions: [shown()], answers: label == null ? {} : { [SPEC.question]: label }, ...extra });

test('answerCard: the card as built and one of its labels is the answer, with the person\'s note', () => {
  assert.deepEqual(answerCard(SPEC, resp('Let in')), { kind: 'answer', label: 'Let in' });
  assert.deepEqual(answerCard(SPEC, resp('Refuse', { annotations: { [SPEC.question]: { notes: 'busy  ✓\n' } } })), { kind: 'answer', label: 'Refuse', notes: 'busy  ✓\n' });
});

test('answerCard: another call is absent; the question only in the model\'s call still counts as this card', () => {
  assert.deepEqual(answerCard(SPEC, { questions: [{ question: 'Which DB?' }], answers: { 'Which DB?': 'pg' } }), { kind: 'absent' });
  assert.deepEqual(answerCard(SPEC, {}, null), { kind: 'absent' });
  assert.deepEqual(answerCard(SPEC, { answers: { [SPEC.question]: 'Let in' } }), { kind: 'absent' }, 'answers alone do not make the card (exact)');
  assert.deepEqual(answerCard(SPEC, { questions: [] }, { questions: [{ question: SPEC.question }] }), { kind: 'none' }, 'asked, never answered');
});

test('answerCard: AFK, a followUp, no answer or a card shown other than as built is no answer', () => {
  assert.deepEqual(answerCard(SPEC, resp('Let in', { afkTimeoutMs: 60000 })), { kind: 'none' });
  assert.deepEqual(answerCard(SPEC, resp('Let in', { followUp: 'tell me more' })), { kind: 'none' });
  assert.deepEqual(answerCard(SPEC, resp(null)), { kind: 'none' });
  // the model's own card with the hooks' question: swapped descriptions, a missing option, an extra one
  const swapped = shown({ options: [{ ...LET_IN, description: REFUSE.description }, { ...REFUSE, description: LET_IN.description }] });
  for (const q of [swapped, shown({ options: [LET_IN] }), shown({ options: [...SPEC.options, { label: 'Yes', description: '' }] })]) {
    assert.deepEqual(answerCard(SPEC, { questions: [q], answers: { [SPEC.question]: 'Let in' } }), { kind: 'none' });
  }
});

test('answerCard: a label the card does not offer is other', () => {
  assert.deepEqual(answerCard(SPEC, resp('maybe later')), { kind: 'other', label: 'maybe later' });
});

test('answerCard exact false (the consent card): the answer keyed by the question is enough', () => {
  const spec: CardSpec = { question: 'Agree to proposal 0123456789ab?', options: ['Not yet', 'Agree', 'Object'].map(label => ({ label, description: '' })) };
  assert.deepEqual(answerCard(spec, { answers: { [spec.question]: 'Agree' } }, null, { exact: false }), { kind: 'answer', label: 'Agree' });
  assert.deepEqual(answerCard(spec, { answers: { [spec.question]: 'Accept' } }, null, { exact: false }), { kind: 'other', label: 'Accept' });
  assert.deepEqual(answerCard(spec, { answers: { [spec.question]: 'Agree' }, afkTimeoutMs: 1 }, null, { exact: false }), { kind: 'none' });
  assert.deepEqual(answerCard(spec, { answers: {} }, null, { exact: false }), { kind: 'absent' });
});
