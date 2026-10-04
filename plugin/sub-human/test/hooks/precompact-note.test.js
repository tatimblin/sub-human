'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, fixture, identity, ctx, hso, roomPlan } = require('./helpers.js');

test('precompact-note: names the members and the current plan hash', () => {
  const w = new World({ orch: 'act', alice: 'sleep', bob: 'sleep' });
  const h = w.publish(roomPlan(w.code, ['alice', 'bob']), ['alice', 'bob']);
  w.sign('alice', h);
  const r = w.hook('precompact-note', fixture('precompact'), { as: 'orch' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^SUB-HUMAN COMPACTION RULES/);
  assert.match(r.stdout, /orch \(orchestrator\), alice, bob/);
  assert.match(r.stdout, new RegExp(`plan ${h}, approvers alice and bob; signed by alice`));
});
