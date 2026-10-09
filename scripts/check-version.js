#!/usr/bin/env node
'use strict';
/**
 * check-version: release discipline. Marketplace users get an update only when plugin.json `version` changes
 * (and background auto-update is off by default), so a plugin change that ships without a bump never reaches them.
 *
 *   node scripts/check-version.js [BASE]
 *       BASE (a git ref) defaults to the newest tag, else the last commit that changed plugin.json's version.
 *       Fails (exit 1) when files under plugin/sub-human/ differ between BASE and the working tree (tests and
 *       mod/test/ excluded: they do not ship behaviour) while the version is not greater than BASE's. Exit 0
 *       otherwise, with one line saying why. Exit 2 when git or plugin.json cannot be read.
 *   CI on a pull request passes the target branch: `node scripts/check-version.js origin/main`.
 *
 *   check({cwd?, base?}) -> {ok, base, from, to, changed: string[], why}   the same, for tests
 *   newer(a, b) -> bool   a > b, numeric per dot-separated part ("0.10.0" > "0.9.1"); a pre-release tail
 *                         after "-" compares as text
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MANIFEST = 'plugin/sub-human/.claude-plugin/plugin.json';
const PLUGIN = 'plugin/sub-human/';
const EXEMPT = /^plugin\/sub-human\/(?:test|mod\/test)\//;

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, args) => { try { return git(cwd, args); } catch { return ''; } };

const versionAt = (cwd, ref) => {
  const text = ref ? tryGit(cwd, ['show', `${ref}:${MANIFEST}`]) : fs.readFileSync(path.join(cwd, MANIFEST), 'utf8');
  return text ? JSON.parse(text).version : null;
};

/** The last commit whose plugin.json version differs from its parent's (the last release). */
function lastBump(cwd) {
  for (const sha of tryGit(cwd, ['log', '--format=%H', '--', MANIFEST]).split('\n').filter(Boolean)) {
    if (versionAt(cwd, sha) !== versionAt(cwd, `${sha}^`)) return sha;
  }
  return null;
}

function newer(a, b) {
  const [ma, pa = ''] = String(a).split('-', 2), [mb, pb = ''] = String(b).split('-', 2);
  const xa = ma.split('.').map(Number), xb = mb.split('.').map(Number);
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const d = (xa[i] || 0) - (xb[i] || 0);
    if (d) return d > 0;
  }
  if (pa === pb) return false;
  return !pa ? true : !pb ? false : pa > pb; // 1.0.0 > 1.0.0-rc.1
}

function check({ cwd = process.cwd(), base } = {}) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  base = base || tryGit(root, ['describe', '--tags', '--abbrev=0']) || lastBump(root);
  const to = versionAt(root, null);
  if (!base) return { ok: true, base: null, from: null, to, changed: [], why: 'no tag and no version bump yet: nothing to compare' };
  const from = versionAt(root, base);
  const changed = git(root, ['diff', '--name-only', base, '--', PLUGIN]).split('\n').filter(f => f && !EXEMPT.test(f));
  // files git does not track yet count too
  changed.push(...tryGit(root, ['ls-files', '--others', '--exclude-standard', '--', PLUGIN]).split('\n').filter(f => f && !EXEMPT.test(f)));
  if (!changed.length) return { ok: true, base, from, to, changed, why: `no plugin change since ${base}` };
  if (from && !newer(to, from)) {
    return { ok: false, base, from, to, changed, why: `plugin files changed since ${base} but version is ${to} (was ${from}): bump ${MANIFEST}` };
  }
  return { ok: true, base, from, to, changed, why: `version ${from || '(none)'} -> ${to}` };
}

module.exports = { check, newer };

if (require.main === module) {
  let r;
  try { r = check({ base: process.argv[2] }); } catch (e) { console.error(`check-version: ${e.message}`); process.exit(2); }
  if (r.ok) { console.log(`check-version: ok, ${r.why}`); process.exit(0); }
  console.error(`check-version: ${r.why}\n${r.changed.slice(0, 20).map(f => `  ${f}`).join('\n')}${r.changed.length > 20 ? `\n  … ${r.changed.length - 20} more` : ''}`);
  process.exit(1);
}
