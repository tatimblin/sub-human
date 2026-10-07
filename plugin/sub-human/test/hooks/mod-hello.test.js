'use strict';
// hooks/mod-hello.js's lease: the module's $.process children are claude's own, so the lease names the parent.
// (The printed hello is covered in test/mod-core.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, PLUGIN } = require('./helpers.js');
const { pidStart } = require(path.join(PLUGIN, 'lib', 'lock.js'));

test('mod-hello: the lease records the parent claude pid, its start time and the module\'s nonce, and only the documented fields', t => {
  const w = new World({ orch: 'sleep' }, { t });
  const sid = '0b9c6f8e-1111-4222-8333-444455557777';
  const nonce = '0123456789abcdef'.repeat(2);
  const r = w.hook('mod-hello', { session_id: sid, nonce }); // our process is the hook's parent, as claude is the module's
  assert.equal(r.code, 0, r.stderr);
  const file = path.join(w.home, 'sessions', 'mods', `${sid}.json`);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.pid, process.pid);
  assert.equal(rec.pid_start, pidStart(process.pid));
  assert.equal(rec.nonce, nonce);
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'nonce', 'pid', 'pid_start', 'session_id']);
  // a nonce that is not 32 hex characters is not kept: at-room then believes no origin for the session
  for (const bad of ['short', 'X'.repeat(32), 42]) {
    w.hook('mod-hello', { session_id: sid, nonce: bad });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nonce, undefined, String(bad));
  }
  assert.equal(w.lib(() => require(path.join(PLUGIN, 'lib', 'identity.js')).modLeaseOk(sid, process.pid, Date.now() + 86_400_000)), true);
});
