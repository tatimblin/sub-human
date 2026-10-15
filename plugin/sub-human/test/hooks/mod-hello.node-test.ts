// hooks/handlers/mod-hello.ts's lease: the module's $.process children are claude's own, so the lease names the parent.
// (The printed hello is covered in test/mod-core.node-test.ts.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { World } from './helpers.ts';
import { pidStart } from '../../lib/lock.ts';
import * as identityLib from '../../lib/identity.ts';

test('mod-hello: the lease records the parent claude pid, its start time and the module\'s nonce, and only the documented fields', t => {
  const w = new World({ claude: 'sleep' }, { t });
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
  assert.equal(w.lib(() => identityLib.modLeaseOk(sid, process.pid, Date.now() + 86_400_000)), true);
});
