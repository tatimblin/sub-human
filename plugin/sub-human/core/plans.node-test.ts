import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Draft, Entry, LogLine, RoomState, Task } from './entries.js';
import { NO_DOCS } from './entries.js';
import { fold } from './fold.js';
import type { Result } from './result.js';
import { decodeEntry } from './schema.js';
import { accept, answer, applyPlan, ask, decide, edit, latestVersion, parts, send } from './plans.js';

/**
 * A room whose rules' entries are stamped, decoded and folded, so every test also checks that each entry a rule writes
 * is one the schema reads and that fold keeps it.
 */
function room(members: readonly string[]) {
  const lines: LogLine[] = [];
  const blobs = new Map<string, string>();
  const texts = (hash: string) => blobs.get(hash) ?? '';
  const state = (): RoomState => fold(null, lines, NO_DOCS);
  const append = (r: Result<Draft[]> | Draft[]): Draft[] => {
    const drafts = Array.isArray(r) ? r : r.ok ? r.value : assert.fail(r.error);
    for (const d of drafts) {
      const seq = lines.length + 1;
      const entry: Entry = { ...d, seq, id: `e${seq}`, at: seq, prev: seq > 1 ? `h${seq - 1}` : '', machine: 'm1' };
      const read = decodeEntry(JSON.parse(JSON.stringify(entry)));
      assert.ok(read.ok, read.ok ? '' : `${d.kind}: ${read.error}`);
      lines.push({ entry, hash: `h${seq}` });
    }
    return drafts;
  };
  for (const from of members) append([{ kind: 'joined', from, by: 'system' }]);
  const put = (from: string, name: string, base: number, text: string) => {
    blobs.set(`#${text}`, text);
    return edit(state(), { name, base, hash: `#${text}`, from });
  };
  /** ann asks `people` about the latest version and each agrees, in order; returns the last answer's entries. */
  const agree = (name: string, people: readonly string[]) => {
    const version = latestVersion(state(), name)?.version ?? 0;
    append(ask(state(), { name, version, people, from: 'ann' }));
    return people.map(from => append(answer(state(), { name, version, from, answer: 'agree' }, texts))).at(-1) ?? [];
  };
  return { state, append, texts, put, agree };
}

const refusal = (r: Result<unknown>): string => (r.ok ? 'ok' : r.error);
const kinds = (ds: readonly Draft[]) => ds.map(d => d.kind);
const tasksOf = (s: RoomState) => s.tasks.map(t => [t.n, t.title, t.status, t.owner ?? '-', t.plan?.version ?? 0]);
const v1 = { name: 'api', version: 1 };

test('edit is compare-and-swap on base; a stale edit is refused and latestVersion gives what to merge', () => {
  const r = room(['ann', 'bob']);
  assert.deepEqual(r.append(r.put('ann', 'api', 0, 'v one')), [
    { kind: 'plan', from: 'ann', by: 'system', name: 'api', version: 1, hash: '#v one', base: 0, scope: 'group' },
  ]);
  r.append(r.put('bob', 'api', 1, 'v two'));
  assert.equal(refusal(r.put('ann', 'api', 1, 'v two bis')), 'Plan api was not stored: it is at v2, not v1; merge your edit into v2 and edit on base 2.');
  assert.deepEqual(latestVersion(r.state(), 'api'), { version: 2, hash: '#v two' });
  assert.equal(latestVersion(r.state(), 'web'), null);
  assert.equal(refusal(r.put('ann', 'api', 2, 'v two')), 'Plan api was not stored: v2 already has this text.');
  assert.equal(refusal(r.put('ann', 'new', 1, 'x')), 'Plan new was not stored: it is new, so edit it on base 0.');
  assert.equal(refusal(r.put('ann', ' ', 0, 'x')), "No plan was stored: a plan's name is 1 to 64 characters.");
  assert.equal(refusal(r.put('ann', 'n'.repeat(65), 0, 'x')), "No plan was stored: a plan's name is 1 to 64 characters.");
  assert.equal(refusal(edit(r.state(), { name: 'web', base: 0, hash: 'h'.repeat(1025), from: 'ann' })), 'Plan web was not stored: its text has no valid hash.');
  assert.deepEqual(r.state().plans[0]?.versions.map(v => [v.version, v.base, v.from]), [[1, 0, 'ann'], [2, 1, 'bob']]);
});

