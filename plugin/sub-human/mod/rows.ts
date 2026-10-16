/**
 * plugin/sub-human/mod/rows.ts: the agent-panel rows' hooks, run only for a row agent (sub-human:room,
 * sub-human:participant) in a session that has a seat or may have one (mod/core/prefilter.ts rowsNeeded): any other
 * Agent call or subagent stop starts no node. The work stays in node (hooks/handlers/row-*.ts: the rows/* documents,
 * the hold files):
 *   - tool.call Agent: keeps the call's agentId while it runs (facts.stashAgent), since classic.PreToolUse, which
 *     runs inside its next, carries none; always next(e).
 *   - classic.PreToolUse Agent: node row-guard (a duplicate row's spawn, or a member's stray participant row, is
 *     denied); next(e) always runs, ours above it (mergePre; cc CONTRACT classic-chain-order).
 *   - classic.PostToolUse Agent|Task (the old name): node row-map (which panel row the spawned agent is).
 *   - classic.SubagentStop: node row-hold (a row that gave up is told to hold again; its block continues it).
 * Failure: each .catch passes the event on as it is: the rows never disturb the session.
 */
import { shimArgv, shimEnv, toClassic, toPre, mergePre, SHIM_TIMEOUT_MS } from './core/shim.ts';
import { rowsNeeded } from './core/prefilter.ts';
import { mergeClassic } from './core/prompt.ts';
import { prePayload } from './core/facts.ts';
import { asHello } from './core/state.ts';
import { facts } from './deliver.ts';
import type { EngineInterface, On } from 'claude-code';

const HELLO = { plugin: 'sub-human', key: 'hello' } as const;

async function needed($: EngineInterface, sid: unknown, agentType: unknown): Promise<boolean> {
  const { value } = await $.state.get(HELLO);
  return rowsNeeded(asHello(value), sid, agentType);
}

const typeOf = (input: unknown) => (input && typeof input === 'object' ? (input as { subagent_type?: unknown }).subagent_type : undefined);

export function registerRows(on: On) {
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    facts.stashAgent(e.tool_use_id, e.agentId);
    try { return await next(e); } finally { facts.dropAgent(e.tool_use_id); }
  }).catch(($, e, next) => next(e));

  on('classic.PreToolUse', { tool: 'Agent' }, async ($, e, next) => {
    const sid = await $.session.id();
    if (!(await needed($, sid, typeOf(e)))) return next(e);
    const root = $.plugin.root;
    const payload = prePayload(e, { sid, cwd: await $.session.cwd().catch(() => undefined), facts: facts.of(sid), agentId: facts.agentOf(e.tool_use_id) });
    const run = await $.process.run(shimArgv(root, 'row-guard'), { stdin: JSON.stringify(payload), env: shimEnv({ session_id: sid }, root), timeoutMs: SHIM_TIMEOUT_MS });
    return mergePre(toPre(run).result, await next(e));
  }).catch(($, e, next) => next(e)); // never disturb the session: the spawn goes on (hold.ts stops a duplicate itself)

  on('classic.PostToolUse', { tool_name: ['Agent', 'Task'] }, async ($, e, next) => {
    if (!(await needed($, e.session_id, typeOf(e.tool_input)))) return next(e);
    const root = $.plugin.root;
    const run = await $.process.run(shimArgv(root, 'row-map'), { stdin: JSON.stringify(e), env: shimEnv(e, root), timeoutMs: SHIM_TIMEOUT_MS });
    return mergeClassic(toClassic('PostToolUse', run).result, await next(e));
  }).catch(($, e, next) => next(e));

  on('classic.SubagentStop', async ($, e, next) => {
    if (!(await needed($, e.session_id, e.agent_type))) return next(e);
    const root = $.plugin.root;
    const run = await $.process.run(shimArgv(root, 'row-hold'), { stdin: JSON.stringify(e), env: shimEnv(e, root), timeoutMs: SHIM_TIMEOUT_MS });
    return mergeClassic(toClassic('SubagentStop', run).result, await next(e));
  }).catch(($, e, next) => next(e));
}
