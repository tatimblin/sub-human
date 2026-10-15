// lib/consent/card.ts answerCard: the one reading of the person's answer on a card the hooks built (the consent
// card, a note's confirm card, the handoff card, a join request's card).
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerCard } from '../lib/consent/card.ts';
import type { CardSpec } from '../lib/consent/card.ts';

const SPEC: CardSpec = { question: 'Host room vole-8126 on this machine? (handoff 3f9c2a)', options: [
  { label: 'Host it here', description: 'alice asks to move the room here.' },
  { label: 'Not now', description: 'alice stays the host.' },
] };
const shown = (over: Partial<CardSpec> = {}) => ({ ...SPEC, header: 'Handoff', multiSelect: false, ...over });
const resp = (label: string | null, extra: Record<string, unknown> = {}) => ({ questions: [shown()], answers: label == null ? {} : { [SPEC.question]: label }, ...extra });

test('answerCard: the card as built and one of its labels is the answer, with the person\'s note', () => {
  assert.deepEqual(answerCard(SPEC, resp('Host it here')), { kind: 'answer', label: 'Host it here' });
  assert.deepEqual(answerCard(SPEC, resp('Not now', { annotations: { [SPEC.question]: { notes: 'busy  ✓\n' } } })), { kind: 'answer', label: 'Not now', notes: 'busy  ✓\n' });
});

test('answerCard: another call is absent; the question only in the model\'s call still counts as this card', () => {
  assert.deepEqual(answerCard(SPEC, { questions: [{ question: 'Which DB?' }], answers: { 'Which DB?': 'pg' } }), { kind: 'absent' });
  assert.deepEqual(answerCard(SPEC, {}, null), { kind: 'absent' });
  assert.deepEqual(answerCard(SPEC, { answers: { [SPEC.question]: 'Host it here' } }), { kind: 'absent' }, 'answers alone do not make the card (exact)');
  assert.deepEqual(answerCard(SPEC, { questions: [] }, { questions: [{ question: SPEC.question }] }), { kind: 'none' }, 'asked, never answered');
});

test('answerCard: AFK, a followUp, no answer or a card shown other than as built is no answer', () => {
  assert.deepEqual(answerCard(SPEC, resp('Host it here', { afkTimeoutMs: 60000 })), { kind: 'none' });
  assert.deepEqual(answerCard(SPEC, resp('Host it here', { followUp: 'tell me more' })), { kind: 'none' });
  assert.deepEqual(answerCard(SPEC, resp(null)), { kind: 'none' });
  // the model's own card with the hooks' question: swapped descriptions, a missing option, an extra one
  const swapped = shown({ options: [{ ...SPEC.options[0], description: SPEC.options[1].description }, { ...SPEC.options[1], description: SPEC.options[0].description }] });
  for (const q of [swapped, shown({ options: [SPEC.options[0]] }), shown({ options: [...SPEC.options, { label: 'Yes', description: '' }] })]) {
    assert.deepEqual(answerCard(SPEC, { questions: [q], answers: { [SPEC.question]: 'Host it here' } }), { kind: 'none' });
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
