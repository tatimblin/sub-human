/**
 * plugin/sub-human/mod/register.mjs: sub-human's function hooks (docs/next/MODS-PLAN.md). hooks/register.mjs, the
 * module hooks.json names under `modules`, calls register(on) here, which adds the skeleton's hooks below and
 * calls each part's registerX(on) (mod/guard.mjs, mod/render.mjs).
 *
 * The mod routes, node writes: no file under mod/ writes room state or holds the seat key. It knows no store path
 * of its own: hooks/mod-hello.js (run with $.process.run) says the home, the plugin root and this session's seat,
 * kept in $.state sub-human/hello so a hot reload keeps it. Every `$` call sits in the file that registers the
 * hook (cc CONTRACT module-dollar-local); mod/core/*.mjs is pure and tested in node (test/mod-core.test.js).
 *
 *   HOOKS     every hook the module registers: {event, matcher, file, does}; scripts/arch-doc.js renders it into
 *             docs/ARCHITECTURE.md ("Function hooks") and test/mod-core.test.js checks it against validate.
 *   register(on, options)
 */
import { parseHello } from './core/seat.mjs';
import { shimArgv, shimEnv, SHIM_TIMEOUT_MS } from './core/shim.mjs';
import { registerGuard } from './guard.mjs';
import { registerRender } from './render.mjs';

export const HOOKS = [
  { event: 'session.start', matcher: '', file: 'mod/register.mjs', does: 'runs hooks/mod-hello.js (the lease; home, plugin root, seat into $.state)' },
  { event: 'classic.UserPromptExpansion', matcher: 'command_name ^(sub-human:)?sub-human$', file: 'mod/register.mjs', does: 'after the join (hooks/join.js beneath), runs mod-hello again for the new seat' },
  { event: 'classic.SessionStart', matcher: 'source clear|compact|resume', file: 'mod/register.mjs', does: 'after session-restore beneath (a /clear rebinds the seat to a new session id), runs mod-hello again' },
  { event: 'tool.call', matcher: 'Bash', file: 'mod/guard.mjs', does: 'denies a command that names the store or runs the plugin\'s code (mod/core/guard.mjs bashVerdict); .catch fails closed on "sub-human"' },
  { event: 'tool.call', matcher: 'Write|Edit|MultiEdit|NotebookEdit', file: 'mod/guard.mjs', does: 'denies a write into the store, lexically or after $.fs.stat realPath; .catch fails closed on "sub-human"' },
  { event: 'tool.call', matcher: 'mcp__plugin_sub-human_room__hold', file: 'mod/guard.mjs', does: 'denies hold outside a row subagent (no agentId)' },
  { event: 'tool.check', matcher: '/^mcp__plugin_sub-human_room__/', file: 'mod/guard.mjs', does: 'allows the room tools for a seated session (no permission prompt); hold only with agentId' },
  { event: 'ui.render', matcher: 'UserMessage, origin peer|peer-send-message|plugin', file: 'mod/render.mjs', does: 'draws another member\'s Claude as "bob\'s Claude: …" and a sub-human prompt as its chat lines, without "(for Claude)" lines' },
];

const HELLO = { plugin: 'sub-human', key: 'hello' };

/** Run hooks/mod-hello.js for sid and keep its answer in $.state (only a good answer replaces the last one). */
async function sayHello($, sid) {
  const root = $.plugin.root;
  const run = await $.process.run(shimArgv(root, 'mod-hello.js'), {
    stdin: JSON.stringify({ session_id: sid }),
    env: shimEnv({ session_id: sid }, root),
    timeoutMs: SHIM_TIMEOUT_MS,
  });
  const hello = run.exitCode === 0 ? parseHello(run.stdout, sid) : null;
  if (hello) await $.state.set(HELLO, hello);
  return hello;
}

/** @type {import('claude-code').Register} */
export function register(on) {
  on('session.start', async ($, e, next) => {
    try { await sayHello($, await $.session.id()); } catch { /* unknown: the guard keeps its string rules */ }
    return next(e);
  });

  on('classic.UserPromptExpansion', { command_name: /^(sub-human:)?sub-human$/ }, async ($, e, next) => {
    const r = await next(e);
    try { await sayHello($, e.session_id); } catch { /* the next refresh tries again */ }
    return r;
  }).catch(($, e, next) => next(e)); // never in the join's way: what ran beneath stands, or runs

  on('classic.SessionStart', { source: ['clear', 'compact', 'resume'] }, async ($, e, next) => {
    const r = await next(e);
    try { await sayHello($, e.session_id); } catch { /* the next refresh tries again */ }
    return r;
  }).catch(($, e, next) => next(e));

  registerGuard(on);
  registerRender(on);
}
