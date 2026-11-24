// plans-cards.ts: a plan's short name, from its first heading, and a free one for a plan of mine (R18).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Plan, RoomState } from '../core/entries.js';
import { freeName, planName } from './plans-cards.js';

test('a plan is named by its first three meaningful words, at most 24 characters, stop words left out (R18)', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['# Finish webography: click a row to expand\n- more', 'finish-webography-click'],
    ['## Cursor paging', 'cursor-paging'],
    ['# Plan: the cursor paging for the store', 'cursor-paging-store'],
    ['intro line\n# Add an index to the tasks table', 'add-index-tasks'],
    ['# Internationalization overhaul everywhere', 'internationalization'], // a second word would pass 24
    ['# Supercalifragilisticexpialidocious', 'supercalifragilisticexpi'],
    ['# The plan', 'the-plan'], // all stop words: the words as they are
    ['no heading, just text', 'no-heading-just'],
    ['', 'plan'],
  ];
  for (const [text, name] of cases) {
    assert.equal(planName(text), name, text);
    assert.ok(planName(text).length <= 24);
  }
});

test('freeName: a taken name gets a number, kept within 24 characters; only the same plan file sends a plan of mine again', () => {
  const plan = (name: string, from: string, scope: Plan['scope'] = 'personal'): Plan =>
    ({ name, scope, versions: [{ version: 1, hash: 'h', base: 0, from, at: 0, asked: [], answers: [] }] });
  const s = (...plans: Plan[]): RoomState => ({ seq: 0, hash: '', members: [], plans, sent: [], tasks: [], recent: [] });
  const long = 'finish-webography-click'; // 23 characters
  const cases: readonly (readonly [string, RoomState, string, Plan['scope'], string | undefined, { name: string; base: number }])[] = [
    ['free', s(), 'paging', 'group', undefined, { name: 'paging', base: 0 }],
    ['taken by someone else', s(plan('paging', 'bob')), 'paging', 'personal', 'paging', { name: 'paging-2', base: 0 }],
    ['a different plan of mine is not its next version', s(plan('paging', 'ann')), 'paging', 'personal', undefined, { name: 'paging-2', base: 0 }],
    ['the same plan file sends it again', s(plan('paging', 'ann')), 'paging', 'personal', 'paging', { name: 'paging', base: 1 }],
    ['a room plan never does', s(plan('paging', 'ann', 'group')), 'paging', 'group', 'paging', { name: 'paging-2', base: 0 }],
    ['the number fits within 24', s(plan(long, 'bob')), long, 'group', undefined, { name: 'finish-webography-clic-2', base: 0 }],
  ];
  for (const [what, room, name, scope, again, want] of cases) {
    assert.deepEqual(freeName(room, name, 'ann', scope, again), want, what);
    assert.ok(freeName(room, name, 'ann', scope, again).name.length <= 24, what);
  }
});
