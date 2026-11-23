import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Docs, Entry, Envelope, LogLine, Task } from './entries.js';
import { NO_DOCS } from './entries.js';
import { decodeSnapshot } from './schema.js';
import { BRIEF_RECENT, fold, snapshotDue, takeSnapshot, updatesSince } from './fold.js';

type Body = Entry extends infer E ? E extends Entry ? Omit<E, 'seq' | 'id' | 'at' | 'prev' | 'by' | 'machine'> & Partial<Pick<Envelope, 'by' | 'machine'>> : never : never;

/** A chained log from entry bodies: seq from 1, `at` = seq, hashes h1, h2, … */
function log(bodies: readonly Body[], from = 0): LogLine[] {
  return bodies.map((b, i) => {
    const seq = from + i + 1;
    const entry: Entry = { seq, id: `e${seq}`, at: seq, prev: seq > 1 ? `h${seq - 1}` : '', by: 'person', machine: 'm1', ...b };
    return { entry, hash: `h${seq}` };
  });
}

const state = (bodies: readonly Body[], docs: Docs = NO_DOCS) => fold(null, log(bodies), docs);
const task = (n: number, t: Partial<Task> = {}): Task => ({ n, title: `t${n}`, status: 'open', addedBy: 'ann', blockedBy: [], ...t });

test('joins and leaves: one membership per name, since resets on a rejoin, kicked stays out', () => {
  const s = state([
    { kind: 'joined', from: 'ann', repo: 'web', branch: 'main' },
    { kind: 'joined', from: 'ann', machine: 'm2' },
    { kind: 'joined', from: 'bob' },
    { kind: 'left', from: 'ann', machine: 'm1' },
    { kind: 'kick', from: 'ann', by: 'system', name: 'bob' },
    { kind: 'joined', from: 'bob' },
  ]);
  assert.deepEqual(s.members, [
    { name: 'ann', since: 1, kicked: false, repo: 'web', branch: 'main', machines: [] },
    { name: 'bob', since: 3, kicked: true, machines: [] },
  ]);
  assert.equal(s.seq, 6);
  assert.equal(s.hash, 'h6');
  const back = state([{ kind: 'joined', from: 'ann' }, { kind: 'left', from: 'ann' }, { kind: 'joined', from: 'ann', repo: 'api' }]);
  assert.deepEqual(back.members, [{ name: 'ann', machine: 'm1', since: 3, kicked: false, repo: 'api', machines: [] }]);
});

test('a member is here on the machines of their presence documents that aren\'t away', () => {
  const s = state([{ kind: 'joined', from: 'ann' }, { kind: 'joined', from: 'bob' }], {
    presence: [
      { name: 'ann', state: 'idle', machine: 'm1', at: 1 }, { name: 'ann', state: 'working', machine: 'm2', at: 3 },
      { name: 'bob', state: 'away', machine: 'm1', at: 2 },
    ],
    activity: [], focus: [],
  });
  assert.deepEqual(s.members.map(m => [m.name, m.machine, m.machines, m.presence?.state]), [['ann', 'm1', ['m1', 'm2'], 'working'], ['bob', 'm1', [], 'away']]);
  const one = state([{ kind: 'joined', from: 'ann' }], { presence: [{ name: 'ann', state: 'away', machine: 'm2', at: 5 }, { name: 'ann', state: 'idle', machine: 'm1', at: 1 }], activity: [], focus: [] });
  assert.deepEqual(one.members.map(m => [m.machines, m.presence?.state]), [[['m1'], 'idle']], 'a later away elsewhere leaves the member here');
});

test('documents join their member, latest wins, and never make a member', () => {
  const s = state([{ kind: 'joined', from: 'ann' }], {
    presence: [{ name: 'ann', state: 'idle', at: 1 }, { name: 'ann', state: 'working', at: 2 }, { name: 'zed', state: 'idle', at: 1 }],
    activity: [{ name: 'ann', files: ['a.ts'], at: 2 }],
    focus: [{ name: 'ann', text: 'paging', at: 2 }],
  });
  assert.equal(s.members.length, 1);
  assert.equal(s.members[0]?.presence?.state, 'working');
  assert.deepEqual(s.members[0]?.activity?.files, ['a.ts']);
  assert.equal(s.members[0]?.focus?.text, 'paging');
});

