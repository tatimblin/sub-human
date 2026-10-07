'use strict';
// hooks/mod-hello.js's lease: the module's $.process children are claude's own, so the lease names the parent.
// (The printed hello is covered in test/mod-core.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, PLUGIN } = require('./helpers.js');
const { pidStart } = require(path.join(PLUGIN, 'lib', 'lock.js'));

test('mod-hello: the lease records the parent claude pid and its start time, and only the documented fields', t => {
  const w = new World({ orch: 'sleep' }, { t });
  const sid = '0b9c6f8e-1111-4222-8333-444455557777';
  const r = w.hook('mod-hello', { session_id: sid }); // our process is the hook's parent, as claude is the module's
  assert.equal(r.code, 0, r.stderr);
  const rec = JSON.parse(fs.readFileSync(path.join(w.home, 'sessions', 'mods', `${sid}.json`), 'utf8'));
  assert.equal(rec.pid, process.pid);
  assert.equal(rec.pid_start, pidStart(process.pid));
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'pid', 'pid_start', 'seat', 'session_id']);
  assert.equal(w.lib(() => require(path.join(PLUGIN, 'lib', 'identity.js')).modLeaseOk(sid, process.pid, Date.now() + 86_400_000)), true);
});
