// Closed unions: mod/core/never.ts assertNever ends every switch over one; the domain tables are the source of their
// unions (validate.ts, protocol.ts, link-state.ts, members.ts); validate.ts parseEntry narrows a log line by its kind,
// and a newer host's kind is no member: its readers show it as words and fold nothing from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNever } from '../mod/core/never.ts';
import * as validate from '../lib/room/validate.ts';
import * as protocol from '../lib/remote/protocol.ts';
import * as linkState from '../lib/room/link-state.ts';
import * as members from '../lib/room/members.ts';
import { chatLines } from '../lib/room/render.ts';
import { fold } from '../lib/room/consent.ts';
import { NO_TRUST } from '../lib/room/trust.ts';
import type { Entry, Kind, KnownKind, LegacyKind, LinkStateWord, PresenceState, TaskOp, Via } from '../lib/room/types.ts';
import type { EventData, EventName, Op, OpParams, OpResults } from '../lib/remote/types-core.ts';

// Compile-time: each union is exactly its table's words (npm run typecheck fails otherwise).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: true[] = [
  true satisfies Same<Kind, (typeof validate.KINDS)[number]>,
  true satisfies Same<Via, (typeof validate.VIAS)[number]>,
  true satisfies Same<TaskOp, (typeof validate.TASK_OPS)[number]>,
  true satisfies Same<LegacyKind, (typeof validate.LEGACY_KINDS)[number]>,
  true satisfies Same<EventName, keyof EventData>,
  true satisfies Same<Op, keyof OpParams>,
  true satisfies Same<Op, keyof OpResults>,
  true satisfies Same<LinkStateWord, (typeof linkState.STATE_WORDS)[number]>,
  true satisfies Same<PresenceState, (typeof members.PRESENCE_STATES)[number]>,
];

/** assertNever with a value the types say cannot come (a newer peer's, a lie): what it does at run time. */
const reach = (x: unknown, what: string): unknown => Reflect.apply(assertNever, undefined, [x, what]);

test('assertNever: throws, naming the union and the value no case took', () => {
  assert.equal(same.length, 9);
  assert.throws(() => reach('poll', 'entry kind'), /^Error: sub-human: unhandled entry kind: "poll"$/);
  assert.throws(() => reach({ type: 'later' }, 'link event'), /unhandled link event: \{"type":"later"\}/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => reach(cyclic, 'x'), /unhandled x: \[object Object\]/, 'a value JSON cannot show: String(x)');
  assert.throws(() => reach(undefined, 'x'), /unhandled x: undefined/);
});

test('tables: every kind is some via\'s, the guards accept exactly the table words', () => {
  assert.deepEqual([...validate.KINDS].sort(), [...new Set([...validate.AGENT_KINDS, ...validate.HUMAN_KINDS, ...validate.SYSTEM_KINDS])].sort());
  for (const k of validate.SYSTEM_ONLY_KINDS) assert.ok(validate.SYSTEM_KINDS.includes(k), k);
  const guards: [(x: unknown) => boolean, readonly string[]][] = [
    [validate.isKind, validate.KINDS], [validate.isVia, validate.VIAS], [validate.isTaskOp, validate.TASK_OPS],
    [protocol.isOp, protocol.OPS], [linkState.isState, linkState.STATE_WORDS], [members.isPresenceState, members.PRESENCE_STATES],
  ];
  for (const [is, words] of guards) {
    for (const w of words) assert.equal(is(w), true, w);
    for (const x of ['', 'SAY', 'poll', 'constructor', null, undefined, 1, {}]) assert.equal(is(x), false, JSON.stringify(x) ?? 'undefined');
  }
  for (const k of validate.LEGACY_KINDS) assert.equal(validate.isKind(k), false, `${k}: read, never written`);
  for (const ev of protocol.EVENTS) assert.equal(protocol.isEvent({ ev }), true, ev);
  assert.equal(protocol.isEvent({ ev: 'later' }), false);
  for (const w of linkState.STATE_WORDS) assert.ok(linkState.STATES.has(w), w);
  assert.equal(linkState.STATES.size, linkState.STATE_WORDS.length);
});

const at = '2026-10-16T00:00:00.000Z';
const entry = (kind: string, extra: Partial<Entry> = {}): Entry => ({ id: 1, at, from: 'bob', via: 'agent', kind, text: 'vote on lunch?', ...extra });

test('parseEntry: the entry itself (no copy) for every kind this version reads, null for a newer host\'s', () => {
  const known: KnownKind[] = [...validate.KINDS, ...validate.LEGACY_KINDS];
  for (const k of known) {
    const e = entry(k);
    assert.equal(validate.parseEntry(e), e, k);
  }
  for (const k of ['poll', 'reaction', '', 'Say', 'toString', '__proto__']) assert.equal(validate.parseEntry(entry(k)), null, k);
  const e: Entry = entry('say');
  if (validate.isKindOf(e, 'say')) assert.equal(e.kind, 'say');
  else assert.fail('isKindOf: a say is a say');
  assert.equal(validate.isKindOf(e, 'status'), false);
  assert.equal(validate.isKindOf(null, 'say'), false);
});

test('a newer host\'s kind: shown as its writer\'s words, as a say is; the fold takes nothing from it', () => {
  for (const extra of [{}, { to: 'alice' }, { via: 'human' }, { via: 'later' }]) {
    assert.deepEqual(chatLines(entry('poll', extra), { viewer: 'alice' }), chatLines(entry('say', extra), { viewer: 'alice' }), JSON.stringify(extra));
  }
  const hash = 'abcdef123456';
  const log: Entry[] = [
    { id: 1, at, from: 'alice', via: 'agent', kind: 'proposal', hash, text: `proposal ${hash}: lunch`, approvers: ['bob'] },
    { id: 2, at, from: 'bob', via: 'human', kind: 'poll', proposal_hash: hash },
    { id: 3, at, from: 'room', via: 'system', kind: 'verdict', proposal_hash: hash },
  ];
  const f = fold(log, NO_TRUST);
  assert.equal(f.proposals.get(hash)?.entry.hash, hash);
  assert.equal(f.answers.get(hash), undefined);
  assert.equal(f.decisions.has(hash), false);
  assert.deepEqual(f.matrix(hash).missing, ['bob']);
});
