/**
 * plugin/sub-human/mod/consent.ts: consent's hooks, run only where a review or a card can be at stake. The review itself
 * stays in node (hooks/consent.ts): its lock, plan-file writes and via=human signing. $.state reviewMaybeOpen
 * is set true by anything that may open a review (here, and in mod/deliver.ts) and set from consent's own subHuman
 * {reviewOpen} report after every run (SUB_HUMAN_SHIM=1); unset counts as true.
 *   - tool.call EnterPlanMode|ExitPlanMode and the room's plan tool: sets reviewMaybeOpen (an edit counts as open). An ExitPlanMode the person refused in the plan view
 *     (its call comes back denied or as an error: Claude Code runs no PostToolUse for it) goes to node consent at once,
 *     as a PostToolUseFailure with the refusal's text: a note there is sent now, its outcome rides on the refusal the
 *     model reads (lib/consent/review.ts rejected).
 *   - classic.PreToolUse AskUserQuestion|EnterPlanMode|ExitPlanMode and the room tools: node consent (a room tool other
 *     only while a review may be open: mod/core/prefilter.ts consentPreNeeded); its event carries the call alone, so the
 *     payload gets session_id, transcript_path and permission_mode from what the module last saw (mod/core/facts.ts).
 *     It answers only deny or ask, each written out in its return (the plugin directory checks that the person keeps
 *     every permission decision): ask is the plan view of a review, a card, or Claude Code's own "exit plan mode?" for
 *     a closing call; deny is a guard. With neither, the call goes on to the hooks beneath (next(e)), so the module
 *     never allows anything, and never skips another plugin's or the person's hooks unless it denies or asks.
 *   - classic.PostToolUse AskUserQuestion|EnterPlanMode|ExitPlanMode: node consent wherever a seat is or may be.
 *   - the module's own dialogs ($.ui.ask: the question after a room opened and the invite's copy question,
 *     mod/deliver.ts): its AskUserQuestion hooks pass each by while it is asked (asks.mine: its
 *     exact question and header), with next(e), never an answer of their own.
 *   - ui.render PromptHint: observed only (next(e) always): whether the prompt holds typed text, sent with an
 *     ExitPlanMode's PreToolUse payload (sub_human_typing) so a plan-view Yes typed into by mistake is asked again.
 *   - classic.Stop: node consent (the open-review nudge) while a review may be open; its additionalContext continues
 *     the turn (cc CONTRACT stop-additional-context).
 * Failure: each .catch passes the event on (a nudge, a card and a review are not gates: nothing is recorded unless the
 * person answered).
 */
import { shimArgv, shimEnv, toClassic, toPre, SHIM_TIMEOUT_MS, SHIM_MODE, asNotice } from './core/shim.ts';
import { consentNeeded, consentPreNeeded, reviewOpenOf, seatedOrUnsure } from './core/prefilter.ts';
import { mergeClassic } from './core/prompt.ts';
import { prePayload, rejectedPayload } from './core/facts.ts';
import { asHello } from './core/state.ts';
import { facts, asks } from './deliver.ts';
import { keepQuiet, quietOn, quietRow } from './core/quiet.ts';
import { ROOM_AGENT } from './core/rows.ts';
import { rowOffered } from './rows.ts';
import { isChatRow, quietCall } from './chat.ts';
import { KEEPER_AGENT } from './core/room-chat.ts';
import type { EngineInterface, On, RenderElement } from 'claude-code';
import type { Hello, RunOutput, SubHumanRead } from './core/types.ts';

const HELLO = { plugin: 'sub-human', key: 'hello' } as const;
/** The room's plan tool: its edit op opens an edit the hooks then run (consent must see the next plan mode). */
const PLAN_TOOL = 'mcp__plugin_sub-human_room__plan';
const REVIEW = { plugin: 'sub-human', key: 'reviewMaybeOpen' } as const;
const QUIET = { plugin: 'sub-human', key: 'quietCalls' } as const;
/** Main's own Agent call for a room row agent: refused, the module starts the row itself. */
const ROW_DENY = 'sub-human starts the room row itself';

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

/** Consent's notices and its report: a systemMessage as $.ui.log lines, reviewOpen into $.state, a debug line to
 * Claude Code's debug log, and a quiet call (toolUseId: the call the report is about) into the calls whose rows are
 * hidden. */
