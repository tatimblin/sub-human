import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { machineId, machineKey, machineKeyFile } from './keys.js';
import { keyPair } from './net/channel.js';
import { tempHome } from './test/support/command-ctx.js';

test('the machine key is made once, kept 0600, and read back the same', async () => {
  const home = tempHome();
  const a = await machineKey(home);
  assert.ok(a.ok);
  assert.equal(fs.statSync(machineKeyFile(home)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${home}/keys`).mode & 0o777, 0o700);
  const b = await machineKey(home);
  assert.ok(b.ok);
  assert.deepEqual(b.value.pub, a.value.pub);
  assert.deepEqual(keyPair(b.value.priv).pub, a.value.pub);
  assert.deepEqual(fs.readdirSync(`${home}/keys`), ['machine.key']);
});

test('first uses at once all get the one key that won', async () => {
  const home = tempHome();
  const keys = await Promise.all(Array.from({ length: 8 }, () => machineKey(home)));
  const ids = new Set(keys.map(k => (k.ok ? machineId(k.value.pub) : k.error)));
  assert.equal(ids.size, 1);
  assert.match([...ids][0] ?? '', /^[0-9a-f]{16}$/);
});

test('a key others can read, or one that is not a key, is refused with what to do', async () => {
  const home = tempHome();
  await machineKey(home);
  fs.chmodSync(machineKeyFile(home), 0o644);
  assert.deepEqual(await machineKey(home), { ok: false, error: `the machine key in ${machineKeyFile(home)} can be read by others; run chmod 600 on it` });
  fs.writeFileSync(machineKeyFile(home), 'junk', { mode: 0o600 });
  const r = await machineKey(home);
  assert.ok(!r.ok && r.error.includes('is not readable'));
});
