import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Envelope, RoomState, Update } from './entries.js';
import { EMPTY, asRoom } from './fold.js';
import { brief, BRIEF_MAX } from './brief.js';

const env = (seq: number, from: string, by: Envelope['by'] = 'person'): Envelope => ({ seq, id: `e${seq}`, at: seq, prev: '', from, by, machine: 'm1' });

const room: RoomState = {
  ...EMPTY,
  seq: 42,
  members: [
    {
      name: 'ann', machines: ['m1'], since: 1, kicked: false, repo: 'web', branch: 'main',
      presence: { name: 'ann', state: 'working', at: 5 },
      focus: { name: 'ann', text: 'paging handler', branch: 'feat/paging', at: 5 },
      activity: { name: 'ann', files: ['src/server.js', 'src/store.js'], at: 5 },
    },
    { name: 'bob', machines: ['m2'], since: 2, kicked: false, presence: { name: 'bob', state: 'idle', waiting: true, at: 5 } },
    { name: 'cy', machines: [], since: 3, kicked: false },
  ],
  plans: [
    {
      name: 'api', scope: 'group',
      versions: [
        { version: 1, hash: 'p1', base: 0, from: 'ann', at: 1, asked: ['bob'], answers: [], decision: { agreed: [], changes: ['bob'], at: 2 } },
        { version: 2, hash: 'p2', base: 1, from: 'ann', at: 3, asked: ['bob', 'cy'], answers: [{ name: 'bob', answer: 'agree' }] },
      ],
    },
    { name: 'store', scope: 'group', versions: [{ version: 1, hash: 's1', base: 0, from: 'bob', at: 1, asked: ['ann'], answers: [], decision: { agreed: ['ann'], changes: [], at: 4 } }] },
  ],
  sent: [{ name: 'mine', version: 1, from: 'bob', at: 6, to: 'ann', files: [], answers: [{ name: 'ann', answer: 'accept' }] }],
  tasks: [
    { n: 1, title: 'store paging', status: 'done', addedBy: 'ann', owner: 'bob', blockedBy: [] },
    { n: 2, title: 'handler paging', status: 'claimed', addedBy: 'ann', owner: 'ann', blockedBy: [1] },
    { n: 3, title: 'docs', status: 'open', addedBy: 'bob', blockedBy: [] },
  ],
  recent: [
    { ...env(7, 'bob', 'claude'), kind: 'finding', text: 'the flaky test is a timezone bug' },
    { ...env(8, 'ann'), kind: 'activity', event: 'test', text: 'npm test', ok: false },
    { ...env(9, 'ann'), kind: 'post', text: 'rebase on main', to: 'bob' },
  ],
};

test('the catch-up: who is doing what, plans, open tasks, then updates newest first', () => {
  assert.equal(brief(room, { code: 'vole-8126' }), [
    'Room vole-8126, at update 42.',
    'Members here:',
    '- ann (working) in web on feat/paging: paging handler. Edited src/server.js, src/store.js',
    '- bob (idle, waiting on a permission prompt)',
    'Plans:',
    '- api version 2 by ann: bob agreed; waiting on cy',
    '- store version 1 by bob: agreed by ann',
    '- mine version 1 sent by bob to ann: ann accepted',
    'Open tasks:',
    '- #2 handler paging: claimed by ann, blocked by #1',
    '- #3 docs: open',
    'Recent updates, newest first:',
    '- ann (to bob): rebase on main',
    '- ann: npm test (failed)',
    "- bob's Claude: the flaky test is a timezone bug",
  ].join('\n'));
});

test('an empty room says so in plain words', () => {
  assert.equal(brief(asRoom(EMPTY), { code: 'vole-8126' }),
    'Room vole-8126, at update 0.\nMembers here: nobody.\nPlans: none.\nOpen tasks: none.\nRecent updates, newest first: none.');
});

test('bounded by maxChars, cutting whole lines from the end, and deterministic', () => {
  const many: Update[] = Array.from({ length: 30 }, (_, i) => ({ ...env(i + 1, 'bob', 'claude'), kind: 'finding', text: `update ${i} ${'x'.repeat(300)}\n injected` }));
  const big: RoomState = { ...room, recent: many };
  for (const max of [0, 5, 50, 200, 800, BRIEF_MAX]) {
    const text = brief(big, { code: 'c', maxChars: max });
    assert.ok(text.length <= max, `${max}: ${text.length}`);
    assert.equal(text, brief(big, { code: 'c', maxChars: max }));
  }
  const text = brief(big, { code: 'c' });
  const total = brief(big, { code: 'c', maxChars: Infinity }).split('\n').length;
  const kept = text.split('\n').length - 1;
  assert.match(text, new RegExp(`\n… ${total - kept} more lines$`)); // says how much was cut
  assert.equal(brief(big, { code: 'c', maxChars: 5 }), ''); // not even the marker fits
  assert.match(text, /update 29/); // newest kept
  assert.doesNotMatch(text, /update 0 /);
  for (const line of text.split('\n')) assert.ok(line.length <= 240, line);
  assert.doesNotMatch(text, /\n injected/); // a newline in a text can't start a line of its own
});