async function apply($: EngineInterface, { systemMessage, subHuman }: { systemMessage?: string; subHuman?: SubHumanRead | undefined }, toolUseId?: unknown) {
  if (systemMessage) for (const line of asNotice(systemMessage).split('\n')) if (line.trim()) $.ui.log(line);
  if (subHuman && typeof subHuman.debug === 'string' && subHuman.debug) $.ui.log(subHuman.debug, { to: 'debug' });
  const open = reviewOpenOf(subHuman);
  if (open !== undefined) await $.state.set(REVIEW, open);
  if (subHuman && subHuman.quiet === true) await hideCall($, toolUseId);
}

/** The call toolUseId's rows drawn as nothing from now on (kept in $.state quietCalls), unless the verdict turns
 * quiet-plan off. */
async function hideCall($: EngineInterface, toolUseId: unknown) {
  if (typeof toolUseId !== 'string' || !toolUseId) return;
  if (!quietOn(await helloOf($))) return;
  const kept = await quietCalls($);
  if (kept.includes(toolUseId)) return;
  const next = keepQuiet(kept, toolUseId);
  quiet = new Set(next);
  await $.state.set(QUIET, next);
  $.ui.invalidate('ui.render'); // a row drawn already (the result came before this report) is drawn again, hidden
}

/** The calls whose rows are hidden (mod/core/quiet.ts), in memory once read from $.state (kept there across a reload
 * and a --resume: the rows are drawn again then). null: not read yet. */
let quiet: Set<string> | null = null;
async function quietCalls($: EngineInterface): Promise<string[]> {
  if (quiet) return [...quiet];
  const { value } = await $.state.get(QUIET);
  const ids = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  quiet = new Set(ids);
  return ids;
}

/** An empty drawing: the row is not drawn at all (live 2.1.296: an empty Box takes no line). */
const EMPTY: RenderElement = { type: 'Box', props: {}, children: [] };

/** The prompt holds typed text (the last PromptHint drawn said isDraft): module state, lost on reload (then false). */
let draft = false;

