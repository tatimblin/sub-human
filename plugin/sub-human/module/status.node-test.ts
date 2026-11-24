// status.ts's line (R15b), pure: each member's dot, the width, and the one thing that needs me most, with how many more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Member, Plan, PresenceDoc, RoomState, SentPlan, Task } from '../core/entries.js';
import { needsMe, statusLine } from './status.js';

const CODE = 'heron-2988';
const ME = { code: CODE, name: 'alice' };
const member = (name: string, presence?: Partial<PresenceDoc>, m: Partial<Member> = {}): Member => ({
  name, machine: `${name}-laptop`, since: 0, kicked: false, machines: presence?.state === 'away' ? [] : [`${name}-laptop`],
  ...(presence && { presence: { name, state: 'working', machine: `${name}-laptop`, at: 0, ...presence } }), ...m,
});
/** A member who left: no machine in the membership. */
const left = (name: string): Member => ({ name, since: 0, kicked: false, machines: [] });
const room = (r: Partial<RoomState> = {}): RoomState => ({ seq: 0, hash: '', members: [member('alice')], plans: [], sent: [], tasks: [], recent: [], ...r });
const asked = (name: string, people: readonly string[], answered: readonly string[] = []): Plan => ({
  name, scope: 'group', versions: [{ version: 1, hash: 'h', base: 0, from: 'bob', at: 0, asked: people, answers: answered.map(n => ({ name: n, answer: 'agree' })) }],
});
const sent = (name: string, from: string): SentPlan => ({ name, version: 1, from, at: 0, to: 'alice', files: [], answers: [] });
const task = (n: number, t: Partial<Task> = {}): Task => ({ n, title: `t${n}`, status: 'open', addedBy: 'bob', blockedBy: [], ...t });

test('each other member with the dot of what they are doing; one who left is gone, the host away says so', () => {
  const members = [
    member('alice', {}), member('bob', { state: 'working' }), member('carol', { state: 'idle' }), member('dan', { state: 'working', waiting: true }),
    member('erin', { state: 'away' }), left('fay'), member('gus', { state: 'working' }, { kicked: true, machines: [] }),
  ];
  assert.equal(statusLine(room({ members }), ME, 0), `${CODE} ● bob ○ carol ◐ dan ◌ erin`);
  assert.equal(statusLine(room({ members }), ME, 0, true), `${CODE} host away`);
  assert.equal(statusLine(room(), ME, 0), `${CODE}`);
});

test('within the width, names fold into +N first; the code and what needs me stay whole', () => {
  const members = ['alice', 'bob', 'carol', 'dan', 'erin'].map(n => member(n, {}));
  const all = `${CODE} ● bob ● carol ● dan ● erin`;
  assert.equal(statusLine(room({ members }), ME, 0, false, all.length), all);
  assert.equal(statusLine(room({ members }), ME, 0, false, all.length - 1), `${CODE} ● bob ● carol ● dan +1`);
  assert.equal(statusLine(room({ members }), ME, 0, false, `${CODE} ● bob +3`.length), `${CODE} ● bob +3`);
  assert.equal(statusLine(room({ members }), ME, 2, false, 10), `${CODE} +4 · 2 held messages: /sub-human news`);
});

test('what needs me, most urgent first: a review, a plan sent to me, held messages, a task now free; then (+N)', () => {
  const r = room({
    members: [member('alice', {}), member('bob', {}), member('carol', { state: 'idle' })],
    plans: [asked('paging', ['alice']), asked('done', ['alice'], ['alice']), asked('theirs', ['carol']), asked('shipping', [])],
    sent: [sent('shipping', 'carol')],
    tasks: [task(1, { status: 'done' }), task(2, { addedBy: 'alice', blockedBy: [1] }), task(3, { addedBy: 'alice', blockedBy: [4] }), task(4), task(5, { addedBy: 'alice' }),
      task(6, { addedBy: 'alice', blockedBy: [1], status: 'claimed', owner: 'bob' })], // #6 is started: not free
  });
  assert.deepEqual(needsMe(r, 'alice', 2), [
    'plan "paging" needs your review', 'carol sent you plan "shipping"', '2 held messages: /sub-human news', 'task #2 is free to start',
  ]);
  assert.equal(statusLine(r, ME, 2, false, 200), `${CODE} ● bob ○ carol · plan "paging" needs your review (+3)`);
  // each answered or gone, the next comes up
  const answered = { ...r, plans: r.plans.map(p => (p.name === 'paging' ? asked('paging', ['alice'], ['alice']) : p)) };
  assert.equal(statusLine(answered, ME, 2), `${CODE} ● bob ○ carol · carol sent you plan "shipping" (+2)`);
  const accepted = { ...answered, sent: [{ ...sent('shipping', 'carol'), answers: [{ name: 'alice', answer: 'accept' as const }] }] };
  assert.equal(statusLine(accepted, ME, 1), `${CODE} ● bob ○ carol · 1 held message: /sub-human news (+1)`);
  assert.equal(statusLine(accepted, ME, 0), `${CODE} ● bob ○ carol · task #2 is free to start`);
  assert.equal(statusLine({ ...accepted, tasks: [] }, ME, 0), `${CODE} ● bob ○ carol`);
});
