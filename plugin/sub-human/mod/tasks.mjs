/**
 * plugin/sub-human/mod/tasks.mjs: the room task list's mirror and gate, run only where they act (docs/next/
 * MODS-PLAN.md W2 M5). They replaced the hooks.json PostToolUse TaskCreate|TaskUpdate and TaskCompleted entries;
 * hooks/tasks.js is unchanged and acts only for the orch, so a member's own native task list costs no node start.
 *   - classic.PostToolUse TaskCreate|TaskUpdate: node hooks/tasks.js (the mirror) when tasksNeeded
 *     (mod/core/prefilter.mjs: the orch, or unsure).
 *   - classic.TaskCompleted: node hooks/tasks.js (the gate) when tasksNeeded. Its exit 2 becomes block, which
 *     drops every field of that TaskUpdate as the command hook's did (cc CONTRACT task-completed-block-drops-
 *     fields, hook-exit2-blocks). If the shim itself fails in the orch's session, its .catch blocks (the gate
 *     fails closed there, as tasks.js does); anywhere else the completion goes on.
 */
import { shimArgv, shimEnv, toClassic, SHIM_TIMEOUT_MS } from './core/shim.mjs';
import { tasksNeeded } from './core/prefilter.mjs';
import { mergeClassic } from './core/prompt.mjs';

const HELLO = { plugin: 'sub-human', key: 'hello' };
const GATE_FAILED = 'sub-human task gate failed closed: the check did not run. Send status alone in a TaskUpdate of its own to retry.';

async function helloOf($) {
  const { value } = await $.state.get(HELLO);
  return value && typeof value === 'object' ? value : null;
}

/** node hooks/tasks.js for this event, or null when the session is surely not the orch. */
async function runTasks($, e, event) {
  if (!tasksNeeded(await helloOf($), e.session_id, await $.env.get('SUB_HUMAN_ROOM'))) return null;
  const root = $.plugin.root;
  const run = await $.process.run(shimArgv(root, 'tasks.js'), {
    stdin: JSON.stringify(e),
    env: shimEnv(e, root),
    timeoutMs: SHIM_TIMEOUT_MS,
  });
  return toClassic(event, run).result;
}

/** @param {import('claude-code').On} on */
export function registerTasks(on) {
  on('classic.PostToolUse', { tool_name: ['TaskCreate', 'TaskUpdate'] }, async ($, e, next) => {
    const ours = await runTasks($, e, 'PostToolUse');
    return ours ? mergeClassic(ours, await next(e)) : next(e);
  }).catch(($, e, next) => next(e)); // the mirror is rebuilt from the log; a missed entry is not a gate

  on('classic.TaskCompleted', async ($, e, next) => {
    const ours = await runTasks($, e, 'TaskCompleted');
    if (ours && ours.block) return ours;
    return ours ? mergeClassic(ours, await next(e)) : next(e);
  }).catch(async ($, e, next) => {
    if (next.called) return next(e);
    const hello = await helloOf($).catch(() => null);
    return hello && hello.seat && hello.seat.role === 'orch' ? { block: GATE_FAILED } : next(e);
  });
}
