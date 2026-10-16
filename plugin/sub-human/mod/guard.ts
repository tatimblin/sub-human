/**
 * plugin/sub-human/mod/guard.ts: the store guard, in-process. A plugin can't ship permissions, so these hooks stand
 * in for them (HOOKS in mod/register.ts says what each denies or allows; the verdicts are mod/core/guard.ts).
 * The home comes from the hello in $.state; until mod-hello has answered, the string rules alone apply
 * (".sub-human", SUB_HUMAN_*). Failure: the engine skips a guard that throws, so each has a .catch that denies when
 * the call mentions "sub-human" and otherwise lets it go on, since denying everything on a bug would break every
 * session.
 */
import {
  bashVerdict, needsCwd, denyText, writeTarget, absTarget, ancestors, writeVerdict, WRITE_DENY,
  roomToolVerdict, failClosed, HOLD_DENY, FAILED, readVerdict, READ_DENY, searchVerdict, searchTargets,
} from './core/guard.ts';
import { seated } from './core/seat.ts';
import { asHello } from './core/state.ts';
import type { EngineInterface, On } from 'claude-code';
import type { GuardCtx, Hello } from './core/types.ts';

const HELLO = { plugin: 'sub-human', key: 'hello' } as const;
/** A Grep's or Glob's input, as far as the guard reads it. */
type SearchInput = { path?: unknown; pattern?: unknown };

/** The hello, or {} before mod-hello answered. */
async function helloOf($: EngineInterface): Promise<Hello | Record<string, never>> {
  const { value } = await $.state.get(HELLO);
  return asHello(value) ?? {};
}

/** Where p lands (every link resolved), or undefined when it cannot be stat'ed. */
async function realOf($: EngineInterface, p: string): Promise<string | undefined> {
  const s = await $.fs.stat(p, { resolve: true }).catch(() => undefined);
  return s && typeof s.realPath === 'string' ? s.realPath : undefined;
}

/** Where abs lands: the nearest existing ancestor resolved, plus the rest of the path. */
async function placed($: EngineInterface, abs: string): Promise<string | undefined> {
  for (const a of ancestors(abs)) {
    const r = await realOf($, a);
    if (r === undefined) continue;
    const rest = abs.slice(a.length);
    return (r.endsWith('/') ? r.slice(0, -1) : r) + (rest.startsWith('/') || !rest ? rest : '/' + rest);
  }
  return undefined;
}

export function registerGuard(on: On) {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const h = await helloOf($);
    const ctx: GuardCtx & { pluginRoot: string } = { ...h, pluginRoot: h.pluginRoot || $.plugin.root };
    if (needsCwd(e.command)) {
      ctx.cwd = await $.session.cwd();
      ctx.realCwd = await realOf($, ctx.cwd);
      ctx.realPluginRoot = await realOf($, ctx.pluginRoot);
    }
    const why = bashVerdict(e.command, ctx);
    return why ? { deny: denyText(why, ctx.pluginRoot) } : next(e);
  }).catch(($, e, next) => {
    if (next.called) return next(e);
    const why = bashVerdict(e.command, {}); // the string rules need no $
    if (why) return { deny: denyText(why, $.plugin.root) };
    return failClosed(e) ? { deny: FAILED } : next(e);
  });

  // the list is mod/core/guard.ts WRITE_TOOLS, written out: validate reads a matcher only as a literal
  // (test/mod-core.node-test.ts checks the two agree)
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

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const p = writeTarget(e);
    if (!p) return next(e);
    const h = await helloOf($);
    const cwd = p.startsWith('/') || p.startsWith('~') ? undefined : await $.session.cwd();
    const abs = absTarget(p, { cwd, userHome: h.userHome });
    const candidates = abs ? [abs, await placed($, abs)] : [];
    return readVerdict(candidates, h, p) ? { deny: READ_DENY(p) } : next(e);
  }).catch(($, e, next) => {
    if (next.called) return next(e);
    return readVerdict([], {}, writeTarget(e) || '') ? { deny: READ_DENY(writeTarget(e)) } : next(e);
  });

  // a Grep's or Glob's search path (none: the cwd), and a Glob pattern's literal leading segments. A regex matcher: a
  // build with search embedded in Bash has neither tool, and its typings then do not name them
  on('tool.call', { tool: /^(?:Grep|Glob)$/ }, async ($, e, next) => {
    const h = await helloOf($);
    const targets = searchTargets(e.tool, e as SearchInput);
    const candidates: (string | undefined)[] = [];
    for (const p of targets) {
      const cwd = p.startsWith('/') || p.startsWith('~') ? undefined : await $.session.cwd();
      const abs = p ? absTarget(p, { cwd, userHome: h.userHome }) : absTarget(cwd || '', {});
      if (abs) candidates.push(abs, await placed($, abs));
    }
    return searchVerdict(e.tool, candidates, h, targets.join(' ')) ? { deny: READ_DENY(targets.at(-1) || null, e.tool) } : next(e);
  }).catch(($, e, next) => {
    if (next.called) return next(e);
    const targets = searchTargets(e.tool, e as SearchInput);
    return searchVerdict(e.tool, [], {}, targets.join(' ')) || failClosed(e) ? { deny: READ_DENY(targets.at(-1) || null, e.tool) } : next(e);
  });

  on('tool.call', { tool: 'mcp__plugin_sub-human_room__hold' }, ($, e, next) => (e.agentId ? next(e) : { deny: HOLD_DENY }))
    .catch(($, e, next) => (next.called || e.agentId ? next(e) : { deny: HOLD_DENY }));

  on('tool.check', { tool: /^mcp__plugin_sub-human_room__/ }, async ($, e, next) => {
    const v = roomToolVerdict(e, seated(await helloOf($)));
    return v || next(e);
  }).catch(($, e, next) => roomToolVerdict(e, false) || next(e));
}
