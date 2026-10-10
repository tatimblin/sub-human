#!/usr/bin/env node
'use strict';
/**
 * scripts/vendor-noble.js: (re)vendor the ristretto255 group of @noble/curves and the SHA-512 it imports from
 * @noble/hashes into plugin/sub-human/lib/vendor/noble/, from the npm tarballs, so a reviewer can reproduce it.
 *
 *   node scripts/vendor-noble.js CURVES.tgz HASHES.tgz     (npm pack @noble/curves@2.4.0 @noble/hashes@2.4.0)
 *
 * Each tarball must match the sha512 integrity npm publishes (pinned below), or nothing is written. Only the import
 * closure of curves/ed25519.js is copied, byte for byte, except that a bare `@noble/hashes/X` import becomes the
 * relative path of the vendored copy (no node_modules in the plugin). MANIFEST.json records, per file, the sha256 of
 * the vendored bytes and of the upstream bytes, and the rewrites; test/vendor-noble.test.js checks both, so an edit
 * by hand fails the tests. No dependency is installed.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PINS = {
  '@noble/curves': { version: '2.4.0', integrity: 'sha512-P4/62zrgfH33CneE3Dn4WhJVA22YUU0eR51wKIan4NVRvwsA0YnPTwWGpNbpuacSujmSFLvyzpyuR30+fbq2Ew==' },
  '@noble/hashes': { version: '2.4.0', integrity: 'sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==' },
};
const OUT = path.join(__dirname, '..', 'plugin', 'sub-human', 'lib', 'vendor', 'noble');
const ENTRY = 'curves/ed25519.js';

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const integrity = b => `sha512-${crypto.createHash('sha512').update(b).digest('base64')}`;

function unpack(tgz, name) {
  const bytes = fs.readFileSync(tgz);
  if (integrity(bytes) !== PINS[name].integrity) throw new Error(`${tgz}: not the published ${name}@${PINS[name].version} (integrity differs)`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-noble-'));
  const r = spawnSync('tar', ['xzf', path.resolve(tgz), '-C', dir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`tar failed on ${tgz}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package', 'package.json'), 'utf8'));
  if (pkg.name !== name || pkg.version !== PINS[name].version) throw new Error(`${tgz} holds ${pkg.name}@${pkg.version}`);
  return path.join(dir, 'package');
}

function main([curvesTgz, hashesTgz]) {
  if (!curvesTgz || !hashesTgz) { console.error('usage: node scripts/vendor-noble.js CURVES.tgz HASHES.tgz'); return 2; }
  const roots = { curves: unpack(curvesTgz, '@noble/curves'), hashes: unpack(hashesTgz, '@noble/hashes') };
  const files = new Map(); // vendored rel path -> {upstream bytes, out bytes, rewrites}
  const IMPORT = /((?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*)(['"])([^'"]+)\2/g;
  const walk = rel => {
    if (files.has(rel)) return;
    const [pkg, ...rest] = rel.split('/');
    const upstream = fs.readFileSync(path.join(roots[pkg], ...rest));
    let text = upstream.toString('utf8');
    const rewrites = [];
    const deps = [];
    text = text.replace(IMPORT, (all, head, q, spec) => {
      let target, to = spec;
      if (spec.startsWith('.')) target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      else {
        const m = /^@noble\/(hashes|curves)\/(.+)$/.exec(spec);
        if (!m) throw new Error(`${rel}: an import of ${spec}`);
        target = `${m[1]}/${m[2]}`;
        to = path.posix.relative(path.posix.dirname(rel), target);
        if (!to.startsWith('.')) to = `./${to}`;
        rewrites.push([spec, to]);
      }
      deps.push(target);
      return `${head}${q}${to}${q}`;
    });
    files.set(rel, { upstream, out: Buffer.from(text, 'utf8'), rewrites });
    deps.forEach(walk);
  };
  walk(ENTRY);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = { packages: PINS, entry: ENTRY, note: 'Unmodified upstream files of the import closure of curves/ed25519.js; bare @noble/hashes imports point at the vendored copy (rewrites). Regenerate with scripts/vendor-noble.js.', files: {} };
  for (const [rel, f] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    fs.mkdirSync(path.join(OUT, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(OUT, rel), f.out);
    manifest.files[rel] = { sha256: sha256(f.out), upstream_sha256: sha256(f.upstream), ...(f.rewrites.length ? { rewrites: f.rewrites } : {}) };
  }
  for (const pkg of ['curves', 'hashes']) {
    const lic = fs.readFileSync(path.join(roots[pkg], 'LICENSE'));
    fs.writeFileSync(path.join(OUT, pkg, 'LICENSE'), lic);
    manifest.files[`${pkg}/LICENSE`] = { sha256: sha256(lic), upstream_sha256: sha256(lic) };
  }
  fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`vendored ${files.size} files into ${path.relative(process.cwd(), OUT)}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
