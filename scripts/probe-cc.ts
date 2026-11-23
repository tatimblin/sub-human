#!/usr/bin/env node
/**
 * probe-cc: npm run probe. Checks the installed Claude Code against the plugin's contract.json.
 *
 * TODO(U1): v2's contract.json and its matcher are not written yet, so the probe itself is not here; only the
 * typings check, which the probe runs (the committed snapshot must be written by contract.json `probed`), is kept.
 *
 *   node scripts/probe-cc.ts     exits 2 until U1 adds the contract
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './lib/paths.ts';
import { writtenBy } from './typings.ts';

export const TYPINGS: string = path.join(REPO, 'typings', 'claude-code', 'index.d.ts');

/** Whether the typings snapshot at file was written by the probed Claude Code. */
export function typingsCheck(file: string, probed: string): { ok: boolean, version: string | null, probed: string } {
  let version: string | null = null;
  try { version = writtenBy(fs.readFileSync(file, 'utf8')); } catch { /* missing: version stays null */ }
  return { ok: version === probed, version, probed };
}

if (import.meta.main) {
  process.stderr.write('probe-cc: no contract.json yet (TODO(U1))\n');
  process.exitCode = 2;
}
