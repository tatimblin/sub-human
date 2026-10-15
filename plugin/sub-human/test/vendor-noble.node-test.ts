// The vendored @noble code (lib/vendor/noble) is pinned: every file's sha256 is the one MANIFEST.json records, the
// manifest's upstream hash holds once the import rewrites are undone (so the code is upstream's, byte for byte), the
// pinned packages are the published ones, each package's LICENSE is there, and nothing unlisted sits in the folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as h from './helpers.ts';
import { ristretto255, ristretto255_hasher } from '../lib/vendor/noble/curves/ed25519.js';

const DIR = path.join(h.LIB, 'vendor', 'noble');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'MANIFEST.json'), 'utf8'));
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

function listed(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory()
    ? listed(path.join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]));
}

test('vendored noble: every file matches its pinned sha256, and upstream bytes once the import rewrites are undone', () => {
  assert.deepEqual(manifest.packages['@noble/curves'], { version: '2.4.0', integrity: 'sha512-P4/62zrgfH33CneE3Dn4WhJVA22YUU0eR51wKIan4NVRvwsA0YnPTwWGpNbpuacSujmSFLvyzpyuR30+fbq2Ew==' });
  assert.deepEqual(manifest.packages['@noble/hashes'], { version: '2.4.0', integrity: 'sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==' });
  for (const [rel, pin] of Object.entries(manifest.files)) {
    const bytes = fs.readFileSync(path.join(DIR, rel));
    assert.equal(sha256(bytes), pin.sha256, `${rel} changed since it was vendored`);
    let text = bytes.toString('utf8');
    for (const [from, to] of pin.rewrites || []) {
      for (const q of ["'", '"']) text = text.split(`from ${q}${to}${q}`).join(`from ${q}${from}${q}`);
    }
    assert.equal(sha256(Buffer.from(text, 'utf8')), pin.upstream_sha256, `${rel} is not upstream's code`);
    for (const [, to] of pin.rewrites || []) assert.ok(fs.existsSync(path.resolve(path.dirname(path.join(DIR, rel)), to)), `${rel} -> ${to}`);
  }
  assert.ok(manifest.files['curves/LICENSE'] && manifest.files['hashes/LICENSE'], 'each package\'s LICENSE is vendored');
  assert.match(fs.readFileSync(path.join(DIR, 'curves', 'LICENSE'), 'utf8'), /MIT License/);
  const extra = listed(DIR).filter(f => !manifest.files[f] && f !== 'MANIFEST.json' && f !== 'package.json');
  assert.deepEqual(extra, [], 'no unlisted file in the vendored folder');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8')), { type: 'module', private: true });
});

test('vendored noble loads from CommonJS (require of ESM) and gives ristretto255', () => {
  const P = ristretto255_hasher.deriveToCurve(new Uint8Array(64).fill(7));
  assert.equal(ristretto255.Point.fromBytes(P.toBytes()).equals(P), true);
});
