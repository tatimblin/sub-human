import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from './config.js';

test('defaults with no knob set', () => {
  assert.deepEqual(readConfig({}, '/u'), { home: '/u/.sub-human', invite: 'public', port: 0, off: [], problems: [] });
});

test('each of the six knobs is read', () => {
  assert.deepEqual(readConfig({
    SUB_HUMAN_HOME: '/h', SUB_HUMAN_NAME: 'alice', SUB_HUMAN_INVITE: 'ssh', SUB_HUMAN_SSH_ADDR: 'me@devbox',
    SUB_HUMAN_PORT: '7466', SUB_HUMAN_CC_OFF: 'wake, tasks-bridge',
  }, '/u'), { home: '/h', name: 'alice', invite: 'ssh', sshAddr: 'me@devbox', port: 7466, off: ['wake', 'tasks-bridge'], problems: [] });
});

test('a value a knob can\'t take keeps the default and is a problem for doctor; blank is unset', () => {
  const c = readConfig({ SUB_HUMAN_INVITE: 'pigeon', SUB_HUMAN_PORT: '70000', SUB_HUMAN_CC_OFF: 'wake,nope,core', SUB_HUMAN_NAME: ' ' }, '/u');
  assert.equal(c.invite, 'public');
  assert.equal(c.port, 0);
  assert.deepEqual(c.off, ['wake']);
  assert.equal(c.name, undefined);
  assert.deepEqual(c.problems, [
    'SUB_HUMAN_INVITE=pigeon is not public, tailnet or ssh; public is used',
    'SUB_HUMAN_PORT=70000 is not a port; one is picked',
    'SUB_HUMAN_CC_OFF names nope; only wake, messages, tasks-bridge, invite-band can be turned off',
    'SUB_HUMAN_CC_OFF names core; only wake, messages, tasks-bridge, invite-band can be turned off',
  ]);
});
