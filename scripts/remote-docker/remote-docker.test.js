'use strict';
// Opt-in (npm run test:remote-docker; not part of npm test): remote rooms over real SSH against a devbox container
// behind toxiproxy, the joiner on this machine (scripts/remote-docker/harness.js run). Skipped when Docker is not
// running. The evidence bundle goes to SUB_HUMAN_PROOF_DIR, else /tmp/sub-human-remote-proof-<timestamp>.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
const skip = docker.status !== 0 ? 'Docker is not running' : false;

test('remote rooms over ssh: devbox + toxiproxy, the 11 anti-fallback assertions', { skip, timeout: 900_000 }, () => {
  const args = [path.join(__dirname, 'harness.js'), 'run', ...(process.env.SUB_HUMAN_PROOF_DIR ? ['--out', process.env.SUB_HUMAN_PROOF_DIR] : [])];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 880_000 });
  const tail = r.stdout.split('\n').slice(-40).join('\n');
  assert.equal(r.status, 0, tail);
  assert.match(r.stdout, /ALL PASS: evidence in /);
});