test('plans: versions, asks, answers per version, and the decision', () => {
  const s = state([
    { kind: 'plan', from: 'ann', name: 'api', version: 1, hash: 'p1', base: 0, scope: 'group' },
    { kind: 'plan_ask', from: 'ann', by: 'claude', name: 'api', version: 1, people: ['bob', 'cy'] },
    { kind: 'plan_answer', from: 'bob', name: 'api', version: 1, answer: 'changes', note: 'cursor paging' },
    { kind: 'plan', from: 'ann', name: 'api', version: 2, hash: 'p2', base: 1, scope: 'group' },
    { kind: 'plan_answer', from: 'cy', name: 'api', version: 1, answer: 'agree' }, // v1 is superseded
    { kind: 'plan', from: 'bob', name: 'api', version: 2, hash: 'px', base: 1, scope: 'group' }, // stale: refused
    { kind: 'plan_ask', from: 'ann', name: 'api', version: 2, people: ['bob', 'cy', 'bob'] },
    { kind: 'plan_answer', from: 'dan', name: 'api', version: 2, answer: 'agree' }, // not asked
    { kind: 'plan_answer', from: 'bob', name: 'api', version: 2, answer: 'changes' },
    { kind: 'plan_answer', from: 'bob', name: 'api', version: 2, answer: 'agree' }, // a second answer replaces the first
    { kind: 'plan_answer', from: 'cy', name: 'api', version: 2, answer: 'agree' },
    { kind: 'decision', from: 'ann', by: 'system', name: 'api', version: 2, agreed: ['bob', 'cy'], changes: [] },
    { kind: 'plan_answer', from: 'cy', name: 'api', version: 2, answer: 'changes' }, // after the decision
  ]);
  const [plan] = s.plans;
  assert.ok(plan);
  assert.deepEqual(plan.versions.map(v => [v.version, v.hash, v.from]), [[1, 'p1', 'ann'], [2, 'p2', 'ann']]);
  const [v1, v2] = plan.versions;
  assert.deepEqual(v1?.answers, [{ name: 'bob', answer: 'changes', note: 'cursor paging' }]);
  assert.deepEqual(v2?.asked, ['bob', 'cy']);
  assert.deepEqual(v2?.answers, [{ name: 'bob', answer: 'agree' }, { name: 'cy', answer: 'agree' }]);
  assert.deepEqual(v2?.decision, { agreed: ['bob', 'cy'], changes: [], at: 12 });
});

test('a kick is permanent, even of a name that never joined', () => {
  const s = state([
    { kind: 'kick', from: 'ann', by: 'system', name: 'eve' },
    { kind: 'joined', from: 'eve' },
  ]);
  assert.deepEqual(s.members, [{ name: 'eve', machines: [], since: 1, kicked: true }]);
});

test('plan versions go up by one and keep the first version\'s scope', () => {
  const s = state([
    { kind: 'plan', from: 'ann', name: 'api', version: 2, hash: 'p0', base: 1, scope: 'group' }, // no version 1 yet
    { kind: 'plan', from: 'ann', name: 'api', version: 1, hash: 'p1', base: 0, scope: 'group' },
    { kind: 'plan', from: 'ann', name: 'api', version: 3, hash: 'p3', base: 2, scope: 'group' }, // skips 2
    { kind: 'plan', from: 'bob', name: 'api', version: 2, hash: 'p2', base: 1, scope: 'personal' },
  ]);
  assert.deepEqual(s.plans.map(p => [p.scope, p.versions.map(v => v.hash)]), [['group', ['p1', 'p2']]]);
});

test('posts and findings are kept as recent updates, labelled as written', () => {
  const s = state([
    { kind: 'post', from: 'ann', text: 'rebase on main', to: 'bob' },
    { kind: 'post', from: 'bob', by: 'claude', text: 'store landed' },
    { kind: 'finding', from: 'bob', by: 'claude', text: 'timezone bug' },
  ]);
  assert.deepEqual(s.recent.map(u => [u.kind, u.from, u.by, u.kind === 'post' ? u.to : undefined]), [
    ['post', 'ann', 'person', 'bob'], ['post', 'bob', 'claude', undefined], ['finding', 'bob', 'claude', undefined],
  ]);
});

