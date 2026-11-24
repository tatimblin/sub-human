// command: `/sub-human …` typed at my prompt, answered here as one plain line with no model turn. The verbs need Node,
// which the module hasn't, so the hook runs the command hook beneath it itself (hooks/node.sh expand, the same verbs
// hooks.json's UserPromptExpansion would run) and draws its answer with `$.ui.log`. It answers `{}`: Claude Code then
// adds no row at all, so the typed line (an invite's secret) is never echoed and nothing reaches the model, and no
// expansion hook runs, so there is no "UserPromptExpansion operation blocked by hook" frame (core/cc/contract.json
// command-run-empty-answer). A prompt that isn't the person's own (the SDK, the bridge), or a run refused before it
// started, goes on to the classic hook, which answers with that frame, as it does where the module is off (C1). A run
// that outlasts COMMAND_MS may have done its work (an invite minted), so it is never run a second time: one line says so.
import type { On } from 'claude-code';
import * as v from '../vendor/valibot.mjs';
import { CODE } from '../core/api.js';
import { FROM_MODULE, KNOBS } from '../config.js';
import { homeDir } from '../home.js';
import { COMMAND, session } from './session.js';

/** As long as hooks.json gives the classic hook. */
export const COMMAND_MS = 15_000;
/** A run that fails sooner than this was refused before it started. */
export const REFUSED_MS = 2000;
const PREFIX = 'sub-human: ';
export const STILL_WORKING = '/sub-human is still working; check /sub-human who';
const Reply = v.object({ reason: v.string() });

/** The answer the classic expand hook printed (`{decision: 'block', reason: 'sub-human: …'}`), or null. */
export function answerOf(stdout: string): string | null {
  try {
    const r = v.safeParse(Reply, JSON.parse(stdout));
    // Claude Code draws a `$.ui.log` line under the plugin's name already
    return r.success ? r.output.reason.replace(PREFIX, '') : null;
  } catch { return null; }
}

/** The room a `/sub-human join LINE PIN` is for (R30), read off the line; null for any other command. */
export function joiningOf(args: string): string | null {
  return /^\s*join\s/.test(args) ? (args.split(/[/?#\s]/).find(p => CODE.test(p)) ?? null) : null;
}

/**
 * The environment the command hook runs with: the knobs and HOME and PATH as this session has them, and the home the
 * module itself uses, always given, so the run can never fall back to another home. The marker makes the CLI refuse a
 * run that lost its home.
 */
export function commandEnv(got: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = { [FROM_MODULE]: '1', [HOME_KNOB]: homeDir(got, got.HOME ?? '') };
  for (const k of PASSED) {
    const value = got[k];
    if (value !== undefined && value !== '' && !(k in env)) env[k] = value;
  }
  return env;
}
const HOME_KNOB = KNOBS[0];
const PASSED: readonly string[] = [...KNOBS, 'HOME', 'PATH'];

export function registerCommand(on: On): void {
  on('command.run', { command: COMMAND }, async ($, e, next) => {
    session.joining = joiningOf(e.args);
    session.recheck = true; // a join, leave or kick may have moved this session's pointer
    if (e.origin.kind !== 'composer') return next(e);
    const read = (p: Promise<string | undefined>): Promise<string | undefined> => p.catch(() => undefined);
    // each by its literal name: Claude Code lists the variables a module reads (config.ts KNOBS, the same six)
    const got: Record<string, string | undefined> = {
      SUB_HUMAN_HOME: await read($.env.get('SUB_HUMAN_HOME')), SUB_HUMAN_NAME: await read($.env.get('SUB_HUMAN_NAME')),
      SUB_HUMAN_INVITE: await read($.env.get('SUB_HUMAN_INVITE')), SUB_HUMAN_SSH_ADDR: await read($.env.get('SUB_HUMAN_SSH_ADDR')),
      SUB_HUMAN_PORT: await read($.env.get('SUB_HUMAN_PORT')), SUB_HUMAN_CC_OFF: await read($.env.get('SUB_HUMAN_CC_OFF')),
      HOME: await read($.env.get('HOME')), PATH: await read($.env.get('PATH')),
    };
    const payload = { session_id: await $.session.id(), cwd: await $.session.cwd(), command_args: e.args };
    let run: { readonly stdout: string; readonly stderr: string };
    const began = await $.clock.now();
    try {
      run = await $.process.run(['sh', `${$.plugin.root}/hooks/node.sh`, 'expand'], { stdin: JSON.stringify(payload), env: commandEnv(got), timeoutMs: COMMAND_MS });
    } catch {
      // the rejection says no more than that it failed, and `$` has no monotonic clock: a run refused within
      // REFUSED_MS never started (managed policy refuses at once); a later one ran, and may have done its work
      if ((await $.clock.now()) - began < REFUSED_MS) return next(e);
      $.ui.log(STILL_WORKING);
      return {};
    }
    session.recheck = true; // the run may have moved the pointer after the first recheck was taken
    const why = run.stderr.trim().split('\n').at(-1)?.replace(PREFIX, '').slice(0, 200);
    $.ui.log(answerOf(run.stdout) ?? `/sub-human didn't answer${why ? `: ${why}` : ''}.`);
    return {};
  });
}
