import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Draft, Entry, Member, RoomState, Task } from './entries.js';
import type { Result } from './result.js';
import { decodeEntry } from './schema.js';
import { add, bridgeOp, claim, done, parseTag, release, tag, waitingOn } from './tasks.js';

const task = (n: number, t: Partial<Task> = {}): Task => ({ n, title: `t${n}`, status: 'open', addedBy: 'ann', blockedBy: [], ...t });
const room = (tasks: readonly Task[], members: readonly Member[] = []): RoomState => ({ seq: 0, hash: '', members, plans: [], sent: [], tasks, recent: [] });

/** The one task a rule wrote (decoded as the log would read it), or its refusal. */
function after(r: Result<Draft[]>): Task | string | null {
  if (!r.ok) return r.error;
  const [d, ...rest] = r.value;
  assert.equal(rest.length, 0);
  if (!d) return null;
  assert.equal(d.kind, 'task');
  assert.equal(d.by, 'system');
  const stamped: Entry = { ...d, seq: 1, id: 'e1', at: 1, prev: '', machine: 'm1' };
  const read = decodeEntry(JSON.parse(JSON.stringify(stamped)));
  assert.ok(read.ok, read.ok ? '' : read.error);
  return d.kind === 'task' ? d.task : null;
}

test('add numbers after the highest task, trims the title, and checks blockedBy', () => {
  const s = room([task(1), task(4)]);
  assert.deepEqual(after(add(s, { title: '  paging  ', from: 'bob', blockedBy: [1, 4, 1] })),
    { n: 5, title: 'paging', status: 'open', addedBy: 'bob', blockedBy: [1, 4] });
  assert.deepEqual(after(add(room([]), { title: 'x', from: 'bob' })), { n: 1, title: 'x', status: 'open', addedBy: 'bob', blockedBy: [] });
  assert.equal(after(add(s, { title: ' ', from: 'bob' })), 'No task was added: it needs a title.');
  assert.equal(after(add(s, { title: 'x', from: 'bob', blockedBy: [2, 3] })), 'No task was added: there is no task #2, #3.');
  assert.equal(typeof after(add(s, { title: 't'.repeat(1024), from: 'bob' })), 'object');
  assert.equal(after(add(s, { title: 't'.repeat(1025), from: 'bob' })), 'No task was added: its title is over 1024 characters.');
  const many = room(Array.from({ length: 257 }, (_, i) => task(i + 1)));
  assert.equal(typeof after(add(many, { title: 'x', from: 'bob', blockedBy: many.tasks.slice(1).map(t => t.n) })), 'object');
  assert.equal(after(add(many, { title: 'x', from: 'bob', blockedBy: many.tasks.map(t => t.n) })), 'No task was added: it can wait on at most 256 tasks.');
});

test('claim is for oneself, refused while someone else owns the task (R24)', () => {
  const s = room([task(1), task(2, { status: 'claimed', owner: 'ann' }), task(3, { status: 'done', owner: 'ann' })]);
  const rows: [number, string, Task | string | null][] = [
    [1, 'bob', task(1, { status: 'claimed', owner: 'bob' })],
    [2, 'ann', null], // already hers: nothing to write
    [2, 'bob', 'Task #2 was not claimed: ann has it; they can release it.'],
    [3, 'bob', 'Task #3 was not claimed: it is done.'],
    [9, 'bob', 'Task #9 was not claimed: there is no such task.'],
  ];
  for (const [n, from, want] of rows) assert.deepEqual(after(claim(s, { n, from })), want, `#${n} by ${from}`);
});

