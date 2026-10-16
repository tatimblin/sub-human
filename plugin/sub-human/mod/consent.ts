/**
 * plugin/sub-human/mod/consent.ts: consent's hooks, run only where a review or a card can be at stake. The review itself
 * stays in node (hooks/consent.ts): its lock, plan-file writes and via=human signing. $.state reviewMaybeOpen
 * is set true by anything that may open a review (here, and in mod/deliver.ts) and set from consent's own subHuman
 * {reviewOpen} report after every run (SUB_HUMAN_SHIM=1); unset counts as true.
 *   - tool.call EnterPlanMode|ExitPlanMode: sets reviewMaybeOpen. An ExitPlanMode the person refused in the plan view
 *     (its call comes back denied or as an error: Claude Code runs no PostToolUse for it) goes to node consent at once,
 *     as a PostToolUseFailure with the refusal's text: a note there opens now, its line rides on the refusal the model
 *     reads, and the person gets a notice (lib/consent/review.ts rejected).
 *   - classic.PreToolUse AskUserQuestion|EnterPlanMode|ExitPlanMode and the room tools: node consent (a room tool other
 *     than post only while a review may be open: mod/core/prefilter.ts consentPreNeeded; post always, for a waiting note); its event carries the call alone, so the
 *     payload gets session_id, transcript_path and permission_mode from what the module last saw (mod/core/facts.ts).
 *     next(e) always runs and ours stands above it (mergePre): a module that answered without it would skip every
 *     other plugin's and the person's hooks (cc CONTRACT classic-chain-order). An allow's reason, which the command
 *     hook's allow showed the person, is a notice.
 *   - classic.PostToolUse AskUserQuestion|EnterPlanMode|ExitPlanMode: node consent wherever a seat is or may be.
 *   - ui.render PromptHint: observed only (next(e) always): whether the prompt holds typed text, sent with an
 *     ExitPlanMode's PreToolUse payload (sub_human_typing) so a plan-view Yes typed into by mistake is asked again.
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
import { prePayload, rejectedPayload } from './core/facts.ts';
import { asHello } from './core/state.ts';
import { facts } from './deliver.ts';
import type { EngineInterface, On } from 'claude-code';
import type { Hello, RunOutput, SubHumanRead } from './core/types.ts';

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
async function apply($: EngineInterface, { systemMessage, subHuman }: { systemMessage?: string; subHuman?: SubHumanRead | undefined }) {
  if (systemMessage) for (const line of asNotice(systemMessage).split('\n')) if (line.trim()) $.ui.log(line);
  const open = reviewOpenOf(subHuman);
  if (open !== undefined) await $.state.set(REVIEW, open);
}

/** The prompt holds typed text (the last PromptHint drawn said isDraft): module state, lost on reload (then false). */
let draft = false;

export function registerConsent(on: On): void {
  on('tool.call', { tool: ['EnterPlanMode', 'ExitPlanMode'] }, async ($, e, next) => {
    await $.state.set(REVIEW, true);
    const r = await next(e);
    if (e.tool !== 'ExitPlanMode' || e.agentId || !(r.deny !== undefined || r.isError)) return r;
    try {
      const sid = await $.session.id();
      if (!seatedOrUnsure(await helloOf($), sid)) return r;
      const text = r.deny !== undefined ? r.deny : typeof r.text === 'string' ? r.text : '';
      const payload = rejectedPayload(e, { sid, cwd: await $.session.cwd().catch(() => undefined), facts: facts.of(sid), text });
      const { result, ...said } = toClassic('PostToolUseFailure', await runConsent($, payload, sid));
      await apply($, said);
      const lines = result.additionalContext ?? [];
      if (!lines.length) return r;
      return r.deny !== undefined ? { deny: [r.deny, ...lines].join('\n\n') } : { ...r, context: [...(r.context ?? []), ...lines] };
    } catch { return r; }
  }).catch((_$, e, next) => next(e)); // the flag stays as it was; past next, a failure returns the refusal as it came

  on('classic.PreToolUse', { tool: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', /^mcp__plugin_sub-human_room__/] }, async ($, e, next) => {
    const sid = await $.session.id();
    if (!consentPreNeeded(await helloOf($), sid, e.tool, await flagOf($))) return next(e);
    // EnterPlanMode: the hooks beneath first, the plugin's own command hook among them, which notes the mode the call
    // is made in (this event carries none, and the module's last-seen mode is stale after a shift+tab: item 7 H)
    const first = e.tool === 'EnterPlanMode' ? await next(e) : null;
    const base = prePayload(e, { sid, cwd: await $.session.cwd().catch(() => undefined), facts: facts.of(sid), agentId: facts.agentOf(e.tool_use_id) });
    // ExitPlanMode: whether the person had typed text in the prompt as the view opens (their next keys go to it: item 8)
    const payload = e.tool === 'ExitPlanMode' && draft ? { ...base, sub_human_typing: true } : base;
    const { result, allowReason, ...said } = toPre(await runConsent($, payload, sid));
    await apply($, said);
    if (allowReason) $.ui.log(asNotice(allowReason));
    return mergePre(result, first ?? await next(e));
  }).catch((_$, e, next) => next(e)); // the call goes on as without consent: nothing is recorded

  on('classic.PostToolUse', { tool_name: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'] }, async ($, e, next) => {
    facts.noteEvent(e);
    if (!seatedOrUnsure(await helloOf($), e.session_id)) return next(e);
    const { result, ...said } = toClassic('PostToolUse', await runConsent($, e, e.session_id));
    await apply($, said);
    return mergeClassic(result, await next(e));
  }).catch((_$, e, next) => next(e));

  on('classic.PermissionRequest', { tool_name: 'ExitPlanMode' }, async ($, e, next) => {
    facts.noteEvent(e);
    const hello = await helloOf($);
    if (!(seatedOrUnsure(hello, e.session_id) && consentNeeded(hello, e.session_id, await flagOf($)))) return next(e);
    const { result, subHuman } = toPermission(await runConsent($, e, e.session_id));
    await apply($, { subHuman });
    return mergePermission(result, await next(e));
  }).catch((_$, e, next) => next(e)); // the dialog shows as it would

  on('classic.Stop', async ($, e, next) => {
    facts.noteEvent(e);
    if (!consentNeeded(await helloOf($), e.session_id, await flagOf($))) return next(e);
    const { result, ...said } = toClassic('Stop', await runConsent($, e, e.session_id));
    await apply($, said);
    return mergeClassic(result, await next(e));
  }).catch((_$, e, next) => next(e)); // a nudge, not a gate: the turn ends as it would

  // observe only: whether the person is typing (PromptHint isDraft), for a plan view about to open (item 8)
  on('ui.render', { component: 'PromptHint' }, (_$, e, next) => {
    draft = e.props.isDraft === true;
    return next(e);
  }).catch((_$, e, next) => next(e));
}
