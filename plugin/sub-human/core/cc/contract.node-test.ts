// core/cc/contract.ts: the contract's schema and the pure matcher; and the committed contract against the snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseContract, check, probe, byFeature, binaryVersion, INTERNAL_CAP } from './contract.js';
import type { Contract, Entry, Fragment } from './contract.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const committed = (): Contract => {
  const r = parseContract(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'contract.json'), 'utf8')));
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.value;
};
type Api = Extract<Entry, { kind: 'api' }>;
type Internal = Extract<Entry, { kind: 'internal' }>;
const api = (typings: Fragment[], over: Partial<Api> = {}): Api =>
  ({ id: 'a', kind: 'api', feature: 'wake', surface: 's', checked: ['2.1.330'], note: 'n', typings, ...over });
const internal = (search: string[], unverified?: string): Internal => ({
  id: 'i', kind: 'internal', feature: 'messages', surface: 's', checked: [], note: 'n', search,
  reason: 'r', fallback: 'f', request: 'q', ...(unverified === undefined ? {} : { unverified }),
});
const file = (entries: unknown[]): unknown => ({ note: 'n', probed: '2.1.330', entries });

test('the committed contract: 18 to 24 entries, internals within the cap, each with its reason, fallback and request', () => {
  const c = committed();
  assert.ok(c.entries.length >= 18 && c.entries.length <= 24, `${c.entries.length} entries`);
  const internals = c.entries.filter(e => e.kind === 'internal');
  assert.ok(internals.length <= 4, `${internals.length} internal entries; ARCHITECTURE §9 estimates 2 to 4`);
  for (const e of internals) assert.ok(e.reason && e.fallback && e.request, e.id);
});

test('every api entry is in the committed typings snapshot, which probed wrote', () => {
  const c = committed();
  const dir = path.join(REPO, 'typings');
  const typings = ['claude-code', 'claude-code-tools'].map(r => fs.readFileSync(path.join(dir, r, 'index.d.ts'), 'utf8')).join('\n');
  assert.match(typings, new RegExp(`^// Written by Claude Code ${c.probed.replaceAll('.', '\\.')}\\.`));
  const failed = probe(c, { typings, binary: null }).filter(r => r.status === 'fail');
  assert.deepEqual(failed.map(r => `${r.id}: ${r.missing.join(' | ')}`), []);
});

test('parseContract refuses a duplicate id, an unknown feature or field, a verified internal with no search, too many internals', () => {
  assert.ok(parseContract(file([api(['x', { in: 'type X =', has: ['y'] }]), internal(['y'])])).ok);
  const bad: [string, unknown][] = [
    ['duplicate', file([api(['x']), api(['y'])])],
    ['feature', file([{ ...api(['x']), feature: 'telepathy' }])],
    ['field', file([{ ...api(['x']), extra: 1 }])],
    ['no search', file([internal([])])],
    ['non-ASCII search', file([internal(['sent \u2192 you'])])],
    ['no typings', file([api([])])],
    ['empty has', file([api([{ in: 'type X =', has: [] }])])],
    ['cap', file(Array.from({ length: INTERNAL_CAP + 1 }, (_, i) => ({ ...internal(['y']), id: `i${i}` })))],
    ['probed', { note: 'n', probed: 'latest', entries: [] }],
  ];
  for (const [what, json] of bad) assert.equal(parseContract(json).ok, false, what);
  assert.ok(parseContract(file([internal([], 'no string found')])).ok, 'an unverified internal needs no search');
  const r = parseContract(file([api(['x']), api(['y'])]));
  assert.ok(!r.ok && /unique/.test(r.error));
  const u = parseContract(file([internal(['caf\u00e9'])]));
  assert.ok(!u.ok && /ASCII/.test(u.error));
});

test('check, api: every fragment in the declarations, whitespace and comments aside', () => {
  const typings = `interface X {\n  open: (pane: PaneOpenArgs) =>\n      Promise<UiOpenResult>;\n  /**\n   * What the model reads.\n   */\n  // a note\n  close?: never;\n}`;
  assert.equal(check(api(['open: (pane: PaneOpenArgs) => Promise<UiOpenResult>; close?: never;']), { typings, binary: null }).status, 'pass');
  assert.equal(check(api(['What the model reads.']), { typings, binary: null }).status, 'fail', 'comments are not declarations');
  const r = check(api(['open: (pane: PaneOpenArgs) => Promise<UiOpenResult>;', 'close: () => void;']), { typings, binary: null });
  assert.deepEqual([r.status, r.missing], ['fail', ['close: () => void;']]);
  assert.equal(check(api(['x']), { typings: null, binary: 'x' }).status, 'skip', 'no typings read');
});

test('check, api {in, has}: each member inside its parent declaration, unions included, not a neighbour\'s', () => {
  const typings = [
    'export type SendResult = {\n  /** sent */\n  isDelivered: true;\n  reason?: undefined;\n} | {\n  isDelivered: false;\n  reason: string;\n};',
    'type Other = { isAborted: boolean; };',
    'type Fields = { answer: string; nested: { deep: number }; };',
  ].join('\n');
  const hay = { typings, binary: null };
  assert.equal(check(api([{ in: 'export type SendResult =', has: ['isDelivered: true;', 'isDelivered: false;'] }]), hay).status, 'pass');
  assert.equal(check(api([{ in: 'type Fields =', has: ['deep: number'] }]), hay).status, 'pass');
  const r = check(api([{ in: 'export type SendResult =', has: ['isAborted: boolean;'] }, { in: 'type Gone =', has: ['x'] }]), hay);
  assert.deepEqual(r.missing, ['isAborted: boolean; in export type SendResult =', 'no type Gone =']);
});

test('check, internal: each ASCII search string in the binary; unverified is skipped with why', () => {
  const binary = '\0\0plugin sent a message:\n\0"tengu_x",!0)\0';
  assert.equal(check(internal([' sent a message:\n', '"tengu_x",!0)']), { typings: null, binary }).status, 'pass');
  const r = check(internal(['"tengu_x",!1)']), { typings: null, binary });
  assert.deepEqual([r.status, r.missing], ['fail', ['"tengu_x",!1)']]);
  const u = check(internal([], 'the M1 kit test checks it'), { typings: null, binary });
  assert.equal(u.status, 'skip');
  assert.match(u.why ?? '', /unverified: the M1 kit test/);
  assert.equal(check(internal(['x']), { typings: 'x', binary: null }).status, 'skip', 'no binary read');
});

test('byFeature: totals and failed ids per feature', () => {
  const c = parseContract(file([api(['a'], { id: 'a1' }), api(['b'], { id: 'a2' }), { ...internal(['c']), id: 'i1' }]));
  assert.ok(c.ok);
  const results = probe(c.value, { typings: 'a', binary: 'c' });
  assert.deepEqual(byFeature(results), { wake: { total: 2, failed: ['a2'] }, messages: { total: 1, failed: [] } });
});

test('binaryVersion: the first VERSION literal, or null', () => {
  assert.equal(binaryVersion('\0README_URL:"u",VERSION:"2.1.330",BUILD_TIME:'), '2.1.330');
  assert.equal(binaryVersion('{VERSION:"2.2.0-beta.1"}'), '2.2.0-beta.1');
  assert.equal(binaryVersion('VERSION:"next"'), null);
  assert.equal(binaryVersion(''), null);
});