test('the first version\'s scope is the plan\'s', () => {
  const r = room(['ann']);
  r.append(edit(r.state(), { name: 'mine', base: 0, hash: 'a', from: 'ann', scope: 'personal' }));
  const [second] = r.append(edit(r.state(), { name: 'mine', base: 1, hash: 'b', from: 'ann', scope: 'group' }));
  assert.equal(second?.kind === 'plan' && second.scope, 'personal');
  assert.equal(r.state().plans[0]?.scope, 'personal');
});

test('ask names members and one exact version, the latest and undecided', () => {
  const r = room(['ann', 'bob', 'cy']);
  r.append(r.put('ann', 'api', 0, 'one'));
  assert.deepEqual(r.append(ask(r.state(), { name: 'api', version: 1, people: ['bob', 'ann', 'cy', 'bob'], from: 'ann' })),
    [{ kind: 'plan_ask', from: 'ann', by: 'claude', name: 'api', version: 1, people: ['bob', 'cy'] }]);
  r.append(r.put('ann', 'api', 1, 'two'));
  const rows: [Parameters<typeof ask>[1], string][] = [
    [{ name: 'web', version: 1, people: ['bob'], from: 'ann' }, 'Nobody was asked: there is no plan web.'],
    [{ name: 'api', version: 1, people: ['bob'], from: 'ann' }, 'Nobody was asked: api v1 is superseded by v2.'],
    [{ name: 'api', version: 3, people: ['bob'], from: 'ann' }, 'Nobody was asked: plan api has no v3.'],
    [{ name: 'api', version: 2, people: ['zed', 'bob', 'yu'], from: 'ann' }, 'Nobody was asked: zed, yu are not in the room.'],
    [{ name: 'api', version: 2, people: ['ann'], from: 'ann' }, 'Nobody was asked: name the people to ask.'],
  ];
  for (const [input, want] of rows) assert.equal(refusal(ask(r.state(), input)), want);
  const people = Array.from({ length: 257 }, (_, i) => `p${i}`);
  const many = room(['ann', ...people]);
  many.append(many.put('ann', 'api', 0, 'one'));
  assert.equal(refusal(ask(many.state(), { name: 'api', version: 1, people, from: 'ann' })), 'Nobody was asked: a version can ask at most 256 people.');
});

test('answers count for one version; a new version supersedes open asks; everyone named answering decides', () => {
  const r = room(['ann', 'bob', 'cy']);
  r.append(r.put('ann', 'api', 0, 'one'));
  r.append(ask(r.state(), { name: 'api', version: 1, people: ['bob', 'cy'], from: 'ann' }));
  const no = (a: Parameters<typeof answer>[1]) => refusal(answer(r.state(), a, r.texts));
  assert.equal(no({ name: 'api', version: 1, from: 'ann', answer: 'agree' }), 'Your answer was not recorded: you were not asked about api v1.');
  assert.equal(no({ name: 'api', version: 1, from: 'bob', answer: 'changes', note: ' ' }), 'Your answer was not recorded: asking for changes needs a note.');
  assert.equal(no({ name: 'api', version: 1, from: 'bob', answer: 'agree', note: 'x'.repeat(8001) }), 'Your answer was not recorded: the note is over 8000 characters.');
  assert.deepEqual(r.append(answer(r.state(), { name: 'api', version: 1, from: 'bob', answer: 'changes', note: ' cursor  paging ' }, r.texts)),
    [{ kind: 'plan_answer', from: 'bob', by: 'person', name: 'api', version: 1, answer: 'changes', note: ' cursor  paging ' }]);
  r.append(r.put('ann', 'api', 1, 'two'));
  assert.equal(no({ name: 'api', version: 1, from: 'cy', answer: 'agree' }), 'Your answer was not recorded: api v1 is superseded by v2.');
  r.append(ask(r.state(), { name: 'api', version: 2, people: ['bob', 'cy'], from: 'ann' }));
  assert.equal(r.append(answer(r.state(), { name: 'api', version: 2, from: 'bob', answer: 'changes', note: 'n' }, r.texts)).length, 1);
  assert.equal(r.append(answer(r.state(), { name: 'api', version: 2, from: 'bob', answer: 'agree' }, r.texts)).length, 1); // replaces
  const last = r.append(answer(r.state(), { name: 'api', version: 2, from: 'cy', answer: 'agree' }, r.texts));
  assert.deepEqual(last[1], { kind: 'decision', from: 'cy', by: 'system', name: 'api', version: 2, agreed: ['bob', 'cy'], changes: [] });
  assert.deepEqual(r.state().plans[0]?.versions[1]?.decision, { agreed: ['bob', 'cy'], changes: [], at: r.state().seq });
  assert.equal(no({ name: 'api', version: 2, from: 'cy', answer: 'agree' }), 'Your answer was not recorded: api v2 is already decided.');
  assert.equal(refusal(ask(r.state(), { name: 'api', version: 2, people: ['bob'], from: 'ann' })), 'Nobody was asked: api v2 is already decided.');
});

