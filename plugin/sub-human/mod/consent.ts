/**
 * plugin/sub-human/mod/consent.ts: consent's hooks, run only where a review or a card can be at stake. The review itself
 * stays in node (hooks/handlers/consent.ts): its lock, plan-file writes and via=human signing. $.state reviewMaybeOpen
 * is set true by anything that may open a review (here, and in mod/deliver.ts) and set from consent's own subHuman
 * {reviewOpen} report after every run (SUB_HUMAN_SHIM=1); unset counts as true.
 *   - tool.call EnterPlanMode|ExitPlanMode: sets reviewMaybeOpen.
 *   - classic.PreToolUse AskUserQuestion|EnterPlanMode|ExitPlanMode and the room tools: node consent (a room tool only
 *     while a review may be open: mod/core/prefilter.ts consentPreNeeded); its event carries the call alone, so the
 *     payload gets session_id, transcript_path and permission_mode from what the module last saw (mod/core/facts.ts).
 *     next(e) always runs and ours stands above it (mergePre): a module that answered without it would skip every
 *     other plugin's and the person's hooks (cc CONTRACT classic-chain-order). An allow's reason, which the command
 *     hook's allow showed the person, is a notice.
 *   - classic.PostToolUse AskUserQuestion|EnterPlanMode|ExitPlanMode: node consent wherever a seat is or may be.
 *   - classic.PermissionRequest ExitPlanMode: node consent while a review may be open (it closes one without a dialog).
 *   - classic.Stop: node consent (the open-review nudge) while a review may be open; its additionalContext continues
 *     the turn (cc CONTRACT stop-additional-context).
 * Failure: each .catch passes the event on (a nudge, a card and a review are not gates: nothing is recorded unless the
 * person answered).
 */
import {
  shimArgv, shimEnv, toClassic, toPre, mergePre, toPermission, mergePermission, SHIM_TIMEOUT_MS, SHIM_MODE, asNotice,
} from './core/shim.ts';
import { consentNeeded, consentPreNeeded, reviewOpenOf, seatedOrUnsure } from './core/prefilter.ts';
import { mergeClassic } from './core/prompt.ts';
import { prePayload } from './core/facts.ts';
import { asHello } from './core/state.ts';
import { facts } from './deliver.ts';
import type { EngineInterface, On } from 'claude-code';
import type { Hello, RunOutput, SubHumanReport } from './core/types.ts';

const HELLO = { plugin: 'sub-human', key: 'hello' } as const;
const REVIEW = { plugin: 'sub-human', key: 'reviewMaybeOpen' } as const;

async function helloOf($: EngineInterface): Promise<Hello | null> {
  const { value } = await $.state.get(HELLO);
  return asHello(value);
}
async function flagOf($: EngineInterface): Promise<unknown> {
  const { value } = await $.state.get(REVIEW);
  return value;
}

/** node hooks/run.ts consent in shim mode, for the session sid. */
function runConsent($: EngineInterface, stdin: unknown, sid: unknown): Promise<RunOutput> {
  const root = $.plugin.root;
  return $.process.run(shimArgv(root, 'consent'), {
    stdin: JSON.stringify(stdin),
    env: { ...shimEnv({ session_id: typeof sid === 'string' ? sid : undefined }, root), ...SHIM_MODE },
    timeoutMs: SHIM_TIMEOUT_MS,
  });
}

/** Consent's notices and its report: a systemMessage as $.ui.log lines, reviewOpen into $.state. */
async function apply($: EngineInterface, { systemMessage, subHuman }: { systemMessage?: string; subHuman?: SubHumanReport }) {
  if (systemMessage) for (const line of asNotice(systemMessage).split('\n')) if (line.trim()) $.ui.log(line);
  const open = reviewOpenOf(subHuman);
  if (open !== undefined) await $.state.set(REVIEW, open);
}

export function registerConsent(on: On) {
  on('tool.call', { tool: ['EnterPlanMode', 'ExitPlanMode'] }, async ($, e, next) => {
    await $.state.set(REVIEW, true);
    return next(e);
  }).catch(($, e, next) => next(e)); // the flag stays as it was

  on('classic.PreToolUse', { tool: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', /^mcp__plugin_sub-human_room__/] }, async ($, e, next) => {
    const sid = await $.session.id();
    if (!consentPreNeeded(await helloOf($), sid, e.tool, await flagOf($))) return next(e);
    const payload = prePayload(e, { sid, cwd: await $.session.cwd().catch(() => undefined), facts: facts.of(sid), agentId: facts.agentOf(e.tool_use_id) });
    const { result, allowReason, ...said } = toPre(await runConsent($, payload, sid));
    await apply($, said);
    if (allowReason) $.ui.log(asNotice(allowReason));
    return mergePre(result, await next(e));
  }).catch(($, e, next) => next(e)); // the call goes on as without consent: nothing is recorded

  on('classic.PostToolUse', { tool_name: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'] }, async ($, e, next) => {
    facts.noteEvent(e);
    if (!seatedOrUnsure(await helloOf($), e.session_id)) return next(e);
    const { result, ...said } = toClassic('PostToolUse', await runConsent($, e, e.session_id));
    await apply($, said);
    return mergeClassic(result, await next(e));
  }).catch(($, e, next) => next(e));

  on('classic.PermissionRequest', { tool_name: 'ExitPlanMode' }, async ($, e, next) => {
    facts.noteEvent(e);
    const hello = await helloOf($);
    if (!(seatedOrUnsure(hello, e.session_id) && consentNeeded(hello, e.session_id, await flagOf($)))) return next(e);
    const { result, subHuman } = toPermission(await runConsent($, e, e.session_id));
    await apply($, { subHuman });
    return mergePermission(result, await next(e));
  }).catch(($, e, next) => next(e)); // the dialog shows as it would

  on('classic.Stop', async ($, e, next) => {
    facts.noteEvent(e);
    if (!consentNeeded(await helloOf($), e.session_id, await flagOf($))) return next(e);
    const { result, ...said } = toClassic('Stop', await runConsent($, e, e.session_id));
    await apply($, said);
    return mergeClassic(result, await next(e));
  }).catch(($, e, next) => next(e)); // a nudge, not a gate: the turn ends as it would
}
