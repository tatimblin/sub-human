// Opt-in (npm run test:remote-docker; not part of npm test): the sub-human lab's scenario suite (harness.ts scenarios:
// devbox, devbox-old 0.5.0-beta.15, bastion, joiner-a, joiner-b, toxiproxy, corp-proxy, tls-front; README.md). Skipped
// when Docker is not running. Passes unless a scenario FAILED (PENDING: a feature not built yet; BUG: a known plugin
// bug, fatal with LAB_STRICT=1). Evidence in LAB_OUT, else /tmp/sub-human-lab-<time>/. LAB_ONLY=id[,id] narrows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
const skip = docker.status !== 0 ? 'Docker is not running' : false;

test('sub-human lab: the remote rooms 1.0/1.1 scenarios', { skip, timeout: 900_000 }, async () => {
  const args = [path.join(import.meta.dirname, 'harness.ts'), 'scenarios', ...(process.env.LAB_OUT ? ['--out', process.env.LAB_OUT] : []), ...(process.env.LAB_ONLY ? ['--only', process.env.LAB_ONLY] : [])];
  const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  c.stdout.on('data', (d: Buffer) => { out += String(d); process.stdout.write(d); });
  const code = await new Promise<number | null>(r => c.on('exit', r));
  const tail = out.split('\n').slice(-40).join('\n');
  assert.equal(code, 0, tail);
  assert.match(out, /SCENARIOS OK: evidence in /);
});
