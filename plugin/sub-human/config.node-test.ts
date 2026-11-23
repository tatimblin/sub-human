import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from './config.js';

test('defaults with no knob set', () => {
  assert.deepEqual(readConfig({}, '/u'), { home: '/u/.sub-human', invite: 'public', port: 0, debug: false, off: [], problems: [] });
});

test('each of the seven knobs is read', () => {
  assert.deepEqual(readConfig({
    SUB_HUMAN_HOME: '/h', SUB_HUMAN_NAME: 'alice', SUB_HUMAN_INVITE: 'ssh', SUB_HUMAN_SSH_ADDR: 'me@devbox',
    SUB_HUMAN_PORT: '7466', SUB_HUMAN_DEBUG: '1', SUB_HUMAN_CC_OFF: 'wake, cards',
  }, '/u'), { home: '/h', name: 'alice', invite: 'ssh', sshAddr: 'me@devbox', port: 7466, debug: true, off: ['wake', 'cards'], problems: [] });
});

test('a value a knob can\'t take keeps the default and is a problem for doctor; blank is unset', () => {
  const c = readConfig({ SUB_HUMAN_INVITE: 'pigeon', SUB_HUMAN_PORT: '70000', SUB_HUMAN_CC_OFF: 'wake,nope', SUB_HUMAN_NAME: ' ', SUB_HUMAN_DEBUG: 'no' }, '/u');
  assert.equal(c.invite, 'public');
  assert.equal(c.port, 0);
  assert.deepEqual(c.off, ['wake']);
  assert.equal(c.name, undefined);
  assert.equal(c.debug, false);
  assert.deepEqual(c.problems, [
    'SUB_HUMAN_INVITE=pigeon is not public, tailnet or ssh; public is used',
    'SUB_HUMAN_PORT=70000 is not a port; one is picked',
    'SUB_HUMAN_CC_OFF names nope, which is not a feature',
  ]);
});
