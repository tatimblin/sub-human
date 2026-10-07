/**
 * plugin/sub-human/mod/register.mjs: sub-human's function hooks (docs/next/MODS-PLAN.md). hooks/register.mjs, the
 * module hooks.json names under `modules`, calls register(on) here, which adds the skeleton's hooks below and
 * calls each part's registerX(on) (mod/guard.mjs, prompt.mjs, consent.mjs, tasks.mjs, render.mjs).
 *
 * The mod routes, node writes: no file under mod/ writes room state or holds the seat key. It knows no store path
 * of its own: hooks/mod-hello.js (run with $.process.run) says the home, the plugin root and this session's seat,
 * kept in $.state sub-human/hello so a hot reload keeps it. Every `$` call sits in the file that registers the
 * hook (cc CONTRACT module-dollar-local); mod/core/*.mjs is pure and tested in node (test/mod-core.test.js).
 * A refresh that fails keeps the last hello but marks it as no session's (sid null), so every prefilter runs
 * node until a refresh succeeds: a join whose hello failed must not leave "no seat" looking certain.
 * session.start and a classic SessionStart also set reviewMaybeOpen (mod/consent.mjs): unsure until consent says.
 *
 *   HOOKS     every hook the module registers: {event, matcher, file, does}; scripts/arch-doc.js renders it into
 *             docs/ARCHITECTURE.md ("Function hooks") and test/mod-core.test.js checks it against validate.
 *   register(on, options)
 */
import { parseHello } from './core/seat.mjs';
import { shimArgv, shimEnv, SHIM_TIMEOUT_MS } from './core/shim.mjs';
import { registerGuard } from './guard.mjs';
import { registerRender } from './render.mjs';
import { registerPrompt } from './prompt.mjs';
import { registerConsent } from './consent.mjs';
import { registerTasks } from './tasks.mjs';

export const HOOKS = [
  { event: 'session.start', matcher: '', file: 'mod/register.mjs', does: 'runs hooks/mod-hello.js (the lease; home, plugin root, seat into $.state)' },
  { event: 'classic.UserPromptExpansion', matcher: 'command_name ^(sub-human:)?sub-human$', file: 'mod/register.mjs', does: 'after the join (hooks/join.js beneath), runs mod-hello again for the new seat' },
  { event: 'classic.SessionStart', matcher: 'source clear|compact|resume', file: 'mod/register.mjs', does: 'after session-restore beneath (a /clear rebinds the seat to a new session id), runs mod-hello again; reviewMaybeOpen unsure' },
  { event: 'tool.call', matcher: 'Bash', file: 'mod/guard.mjs', does: 'denies a command that names the store or runs the plugin\'s code (mod/core/guard.mjs bashVerdict); .catch fails closed on "sub-human"' },
  { event: 'tool.call', matcher: 'Write|Edit|MultiEdit|NotebookEdit', file: 'mod/guard.mjs', does: 'denies a write into the store, lexically or after $.fs.stat realPath; .catch fails closed on "sub-human"' },
  { event: 'tool.call', matcher: 'mcp__plugin_sub-human_room__hold', file: 'mod/guard.mjs', does: 'denies hold outside a row subagent (no agentId)' },
  { event: 'tool.check', matcher: '/^mcp__plugin_sub-human_room__/', file: 'mod/guard.mjs', does: 'allows the room tools for a seated session (no permission prompt); hold only with agentId' },
  { event: 'prompt.submit', matcher: '', file: 'mod/prompt.mjs', does: 'drops an @room / room: whose origin is not composer, sdk or bridge (a peer, a notification, a plugin); hands the origin to the shim below; .catch drops only an @room' },
  { event: 'classic.UserPromptSubmit', matcher: '', file: 'mod/prompt.mjs', does: 'no node when surely unseated and not an @room; else node hooks/prompt.js with sub_human_origin (systemMessage via $.ui.log)' },
  { event: 'tool.call', matcher: 'EnterPlanMode|ExitPlanMode', file: 'mod/consent.mjs', does: 'sets reviewMaybeOpen (a room review starts only through these)' },
  { event: 'classic.Stop', matcher: '', file: 'mod/consent.mjs', does: 'node hooks/consent.js (the open-review nudge) only while a review may be open or the seat is unknown' },
  { event: 'classic.PreToolUse', matcher: '/^mcp__plugin_sub-human_room__/', file: 'mod/consent.mjs', does: 'no review open: answers with no decision, so consent\'s command hook beneath does not run' },
  { event: 'classic.PostToolUse', matcher: 'tool_name TaskCreate|TaskUpdate', file: 'mod/tasks.mjs', does: 'node hooks/tasks.js (the room task mirror) only for the orch or an unknown seat' },
  { event: 'classic.TaskCompleted', matcher: '', file: 'mod/tasks.mjs', does: 'node hooks/tasks.js (the gate; exit 2 -> block) only for the orch or an unknown seat; .catch blocks in the orch' },
  { event: 'ui.render', matcher: 'UserMessage, origin peer|peer-send-message|plugin', file: 'mod/render.mjs', does: 'draws another member\'s Claude as "bob\'s Claude: …" and a sub-human prompt as its chat lines, without "(for Claude)" lines' },
];

const HELLO = { plugin: 'sub-human', key: 'hello' };
const REVIEW = { plugin: 'sub-human', key: 'reviewMaybeOpen' };

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

/** After a refresh failed: keep the last hello for the guard's home, but as no session's (prefilters run node). */
async function forgetSession($) {
  const { value } = await $.state.get(HELLO);
  if (value && typeof value === 'object' && value.sid !== null) await $.state.set(HELLO, { ...value, sid: null });
}

/** mod-hello for sid; when it fails, forgetSession. */
async function refresh($, sid) {
  let hello = null;
  try { hello = await sayHello($, sid); } catch { /* below */ }
  if (!hello) await forgetSession($);
}

/** @type {import('claude-code').Register} */
export function register(on) {
  on('session.start', async ($, e, next) => {
    try { await $.state.set(REVIEW, true); await refresh($, await $.session.id()); } catch { /* unknown: the guard keeps its string rules */ }
    return next(e);
  });

  on('classic.UserPromptExpansion', { command_name: /^(sub-human:)?sub-human$/ }, async ($, e, next) => {
    const r = await next(e);
    try { await refresh($, e.session_id); } catch { /* the next refresh tries again */ }
    return r;
  }).catch(($, e, next) => next(e)); // never in the join's way: what ran beneath stands, or runs

  on('classic.SessionStart', { source: ['clear', 'compact', 'resume'] }, async ($, e, next) => {
    const r = await next(e);
    try { await $.state.set(REVIEW, true); await refresh($, e.session_id); } catch { /* the next refresh tries again */ }
    return r;
  }).catch(($, e, next) => next(e));

  registerGuard(on);
  registerPrompt(on);
  registerConsent(on);
  registerTasks(on);
  registerRender(on);
}