test('a decision with changes asked turns no owned part into a task', () => {
  const r = room(['ann', 'bob']);
  r.append(r.put('ann', 'api', 0, '## Store @ann\n## Handler @bob'));
  r.append(ask(r.state(), { name: 'api', version: 1, people: ['bob'], from: 'ann' }));
  const out = r.append(answer(r.state(), { name: 'api', version: 1, from: 'bob', answer: 'changes', note: 'split it' }, r.texts));
  assert.deepEqual(kinds(out), ['plan_answer', 'decision']);
  assert.deepEqual(r.state().tasks, []);
});

test('a kicked member who was asked never blocks the decision', () => {
  const r = room(['ann', 'bob', 'cy']);
  r.append(r.put('ann', 'api', 0, '## Store @bob'));
  r.append(ask(r.state(), { name: 'api', version: 1, people: ['bob', 'cy'], from: 'ann' }));
  r.append(answer(r.state(), { name: 'api', version: 1, from: 'bob', answer: 'agree' }, r.texts));
  assert.deepEqual(decide(r.state(), 'api', 'ann', r.texts), [], 'cy has not answered');
  r.append([{ kind: 'kick', from: 'ann', by: 'system', name: 'cy' }]);
  assert.deepEqual(kinds(r.append(decide(r.state(), 'api', 'ann', r.texts))), ['decision', 'task']);
  assert.deepEqual(decide(r.state(), 'api', 'ann', r.texts), [], 'decided once');

  const k = room(['ann', 'bob', 'cy']); // kicked before the last answer
  k.append(k.put('ann', 'api', 0, 'one'));
  k.append(ask(k.state(), { name: 'api', version: 1, people: ['bob', 'cy'], from: 'ann' }));
  k.append([{ kind: 'kick', from: 'ann', by: 'system', name: 'cy' }]);
  assert.equal(refusal(answer(k.state(), { name: 'api', version: 1, from: 'cy', answer: 'agree' }, k.texts)), 'Your answer was not recorded: you were not asked about api v1.');
  assert.deepEqual(kinds(k.append(answer(k.state(), { name: 'api', version: 1, from: 'bob', answer: 'agree' }, k.texts))), ['plan_answer', 'decision']);
});

test('parts: a heading or list item naming a member owns it; the rest is forgiven', () => {
  const members = ['tristan', 'jess', 'Bo'];
  const rows: [string, readonly [string, string, string][]][] = [
    ['## Part: Store (owner: tristan)', [['Store', 'Store (owner: tristan)', 'tristan']]],
    ['- @jess the HTTP handler', [['the HTTP handler', '@jess the HTTP handler', 'jess']]],
    ['3. Paging tests — owner: Jess', [['Paging tests', 'Paging tests — owner: Jess', 'jess']]],
    ['- [ ] **docs** @bo.', [['docs', 'docs @bo.', 'Bo']]],
    ['- [x] docs @bo', []],
    ['- @jess and @tristan pair on paging', [['@jess and @tristan pair on paging', '@jess and @tristan pair on paging', 'jess']]],
    ['### `listTasks` @zed @tristan', [['listTasks @zed', 'listTasks @zed @tristan', 'tristan']]],
    ['- call `@jess` from the handler', []],
    ['- `@jess` stub, then @tristan wires it', [['@jess stub, then wires it', '@jess stub, then @tristan wires it', 'tristan']]],
    ['- @jess', [["jess's part", '@jess', 'jess']]],
    ['Plain text naming @jess', []],
    ['- mail jess@example.com', []],
    ['- @room please look', []],
    ['```\n- @jess inside a fence\n```\n- @tristan outside', [['outside', '@tristan outside', 'tristan']]],
    ['- store @jess\n## store (owner: tristan)', [['store', 'store @jess', 'jess']]],
    [`- ${'x'.repeat(2000)} @jess`, [['x'.repeat(1024), 'x'.repeat(1024), 'jess']]],
  ];
  for (const [text, want] of rows) assert.deepEqual(parts(text, members).map(p => [p.title, p.line, p.owner]), want, text);
});