test('release and done are the owner\'s only; done keeps an optional note (R24, R26)', () => {
  const s = room([task(1), task(2, { status: 'claimed', owner: 'ann' }), task(3, { status: 'done', owner: 'ann' })]);
  assert.deepEqual(after(release(s, { n: 2, from: 'ann' })), task(2));
  assert.equal(after(release(s, { n: 2, from: 'bob' })), 'Task #2 was not released: ann has it.');
  assert.equal(after(release(s, { n: 1, from: 'bob' })), 'Task #1 was not released: nobody has claimed it.');
  assert.equal(after(release(s, { n: 3, from: 'ann' })), 'Task #3 was not released: it is done.');
  assert.deepEqual(after(done(s, { n: 2, from: 'ann' })), task(2, { status: 'done', owner: 'ann' }));
  assert.deepEqual(after(done(s, { n: 2, from: 'ann', note: ' tests pass ' })), task(2, { status: 'done', owner: 'ann', note: ' tests pass ' }));
  assert.deepEqual(after(done(s, { n: 2, from: 'ann', note: '  ' })), task(2, { status: 'done', owner: 'ann' }));
  assert.equal(after(done(s, { n: 2, from: 'bob' })), 'Task #2 was not marked done: ann has it.');
  assert.equal(after(done(s, { n: 1, from: 'bob' })), 'Task #1 was not marked done: nobody has claimed it.');
  assert.equal(after(done(s, { n: 3, from: 'ann' })), 'Task #3 was not marked done: it is done.');
  assert.equal(after(done(s, { n: 2, from: 'ann', note: 'n'.repeat(8001) })), 'Task #2 was not marked done: the note is over 8000 characters.');
});

test('anyone may release a kicked member\'s task, but not mark it done', () => {
  const kicked: Member = { name: 'ann', machines: [], since: 1, kicked: true };
  const s = room([task(2, { status: 'claimed', owner: 'ann' })], [kicked]);
  assert.deepEqual(after(release(s, { n: 2, from: 'bob' })), task(2));
  assert.equal(after(done(s, { n: 2, from: 'bob' })), 'Task #2 was not marked done: ann has it.');
  assert.equal(after(release(room(s.tasks), { n: 2, from: 'bob' })), 'Task #2 was not released: ann has it.');
});

test('waitingOn lists the blockers not yet done (R25)', () => {
  const s = room([task(1, { status: 'done' }), task(2, { status: 'claimed', owner: 'ann' }), task(3, { blockedBy: [1, 2, 7] })]);
  assert.deepEqual(waitingOn(s, task(3, { blockedBy: [1, 2, 7] })), [2]);
});

test('the bridge tag round-trips inside a native subject (R24a)', () => {
  assert.equal(tag('vole-8126', 3), '[room vole-8126#3]');
  assert.deepEqual(parseTag(`Paging handler ${tag('vole-8126', 3)}`), { code: 'vole-8126', n: 3 });
  const two = `${tag('otter-4821', 1)} paging ${tag('vole-8126', 3)}`;
  assert.deepEqual(parseTag(two, 'vole-8126'), { code: 'vole-8126', n: 3 }); // every tag, mine taken
  assert.equal(parseTag(two, 'mole-1111'), null);
  for (const s of ['paging', '[room vole-8126]', '[room #3]', '[room vole 8126#3]', 'room vole-8126#3']) assert.equal(parseTag(s), null, s);
});

test('bridgeOp: completed is done, deleted is release, a reopen is nothing, untagged is activity (R23b, R24a)', () => {
  const t = { code: 'vole-8126', n: 3 };
  const rows: [{ from: string; to: string } | undefined, typeof t | null, ReturnType<typeof bridgeOp>][] = [
    [{ from: 'in_progress', to: 'completed' }, t, { kind: 'done', ...t }],
    [{ from: 'pending', to: 'completed' }, t, { kind: 'done', ...t }],
    [{ from: 'in_progress', to: 'deleted' }, t, { kind: 'release', ...t }],
    [{ from: 'pending', to: 'in_progress' }, t, { kind: 'none' }],
    [{ from: 'in_progress', to: 'pending' }, t, { kind: 'none' }],
    [{ from: 'completed', to: 'completed' }, t, { kind: 'none' }],
    [undefined, t, { kind: 'none' }], // a rename: no status change
    [{ from: 'pending', to: 'in_progress' }, null, { kind: 'activity' }],
    [{ from: 'in_progress', to: 'completed' }, null, { kind: 'activity' }],
    [undefined, null, { kind: 'none' }],
  ];
  for (const [change, tg, want] of rows) assert.deepEqual(bridgeOp(change, tg), want, JSON.stringify([change, tg]));
});
