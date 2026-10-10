/**
 * plugin/sub-human/mod/tasks.ts: the room task list's mirror and gate, run only where they act. hooks/tasks.ts
 * acts only for the room's Claude, so a member's own native task list costs no node start.
 *   - classic.PostToolUse TaskCreate|TaskUpdate: node hooks/tasks.ts (the mirror) when tasksNeeded
 *     (mod/core/prefilter.ts: the room's Claude, or unsure).
 *   - classic.TaskCompleted: node hooks/tasks.ts (the gate) when tasksNeeded. Its exit 2 becomes block, which
 *     drops every field of that TaskUpdate as the command hook's did (cc CONTRACT task-completed-block-drops-
 *     fields, hook-exit2-blocks). If the shim fails wherever tasksNeeded holds, its .catch blocks: the gate
 *     fails closed, as tasks.ts does. Only a session surely not the room's Claude lets the completion go on.
 */
import { shimArgv, shimEnv, toClassic, SHIM_TIMEOUT_MS } from './core/shim.ts';
import { tasksNeeded } from './core/prefilter.ts';
import { mergeClassic } from './core/prompt.ts';
import { asHello } from './core/state.ts';
import type { On } from 'claude-code';

const HELLO = { plugin: 'sub-human', key: 'hello' };
const TASK_GATE_FAILED = 'sub-human task gate failed closed: the check did not run. Send status alone in a TaskUpdate of its own to retry.';

async function helloOf($) {
  const { value } = await $.state.get(HELLO);
  return asHello(value);
}

async function roomEnvOf($) {
  return $.env.get('SUB_HUMAN_ROOM');
}

/** node hooks/tasks.ts for this event, or null when the session is surely not the room's Claude. */
async function runTasks($, e, event) {
  if (!tasksNeeded(await helloOf($), e.session_id, await roomEnvOf($))) return null;
  const root = $.plugin.root;
  const run = await $.process.run(shimArgv(root, 'tasks.ts'), {
    stdin: JSON.stringify(e),
    env: shimEnv(e, root),
    timeoutMs: SHIM_TIMEOUT_MS,
  });
  return toClassic(event, run).result;
}

export function registerTasks(on: On) {
  on('classic.PostToolUse', { tool_name: ['TaskCreate', 'TaskUpdate'] }, async ($, e, next) => {
    const ours = await runTasks($, e, 'PostToolUse');
    return ours ? mergeClassic(ours, await next(e)) : next(e);
  }).catch(($, e, next) => next(e)); // not a gate: tasks.ts's next room Claude run appends any task the log missed

  on('classic.TaskCompleted', async ($, e, next) => {
    const ours = await runTasks($, e, 'TaskCompleted');
    if (ours && ours.block) return ours;
    return ours ? mergeClassic(ours, await next(e)) : next(e);
  }).catch(async ($, e, next) => {
    if (next.called) return next(e);
    const hello = await helloOf($).catch(() => null);
    const roomEnv = await roomEnvOf($).catch(() => undefined);
    return tasksNeeded(hello, e.session_id, roomEnv) ? { block: TASK_GATE_FAILED } : next(e);
  });
}
