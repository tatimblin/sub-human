#!/usr/bin/env node
/**
 * lint: npm run lint. Three parts, and it fails when any does:
 *   1. oxlint with its type-aware rules (oxlint-tsgolint, built on tsgo) over the repo (.oxlintrc.json). On the plugin
 *      and the scripts the type-safety rules are errors (no-explicit-any, no-non-null-assertion, the no-unsafe-*
 *      family, the promise rules, consistent-type-imports, ...): one fails the run. no-unsafe-type-assertion and
 *      prefer-nullish-coalescing, and the correctness category, warn.
 *   2. the ratchet (scripts/ts-ratchet.ts): the type escapes per directory may not rise above scripts/ts-ratchet.json.
 *      Lint bans `any` and `!` but not a cast, and allows a reasoned disable; the ratchet caps all three.
 *   3. directory-lint (scripts/directory-lint.ts): the plugin directory's review rules this plugin has tripped
 *      (permission answers a reviewer cannot read, computed command paths, inline programs, invisible characters,
 *      the checklist limits), over plugin/sub-human.
 *
 * tsgolint types each file by the nearest tsconfig.json whose project holds it, and takes no tsconfig of ours
 * (oxlint's --tsconfig is only for import resolution). Claude Code writes its own plugin/sub-human/tsconfig.json
 * (gitignored; it extends .claude-plugin/types/tsconfig.json, which holds hooks/ under bundler resolution and no node
 * types), which would win for hooks/ here and not in CI. So for the run that file is moved aside and put back.
 *
 *   node scripts/lint.ts [oxlint args...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const GENERATED = path.join(REPO, 'plugin', 'sub-human', 'tsconfig.json');
const ASIDE = `${GENERATED}.lint-aside`;

function oxlint(args: string[]): number {
  const moved = fs.existsSync(GENERATED) && !fs.existsSync(ASIDE);
  const restore = () => { if (moved && fs.existsSync(ASIDE)) fs.renameSync(ASIDE, GENERATED); };
  const onSignal = (sig: NodeJS.Signals): void => { restore(); process.kill(process.pid, sig); };
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

function main(argv: string[]): number {
  const lint = oxlint(argv);
  const ratchet = spawnSync(process.execPath, [path.join(import.meta.dirname, 'ts-ratchet.ts')], { cwd: REPO, stdio: 'inherit' }).status ?? 1;
  const directory = spawnSync(process.execPath, [path.join(import.meta.dirname, 'directory-lint.ts')], { cwd: REPO, stdio: 'inherit' }).status ?? 1;
  return lint || ratchet || directory;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