export function registerConsent(on: On): void {
  on('tool.call', { tool: ['EnterPlanMode', 'ExitPlanMode', PLAN_TOOL] }, async ($, e, next) => {
    await $.state.set(REVIEW, true);
    // the loop the call runs in, for its classic.PreToolUse inside next (its event carries none): consent tells a
    // subagent's ExitPlanMode from the main loop's by agent_id (hooks/consent.ts waitingOf, signoffElsewhere)
    facts.stashAgent(e.tool_use_id, e.agentId);
    const r = await next(e).finally(() => { facts.dropAgent(e.tool_use_id); });
    if (e.tool !== 'ExitPlanMode' || e.agentId || !(r.deny !== undefined || r.isError)) return r;
    try {
      const sid = await $.session.id();
      if (!seatedOrUnsure(await helloOf($), sid)) return r;
      const text = r.deny !== undefined ? r.deny : typeof r.text === 'string' ? r.text : '';
      const payload = rejectedPayload(e, { sid, cwd: await $.session.cwd().catch(() => undefined), facts: facts.of(sid), text });
      const { result, ...said } = toClassic('PostToolUseFailure', await runConsent($, payload, sid));
      await apply($, said, e.tool_use_id);
      const lines = result.additionalContext ?? [];
      if (!lines.length) return r;
      return r.deny !== undefined ? { deny: [r.deny, ...lines].join('\n\n') } : { ...r, context: [...(r.context ?? []), ...lines] };
    } catch { return r; }
  }).catch((_$, e, next) => next(e)); // the flag stays as it was; past next, a failure returns the refusal as it came

  on('classic.PreToolUse', { tool: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', /^mcp__plugin_sub-human_room__/] }, async ($, e, next) => {
    if (e.tool === 'AskUserQuestion' && asks.mine(e)) return next(e); // the module's own dialog ($.ui.ask): not consent's
    const sid = await $.session.id();
    if (!consentPreNeeded(await helloOf($), sid, e.tool, await flagOf($))) return next(e);
    const base = prePayload(e, { sid, cwd: await $.session.cwd().catch(() => undefined), facts: facts.of(sid), agentId: facts.agentOf(e.tool_use_id) });
    // ExitPlanMode: whether the person had typed text in the prompt as the view opens (their next keys go to it: item 8)
    const payload = e.tool === 'ExitPlanMode' && draft ? { ...base, sub_human_typing: true } : base;
    const { result, ...said } = toPre(await runConsent($, payload, sid));
    await apply($, said, e.tool_use_id);
    // each answer written out, one branch per shape: the plugin directory reads no spread in a permission answer
    const ctx = result.additionalContext;
    const input = result.updatedInput;
    if ('deny' in result) {
      if (ctx) return { deny: result.deny, additionalContext: ctx };
      return { deny: result.deny };
    }
    if ('ask' in result) {
      if (input && ctx) return { ask: result.ask, updatedInput: input, additionalContext: ctx };
      if (input) return { ask: result.ask, updatedInput: input };
      if (ctx) return { ask: result.ask, additionalContext: ctx };
      return { ask: result.ask };
    }
    return next(e);
  }).catch((_$, e, next) => next(e)); // the call goes on as without consent: nothing is recorded

  on('classic.PostToolUse', { tool_name: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'] }, async ($, e, next) => {
    facts.noteEvent(e);
    if (e.tool_name === 'AskUserQuestion' && asks.mine(e.tool_input)) return next(e); // the module's own dialog: its answer is read where it was asked
    if (!seatedOrUnsure(await helloOf($), e.session_id)) return next(e);
    const { result, ...said } = toClassic('PostToolUse', await runConsent($, e, e.session_id));
    await apply($, said, e.tool_use_id);
    return mergeClassic(result, await next(e));
  }).catch((_$, e, next) => next(e));

  on('classic.Stop', async ($, e, next) => {
    facts.noteEvent(e);
    if (!consentNeeded(await helloOf($), e.session_id, await flagOf($))) return next(e);
    const { result, ...said } = toClassic('Stop', await runConsent($, e, e.session_id));
    await apply($, said);
    return mergeClassic(result, await next(e));
  }).catch((_$, e, next) => next(e)); // a nudge, not a gate: the turn ends as it would


  // the room row's fallback call (auto mode refused the module's own spawn, so the model makes it: mod/deliver.ts
  // tellAsk) draws nothing either, as the module's spawn draws nothing; only that one agent type, from the main loop,
  // while the fallback asks for it
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const row = e.subagent_type === ROOM_AGENT || e.subagent_type === KEEPER_AGENT;
    // the rows are the module's (its own $.agent.spawn is a dispatch this plugin raised): main's model never spawns one
    // (both stay offered for room-chat's resume), but for the auto-mode fallback's one call
    const own = String(next.origin.plugin).split('@')[0] === $.plugin.name.split('@')[0];
    if (!e.agentId && row && !own && !(rowOffered() && e.subagent_type === ROOM_AGENT)) return { deny: ROW_DENY };
    if (!e.agentId && rowOffered() && e.subagent_type === ROOM_AGENT) {
      await hideCall($, e.tool_use_id).catch(() => {});
    }
    if (isChatRow(e.agentId)) quietCall(e.tool_use_id); // the room-chat row's keeper call (auto mode: its model's)
    return next(e);
  }).catch((_$, e, next) => next(e));

  // sub-human's own plan-mode calls draw nothing (docs/next/quiet/SPIKES.md spike 2): a review's false "Entered plan
  // mode", its plan view's "User approved / rejected Claude's plan", an edit's red save (#9). Only the calls consent
  // named (subHuman.quiet, by tool_use_id): a person's own plan mode and every other error draw as Claude Code draws
  // them. Off with the verdict's quiet-plan (cc CONTRACT render-tool-rows-hide): Claude Code's own rows.
  on('ui.render', { component: ['ToolUse', 'ToolResult'] }, async ($, e, next) => {
    const ids = await quietCalls($);
    return quietRow(ids, e.props.tool_use_id) ? EMPTY : next(e);
  }).catch((_$, e, next) => next(e));

  // observe only: whether the person is typing (PromptHint isDraft), for a plan view about to open (item 8)
  on('ui.render', { component: 'PromptHint' }, (_$, e, next) => {
    draft = e.props.isDraft === true;
    return next(e);
  }).catch((_$, e, next) => next(e));
}
