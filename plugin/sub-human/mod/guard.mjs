/**
 * plugin/sub-human/mod/guard.mjs: the store guard, in-process (it replaced hooks/guard.js and its two PreToolUse
 * entries). A plugin can't ship permissions, so these hooks stand in for them:
 *   - tool.call Bash: deny a command that names the store (its path, ~/.sub-human, the seat keys under it), names
 *     or sets SUB_HUMAN_HOME / SUB_HUMAN_TEST_ROOM_DIR, or runs the plugin's own code; the read-only CLI stays
 *     allowed, and so does reading the plugin's source (mod/core/guard.mjs bashVerdict);
 *   - tool.call Write / Edit / MultiEdit / NotebookEdit: deny a write into the store, lexically or where it
 *     resolves ($.fs.stat realPath of the nearest existing ancestor);
 *   - tool.call hold: deny outside a row subagent (no agentId);
 *   - tool.check room MCP tools: allow for a seated session (no permission prompt).
 * The home comes from mod-hello ($.state sub-human/hello). Until it has answered, the string rules alone apply
 * (".sub-human", SUB_HUMAN_*). A guard that fails is skipped by the engine, so each has a .catch: it denies
 * when the call mentions "sub-human" (as hooks/guard.js did) and otherwise lets the call go on, since denying
 * everything on a bug would break every session.
 */
import {
  bashVerdict, needsCwd, denyText, writeTarget, absTarget, ancestors, writeVerdict, WRITE_DENY,
  roomToolVerdict, failClosed, HOLD_DENY, FAILED,
} from './core/guard.mjs';
import { seated } from './core/seat.mjs';

const HELLO = { plugin: 'sub-human', key: 'hello' };

/** The hello, or {} before mod-hello answered. */
async function helloOf($) {
  const { value } = await $.state.get(HELLO);
  return value && typeof value === 'object' ? value : {};
}

/** Where p lands (every link resolved), or undefined when it cannot be stat'ed. */
async function realOf($, p) {
  const s = await $.fs.stat(p, { resolve: true }).catch(() => undefined);
  return s && typeof s.realPath === 'string' ? s.realPath : undefined;
}

/** Where abs lands: the nearest existing ancestor resolved, plus the rest of the path. */
async function placed($, abs) {
  for (const a of ancestors(abs)) {
    const r = await realOf($, a);
    if (r === undefined) continue;
    const rest = abs.slice(a.length);
    return (r.endsWith('/') ? r.slice(0, -1) : r) + (rest.startsWith('/') || !rest ? rest : '/' + rest);
  }
  return undefined;
}

/** @param {import('claude-code').On} on */
export function registerGuard(on) {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const h = await helloOf($);
    const ctx = { ...h, pluginRoot: h.pluginRoot || $.plugin.root };
    if (needsCwd(e.command)) {
      ctx.cwd = await $.session.cwd();
      ctx.realCwd = await realOf($, ctx.cwd);
      ctx.realPluginRoot = await realOf($, ctx.pluginRoot);
    }
    const why = bashVerdict(e.command, ctx);
    return why ? { deny: denyText(why) } : next(e);
  }).catch(($, e, next) => {
    if (next.called) return next(e);
    const why = bashVerdict(e.command, {}); // the string rules need no $
    if (why) return { deny: denyText(why) };
    return failClosed(e) ? { deny: FAILED } : next(e);
  });

  on('tool.call', { tool: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] }, async ($, e, next) => {
    const p = writeTarget(e);
    if (!p) return next(e);
    const h = await helloOf($);
    const cwd = p.startsWith('/') || p.startsWith('~') ? undefined : await $.session.cwd();
    const abs = absTarget(p, { cwd, userHome: h.userHome });
    const candidates = abs ? [abs, await placed($, abs)] : [];
    return writeVerdict(candidates, h, p) ? { deny: WRITE_DENY(e.tool, p) } : next(e);
  }).catch(($, e, next) => {
    if (next.called) return next(e);
    if (writeVerdict([], {}, writeTarget(e) || '')) return { deny: WRITE_DENY(e.tool, writeTarget(e)) };
    return failClosed(e) ? { deny: FAILED } : next(e);
  });

  on('tool.call', { tool: 'mcp__plugin_sub-human_room__hold' }, ($, e, next) => (e.agentId ? next(e) : { deny: HOLD_DENY }))
    .catch(($, e, next) => (next.called || e.agentId ? next(e) : { deny: HOLD_DENY }));

  on('tool.check', { tool: /^mcp__plugin_sub-human_room__/ }, async ($, e, next) => {
    const v = roomToolVerdict(e, seated(await helloOf($)));
    return v || next(e);
  }).catch(($, e, next) => roomToolVerdict(e, false) || next(e));
}
