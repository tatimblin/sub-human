'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, fixture, identity, ctx, hso, roomPlan } = require('./helpers.js');

test('plan-backup: a local plan is copied aside before a room stub replaces it', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const f = path.join(w.userHome, '.claude', 'plans', 'task-snug-rocket.md');
  fs.writeFileSync(f, '# My local plan\n1. refactor\n');
  const stub = `---\nsub-human: {"room":"${w.code}","review":"abcdefabcdef"}\n---\nReview.\n`;
  const input = { ...fixture('pre-write'), tool_input: { file_path: f, content: stub } };
  const r = w.hook('plan-backup', input, { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(hso(r).permissionDecision, undefined, 'no opinion on the write itself');
  const backups = fs.readdirSync(w.memberDir('alice')).filter(n => n.startsWith('local-plan-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(w.memberDir('alice'), backups[0]), 'utf8'), '# My local plan\n1. refactor\n');
  assert.match(ctx(r), /backed up to/);

  // Edit that introduces the marker
  fs.writeFileSync(f, '# Another\n');
  w.hook('plan-backup', { ...input, tool_name: 'Edit', tool_input: { file_path: f, old_string: '# Another\n', new_string: stub } }, { as: 'alice' });
  assert.equal(fs.readdirSync(w.memberDir('alice')).filter(n => n.startsWith('local-plan-')).length, 2);
});

test('plan-backup: no backup when the old file is already a room plan, the new one is not, or it is outside plans/', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const f = path.join(w.userHome, '.claude', 'plans', 'p.md');
  const stub = `---\nsub-human: {"room":"${w.code}","review":"abcdefabcdef"}\n---\n`;
  const run = (old, content, file = f) => {
    fs.writeFileSync(file, old);
    return w.hook('plan-backup', { ...fixture('pre-write'), tool_input: { file_path: file, content } }, { as: 'alice' });
  };
  assert.equal(run(roomPlan(w.code, ['alice']), stub).stdout, '');
  assert.equal(run('# local\n', '# local v2\n').stdout, '');
  assert.equal(run('# local\n', stub, path.join(w.cwd, 'notes.md')).stdout, '');
  const orch = new World({ orch: 'act' });
  fs.writeFileSync(f, '# local\n');
  assert.equal(orch.hook('plan-backup', { ...fixture('pre-write'), tool_input: { file_path: f, content: stub } }, { as: 'orch' }).stdout, '');
});
