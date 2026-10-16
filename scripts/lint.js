#!/usr/bin/env node
'use strict';
/**
 * lint: npm run lint. Two parts, and it fails when either does:
 *   1. oxlint with its type-aware rules (oxlint-tsgolint, built on tsgo) over the repo (.oxlintrc.json). Its rules
 *      warn for now, so only a parse error or a rule set to "error" fails it.
 *   2. the ratchet (scripts/ts-ratchet.js): the type escapes per directory may not rise above scripts/ts-ratchet.json.
 *
 * tsgolint types each file by the nearest tsconfig.json whose project holds it, and takes no tsconfig of ours
 * (oxlint's --tsconfig is only for import resolution). Claude Code writes its own plugin/sub-human/tsconfig.json
 * (gitignored; it extends .claude-plugin/types/tsconfig.json, which holds hooks/ under bundler resolution and no node
 * types), which would win for hooks/ here and not in CI. So for the run that file is moved aside and put back.
 *
 *   node scripts/lint.js [oxlint args...]
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const GENERATED = path.join(REPO, 'plugin', 'sub-human', 'tsconfig.json');
const ASIDE = `${GENERATED}.lint-aside`;

function oxlint(args) {
  const moved = fs.existsSync(GENERATED) && !fs.existsSync(ASIDE);
  const restore = () => { if (moved && fs.existsSync(ASIDE)) fs.renameSync(ASIDE, GENERATED); };
  const onSignal = sig => { restore(); process.kill(process.pid, sig); };
  if (moved) {
    fs.renameSync(GENERATED, ASIDE);
    process.once('SIGINT', onSignal).once('SIGTERM', onSignal);
  }
  try {
    const bin = path.join(REPO, 'node_modules', '.bin', 'oxlint');
    return spawnSync(bin, ['--type-aware', ...args], { cwd: REPO, stdio: 'inherit' }).status ?? 1;
  } finally {
    restore();
    process.off('SIGINT', onSignal).off('SIGTERM', onSignal);
  }
}

function main(argv) {
  const lint = oxlint(argv);
  const ratchet = spawnSync(process.execPath, [path.join(__dirname, 'ts-ratchet.js')], { cwd: REPO, stdio: 'inherit' }).status ?? 1;
  return lint || ratchet;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