test('updatesSince: others\' updates, plans and tasks after the cursor, never my own or admission records', () => {
  const lines = log([
    { kind: 'joined', from: 'bob' },
    { kind: 'finding', from: 'bob', by: 'claude', text: 'x' },
    { kind: 'post', from: 'ann', text: 'mine' },
    { kind: 'activity', from: 'bob', event: 'commit', text: 'c' },
    { kind: 'plan', from: 'bob', name: 'api', version: 1, hash: 'p', base: 0, scope: 'group' },
    { kind: 'decision', from: 'ann', by: 'system', name: 'api', version: 1, agreed: ['ann'], changes: [] },
    { kind: 'plan_sent', from: 'bob', name: 'api', version: 1, files: [] },
    { kind: 'task', from: 'bob', by: 'system', task: task(1) },
    { kind: 'task', from: 'ann', by: 'system', task: task(2) }, // my own claim: not news
    { kind: 'invite', from: 'ann', by: 'system', invite: 'i', name: 'cy', expires: 9 },
    { kind: 'plan_answer', from: 'bob', name: 'api', version: 1, answer: 'agree' },
  ]);
  const news = updatesSince(lines, 'ann');
  assert.equal(news.count, 6);
  assert.deepEqual(news.items.map(e => e.seq), [2, 4, 5, 6, 7, 8]);
  assert.equal(updatesSince(lines.slice(5), 'ann').count, 3); // after a cursor at 5
  assert.deepEqual(updatesSince([], 'ann'), { count: 0, items: [] });
});

test('sent plans: one per sender and version, answered only by a recipient', () => {
  const s = state([
    { kind: 'plan', from: 'ann', name: 'mine', version: 1, hash: 'p1', base: 0, scope: 'personal' },
    { kind: 'plan_sent', from: 'ann', name: 'mine', version: 1, to: 'bob', files: ['a.ts'], branch: 'feat' },
    { kind: 'plan_accept', from: 'cy', name: 'mine', version: 1, answer: 'accept' }, // not the recipient
    { kind: 'plan_accept', from: 'ann', name: 'mine', version: 1, answer: 'accept' }, // the sender
    { kind: 'plan_accept', from: 'bob', name: 'mine', version: 1, answer: 'changes', note: 'smaller' },
    { kind: 'plan_sent', from: 'ann', name: 'room', version: 1, files: [] },
    { kind: 'plan_accept', from: 'cy', name: 'room', version: 1, answer: 'dismiss' },
  ]);
  assert.deepEqual(s.sent, [
    { name: 'mine', version: 1, from: 'ann', at: 2, to: 'bob', files: ['a.ts'], branch: 'feat', answers: [{ name: 'bob', answer: 'changes', note: 'smaller' }] },
    { name: 'room', version: 1, from: 'ann', at: 6, files: [], answers: [{ name: 'cy', answer: 'dismiss' }] },
  ]);
});

test('tasks: each entry is the whole task, latest wins', () => {
  const s = state([
    { kind: 'task', from: 'ann', by: 'system', task: task(1) },
    { kind: 'task', from: 'ann', by: 'system', task: task(2, { blockedBy: [1] }) },
    { kind: 'task', from: 'bob', by: 'system', task: task(1, { status: 'claimed', owner: 'bob' }) },
    { kind: 'task', from: 'bob', by: 'system', task: task(1, { status: 'done', owner: 'bob', note: 'shipped' }) },
  ]);
  assert.deepEqual(s.tasks, [task(1, { status: 'done', owner: 'bob', note: 'shipped' }), task(2, { blockedBy: [1] })]);
});

test('recent updates keep the last BRIEF_RECENT; admission records change nothing', () => {
  const s = state([
    ...Array.from({ length: BRIEF_RECENT + 5 }, (_, i): Body => ({ kind: 'finding', from: 'ann', by: 'claude', text: `f${i}` })),
    { kind: 'invite', from: 'ann', by: 'system', invite: 'i1', name: 'bob', expires: 99 },
    { kind: 'admit', from: 'ann', by: 'system', invite: 'i1', name: 'bob', link: 'k1' },
  ]);
  assert.equal(s.recent.length, BRIEF_RECENT);
  assert.equal(s.recent[0]?.kind === 'finding' && s.recent[0].text, 'f5');
  assert.deepEqual({ ...s, recent: [] }, { ...state([]), seq: BRIEF_RECENT + 7, hash: `h${BRIEF_RECENT + 7}` });
});

test('lines already in the snapshot are skipped, and inputs are never mutated', () => {
  const lines = log([{ kind: 'joined', from: 'ann' }, { kind: 'finding', from: 'ann', text: 'x' }]);
  const frozen = JSON.stringify(lines);
  const snap = takeSnapshot(fold(null, lines, NO_DOCS));
  const again = fold(snap, lines, NO_DOCS);
  assert.deepEqual(again, fold(null, lines, NO_DOCS));
  assert.equal(JSON.stringify(lines), frozen);
});

