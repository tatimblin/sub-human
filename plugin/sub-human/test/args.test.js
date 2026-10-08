'use strict';
// lib/cli/args.js: the one flag parser scripts/sub-human, lib/cli/*.js and the join hook's host flags share.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./helpers.js');
const { parse } = require(path.join(h.LIB, 'cli', 'args.js'));

test('args.parse: values, switches, optional values, the rest in order, and -- ends the flags', () => {
  assert.deepEqual(parse(['a', '--room', 'vole-1', 'b', '--json'], { room: 1, json: 0 }), { flags: { room: 'vole-1', json: true }, rest: ['a', 'b'] });
  assert.deepEqual(parse(['--ssh', '--via', 'j'], { ssh: '?', via: 1 }), { flags: { ssh: true, via: 'j' }, rest: [] });
  assert.deepEqual(parse(['--ssh', 'me@box', '--x'], { ssh: '?' }), { flags: { ssh: 'me@box' }, rest: ['--x'] }, 'an unknown flag is rest');
  assert.deepEqual(parse(['--room', '--json'], { room: 1, json: 0 }).flags.room, '--json', 'a value is the next argument, whatever it is');
  assert.deepEqual(parse(['--', '--room', 'x'], { room: 1 }), { flags: {}, rest: ['--room', 'x'] });
  assert.equal(parse(['--room'], { room: 1 }).error, '--room needs a value');
  assert.deepEqual(parse(['--constructor'], {}).rest, ['--constructor'], 'only the spec\'s own names');
});