test('an agreed version claims parts for owners who agreed; anyone else gets an open task with their name', () => {
  const r = room(['ann', 'bob', 'cy']);
  r.append([{ kind: 'task', from: 'ann', by: 'system', task: { n: 1, title: 'other', status: 'open', addedBy: 'ann', blockedBy: [] } }]);
  r.append(r.put('ann', 'api', 0, '# api\n## Store @ann\n## Handler @bob\n## Docs @cy'));
  assert.deepEqual(kinds(r.agree('api', ['bob'])), ['plan_answer', 'decision', 'task', 'task', 'task']);
  const t = (n: number, title: string, owner?: string): Task =>
    ({ n, title, addedBy: 'ann', blockedBy: [], plan: v1, ...(owner ? { status: 'claimed', owner } : { status: 'open' }) });
  assert.deepEqual(r.state().tasks.slice(1), [t(2, 'Store', 'ann'), t(3, 'Handler', 'bob'), t(4, 'Docs @cy')]);
});

test('a later agreed version moves its tasks, never moves a claim, and releases the parts it drops', () => {
  const r = room(['ann', 'bob', 'cy']);
  r.append(r.put('ann', 'api', 0, '## Store @ann\n## Handler @bob\n## Docs @bob\n## Paging @bob\n## Notes @cy'));
  r.agree('api', ['bob']);
  assert.deepEqual(tasksOf(r.state()), [
    [1, 'Store', 'claimed', 'ann', 1], [2, 'Handler', 'claimed', 'bob', 1], [3, 'Docs', 'claimed', 'bob', 1],
    [4, 'Paging', 'claimed', 'bob', 1], [5, 'Notes @cy', 'open', '-', 1],
  ]);
  r.append([{ kind: 'task', from: 'bob', by: 'system', task: { n: 3, title: 'Docs', status: 'done', owner: 'bob', addedBy: 'ann', blockedBy: [], plan: v1 } }]);
  r.append([{ kind: 'task', from: 'cy', by: 'system', task: { n: 5, title: 'Notes @cy', status: 'claimed', owner: 'cy', addedBy: 'ann', blockedBy: [], plan: v1 } }]);
  // Store now names bob (ann holds it), Paging is renamed, Notes names cy, who is asked this time; Tests is new.
  r.append(r.put('ann', 'api', 1, '## Store @bob\n## Handler @bob\n## Docs @bob\n## Cursor paging @bob\n## Notes @cy\n## Tests @ann'));
  r.agree('api', ['bob', 'cy']);
  assert.deepEqual(tasksOf(r.state()), [
    [1, 'Store', 'claimed', 'ann', 2], [2, 'Handler', 'claimed', 'bob', 2], [3, 'Docs', 'done', 'bob', 1],
    [4, 'Paging', 'open', '-', 1], [5, 'Notes', 'claimed', 'cy', 2], [6, 'Cursor paging', 'claimed', 'bob', 2], [7, 'Tests', 'claimed', 'ann', 2],
  ]);
});