test('snapshotDue every N entries', () => {
  assert.equal(snapshotDue(499, 0), false);
  assert.equal(snapshotDue(500, 0), true);
  assert.equal(snapshotDue(12, 10, 2), true);
  assert.equal(snapshotDue(11, 10, 2), false);
});

// A seeded generator of plausible logs, for the snapshot property.
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 2 ** 32; };
}

function randomLog(r: () => number, n: number): Body[] {
  const pick = <T>(xs: readonly [T, ...T[]]): T => xs[Math.floor(r() * xs.length)] ?? xs[0];
  // every optional field, present about half the time
  const maybe = <T extends object>(fields: T): Partial<T> => (r() < 0.5 ? fields : {});
  const people: [string, ...string[]] = ['ann', 'bob', 'cy'];
  const latest = new Map<string, number>();
  const out: Body[] = [];
  for (let i = 0; i < n; i++) {
    const from = pick(people);
    const machine = pick(['m1', 'm2']);
    const name = pick(['api', 'ui']);
    const last = latest.get(name) ?? 0;
    const v = Math.max(1, last - Math.floor(r() * 2));
    const where = { ...maybe({ repo: pick(['web', 'api']) }), ...maybe({ branch: pick(['main', 'feat']) }) };
    const make: [() => Body, ...(() => Body)[]] = [
      () => ({ kind: 'joined', from, machine, ...where }),
      () => ({ kind: 'left', from, machine }),
      () => ({ kind: 'finding', from, by: 'claude', text: `found ${i}` }),
      () => ({ kind: 'post', from, by: pick(['person', 'claude'] as const), text: `post ${i}`, ...maybe({ to: pick(people) }) }),
      () => ({ kind: 'activity', from, event: pick(['commit', 'test'] as const), text: 'npm test', ...maybe({ ok: r() < 0.5 }), ...where }),
      () => {
        const version = r() < 0.9 ? last + 1 : last + 2; // now and then a version the host would refuse
        if (version === last + 1) latest.set(name, version);
        return { kind: 'plan', from, name, version, hash: `p${i}`, base: last, scope: pick(['group', 'personal'] as const) };
      },
      () => ({ kind: 'plan_ask', from, name, version: v, people: [pick(people), pick(people)] }),
      () => ({ kind: 'plan_answer', from, name, version: v, answer: pick(['agree', 'changes'] as const), ...maybe({ note: `n${i}` }) }),
      () => ({ kind: 'decision', from, by: 'system', name, version: v, agreed: [from], changes: r() < 0.5 ? [] : [pick(people)] }),
      () => ({ kind: 'plan_sent', from, name, version: v, files: r() < 0.5 ? [] : ['a.ts'], ...maybe({ to: pick(people) }), ...maybe({ branch: 'feat' }), ...maybe({ note: `n${i}` }) }),
      () => ({ kind: 'plan_accept', from, name, version: v, answer: pick(['accept', 'dismiss', 'changes'] as const), ...maybe({ note: `n${i}` }) }),
      () => ({
        kind: 'task', from, by: 'system',
        task: task(1 + Math.floor(r() * 4), {
          status: pick(['open', 'claimed', 'done'] as const), blockedBy: r() < 0.5 ? [] : [1],
          ...maybe({ owner: pick(people) }), ...maybe({ note: `n${i}` }), ...maybe({ plan: { name, version: v } }),
        }),
      }),
    ];
    out.push(r() < 0.03 ? { kind: 'kick', from, by: 'system', name: pick(['ann', 'bob', 'cy', 'dan']) } : pick(make)());
  }
  return out;
}

test('a snapshot plus the rest of the log folds to the same state as the whole log', () => {
  const docs: Docs = { presence: [{ name: 'ann', state: 'working', at: 1 }], activity: [], focus: [{ name: 'bob', text: 'ui', at: 1 }] };
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const lines = log(randomLog(r, 20 + Math.floor(r() * 120)));
    const whole = fold(null, lines, docs);
    for (const k of [0, 1, Math.floor(lines.length / 3), Math.floor(lines.length / 2), lines.length - 1, lines.length]) {
      const snap = takeSnapshot(fold(null, lines.slice(0, k), docs));
      const read = decodeSnapshot(JSON.parse(JSON.stringify(snap)));
      assert.ok(read.ok, read.ok ? '' : read.error);
      assert.deepEqual(fold(read.value, lines.slice(k), docs), whole, `seed ${seed}, split ${k}`);
    }
  }
});
