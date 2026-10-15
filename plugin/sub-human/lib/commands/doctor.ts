/**
 * plugin/sub-human/lib/commands/doctor.ts: `/sub-human doctor`: `sub-human doctor --quick` (lib/cli/doctor.ts), read only,
 * and it runs without the hooks module (a refusal points to it). --fix and --bundle change or write files, so they run
 * in a terminal outside Claude Code: the reply names the line.
 */
import path from 'node:path';
import childProcess from 'node:child_process';
import { cliLine } from '../text.ts';
import { HELP_HINT, refused, say } from './answer.ts';
import type { OpenVerb } from './types.ts';

export const doctor: OpenVerb = (argv, { pluginRoot }) => {
  if (argv.includes('--fix') || argv.includes('--bundle')) return refused(`${argv.includes('--fix') ? '--fix' : '--bundle'} changes or writes files, so it runs in a terminal outside Claude Code: ${cliLine(`doctor ${argv.join(' ')}`)}`);
  if (argv.length) return refused(`usage: /sub-human doctor. ${HELP_HINT}`);
  const r = childProcess.spawnSync(process.execPath, [path.join(pluginRoot, 'scripts', 'sub-human'), 'doctor', '--quick'], {
    encoding: 'utf8', timeout: 8000, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return text ? say(text) : refused(`the check did not finish (${r.error ? r.error.message : `exit ${r.status}`}). Run it in a terminal: ${cliLine('doctor')}`);
};