test('send packs a version for one member or the room; the recipient accepts, dismisses or asks for changes', () => {
  const r = room(['ann', 'bob', 'cy']);
  r.append(r.put('ann', 'mine', 0, 'one'));
  r.append(r.put('ann', 'mine', 1, 'two'));
  assert.deepEqual(r.append(send(r.state(), { name: 'mine', from: 'ann', to: 'bob', branch: 'feat', files: ['a.ts', 'a.ts'], note: ' see a.ts ' })), [
    { kind: 'plan_sent', from: 'ann', by: 'person', name: 'mine', version: 2, to: 'bob', branch: 'feat', files: ['a.ts'], note: ' see a.ts ' },
  ]);
  const files = 'No plan was sent: it can name at most 1000 files of 1024 characters.';
  const rows: [Parameters<typeof send>[1], string][] = [
    [{ name: 'web', from: 'ann' }, 'No plan was sent: there is no plan web.'],
    [{ name: 'mine', version: 3, from: 'ann' }, 'No plan was sent: plan mine has no v3.'],
    [{ name: 'mine', from: 'ann', to: 'ann' }, "No plan was sent: you can't send a plan to yourself."],
    [{ name: 'mine', from: 'ann', to: 'zed' }, 'No plan was sent: zed is not in the room.'],
    [{ name: 'mine', from: 'ann', files: ['f'.repeat(1025)] }, files],
    [{ name: 'mine', from: 'ann', files: Array.from({ length: 1001 }, (_, i) => `f${i}`) }, files],
    [{ name: 'mine', from: 'ann', branch: 'b'.repeat(1025) }, 'No plan was sent: the branch name is over 1024 characters.'],
    [{ name: 'mine', from: 'ann', note: 'n'.repeat(8001) }, 'No plan was sent: the note is over 8000 characters.'],
  ];
  for (const [input, want] of rows) assert.equal(refusal(send(r.state(), input)), want);

  const no = (a: Parameters<typeof accept>[1]) => refusal(accept(r.state(), a));
  assert.equal(no({ name: 'mine', version: 2, from: 'cy', answer: 'accept' }), 'Your answer was not recorded: nobody sent you mine v2.');
  assert.equal(no({ name: 'mine', version: 2, from: 'ann', answer: 'accept' }), 'Your answer was not recorded: nobody sent you mine v2.');
  assert.equal(no({ name: 'mine', version: 2, from: 'bob', answer: 'changes' }), 'Your answer was not recorded: asking for changes needs a note.');
  r.append(accept(r.state(), { name: 'mine', version: 2, from: 'bob', answer: 'changes', note: 'split it' }));
  r.append(accept(r.state(), { name: 'mine', version: 2, from: 'bob', answer: 'accept' }));
  assert.deepEqual(r.state().sent[0]?.answers, [{ name: 'bob', answer: 'accept' }]);

  r.append(send(r.state(), { name: 'mine', version: 1, from: 'ann' })); // to the room
  r.append(accept(r.state(), { name: 'mine', version: 1, from: 'cy', answer: 'dismiss' }));
  assert.deepEqual(r.state().sent.find(x => x.version === 1)?.answers, [{ name: 'cy', answer: 'dismiss' }]);
});

test('applyPlan, the host\'s one way to apply a plan act: a stranger is refused, a stale edit is an answer, an answer decides', () => {
  const r = room(['ann', 'bob']);
  const none = () => '';
  assert.deepEqual(applyPlan(r.state(), { act: 'ask', code: 'c1', from: 'zed', name: 'p', version: 1, people: ['bob'] }, '', none), { ok: false, error: 'zed is not in c1; nothing was written' });
  const first = applyPlan(r.state(), { act: 'edit', code: 'c1', from: 'ann', name: 'p', base: 0, text: 'one' }, '#one', none);
  assert.ok(first.ok && 'drafts' in first.value);
  r.append(first.value.drafts);
  assert.deepEqual(applyPlan(r.state(), { act: 'edit', code: 'c1', from: 'bob', name: 'p', base: 0, text: 'two' }, '#two', none),
    { ok: true, value: { refused: 'Plan p was not stored: it is at v1, not v0; merge your edit into v1 and edit on base 1.' } });
  const asked = applyPlan(r.state(), { act: 'ask', code: 'c1', from: 'ann', name: 'p', version: 1, people: ['bob'] }, '', none);
  assert.ok(asked.ok && 'drafts' in asked.value);
  r.append(asked.value.drafts);
  const agreed = applyPlan(r.state(), { act: 'answer', code: 'c1', from: 'bob', name: 'p', version: 1, answer: 'agree' }, '', none);
  assert.ok(agreed.ok && 'drafts' in agreed.value);
  assert.deepEqual(agreed.value.drafts.map(d => d.kind), ['plan_answer', 'decision']);
});
