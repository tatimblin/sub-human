/**
 * plugin/sub-human/mod/consent.ts: consent's hooks, run only where a review or a card can be at stake. The review itself
 * stays in node (hooks/consent.ts): its lock, plan-file writes and via=human signing. $.state reviewMaybeOpen
 * is set true by anything that may open a review (here, and in mod/deliver.ts) and set from consent's own subHuman
 * {reviewOpen} report after every run (SUB_HUMAN_SHIM=1); unset counts as true.
 *   - tool.call EnterPlanMode|ExitPlanMode and the room's plan tool: sets reviewMaybeOpen (an edit counts as open). An ExitPlanMode the person refused in the plan view
 *     (its call comes back denied or as an error: Claude Code runs no PostToolUse for it) goes to node consent at once,
 *     as a PostToolUseFailure with the refusal's text: a note there opens now, its line rides on the refusal the model
 *     reads, and the person gets a notice (lib/consent/review.ts rejected).
 *   - classic.PreToolUse AskUserQuestion|EnterPlanMode|ExitPlanMode and the room tools: node consent (a room tool other
 *     than post only while a review may be open: mod/core/prefilter.ts consentPreNeeded; post always, for a waiting note); its event carries the call alone, so the
 *     payload gets session_id, transcript_path and permission_mode from what the module last saw (mod/core/facts.ts).
 *     It answers only deny or ask, each written out in its return (the plugin directory checks that the person keeps
 *     every permission decision): ask is the plan view of a review, a card, or Claude Code's own "exit plan mode?" for
 *     a closing call; deny is a guard. With neither, the call goes on to the hooks beneath (next(e)), so the module
 *     never allows anything, and never skips another plugin's or the person's hooks unless it denies or asks.
 *   - classic.PostToolUse AskUserQuestion|EnterPlanMode|ExitPlanMode: node consent wherever a seat is or may be.
 *   - the invite's copy card (PLAN-JOIN step 5, mod/core/copy.ts): the module's alone, no node, since the invite line is
 *     only in its memory (mod/deliver.ts copies). Pre: the Copy / Skip card for "copy invite REF" while that line is
 *     held, else a deny that the invite is gone. Post: Copy writes the line (never the PIN) to a clipboard tool on stdin.
 *   - ui.render PromptHint: observed only (next(e) always): whether the prompt holds typed text, sent with an
 *     ExitPlanMode's PreToolUse payload (sub_human_typing) so a plan-view Yes typed into by mistake is asked again.
 *   - classic.Stop: node consent (the open-review nudge) while a review may be open; its additionalContext continues
 *     the turn (cc CONTRACT stop-additional-context).
 *   - prompt.attachment plan_mode (main loop): node consent as a PlanAttachment event while a review or edit may be
 *     open, with the plan file the attachment names; consent seeds a room plan edit there and its subHuman.attach line
 *     is appended to the attachment's text. Not while the hello's verdict turns plan-edit off (no edit opens then: the
 *     plan tool's put stores one).
 * Failure: each .catch passes the event on (a nudge, a card and a review are not gates: nothing is recorded unless the
 * person answered).
 */
import { shimArgv, shimEnv, toClassic, toPre, SHIM_TIMEOUT_MS, SHIM_MODE, asNotice } from './core/shim.ts';
import { consentNeeded, consentPreNeeded, reviewOpenOf, seatedOrUnsure } from './core/prefilter.ts';
import { mergeClassic } from './core/prompt.ts';
import { prePayload, rejectedPayload } from './core/facts.ts';
import { asHello } from './core/state.ts';
import { facts, copies } from './deliver.ts';
import { copyAsked, copyCard, copyOutcome, copySaid, copyTo, copyNews, clipboardCommands, COPY_QUESTION, COPIED, NO_TOOL, GONE } from './core/copy.ts';
import { keepQuiet, quietOn, quietRow } from './core/quiet.ts';
import { ROOM_AGENT } from './core/rows.ts';
import { rowOffered } from './rows.ts';
import { NOTE_ANSWER } from './core/constants.ts';
import type { EngineInterface, On, RenderElement } from 'claude-code';
import type { Hello, RunOutput, SubHumanRead } from './core/types.ts';

const HELLO = { plugin: 'sub-human', key: 'hello' } as const;
/** The room's plan tool: its edit op opens an edit the hooks then run (consent must see the next plan mode). */
const PLAN_TOOL = 'mcp__plugin_sub-human_room__plan';
/** The event consent takes a plan_mode attachment as (lib/cc/env.ts PLAN_ATTACHMENT_EVENT). */
const PLAN_ATTACHMENT = 'PlanAttachment';
const REVIEW = { plugin: 'sub-human', key: 'reviewMaybeOpen' } as const;
const QUIET = { plugin: 'sub-human', key: 'quietCalls' } as const;

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

/** #34: the module's own note card while it is asked ($.ui.ask runs through this plugin's other AskUserQuestion hooks:
 * cc CONTRACT module-ask-through-hooks), so they pass that card by, and only it: its exact question and header. */
let asking: { question: string; header: string } | null = null;
/** The AskUserQuestion call (or its input in a result) is the module's own note card: one of its questions is it. */
function ownCard(input: unknown): boolean {
  const a = asking;
  if (!a || !isRec(input) || !Array.isArray(input.questions)) return false;
  return input.questions.some((q: unknown) => isRec(q) && q.question === a.question && q.header === a.header);
}
/** The person's line when consent did not answer their Send / Discard on that card: it may have recorded the answer
 * before it failed, so the line says only that the note may not have gone. */
const NOTE_NOT_TAKEN = 'Your note may not have been sent; ask your Claude to check its card.';

/** The note's card consent asked for (subHuman.noteAsk), checked, or null. */
function noteAskOf(subHuman: SubHumanRead | undefined): { question: string; header: string; options: string[] } | null {
  const a: unknown = subHuman ? subHuman.noteAsk : undefined;
  if (!a || typeof a !== 'object' || !('question' in a) || !('header' in a) || !('options' in a)) return null;
  const { question, header, options } = a;
  if (typeof question !== 'string' || typeof header !== 'string' || !Array.isArray(options)) return null;
  const labels = options.filter((o): o is string => typeof o === 'string');
  return question && labels.length >= 2 ? { question, header, options: labels } : null;
}

/** The person's Send or Discard on the note's card, asked by the module itself; null when dismissed, typed over
 * ("Other": not a choice the card offers) or with no one to ask (-p). */
async function askNote($: EngineInterface, ask: { question: string; header: string; options: string[] }): Promise<'Send' | 'Discard' | null> {
  asking = { question: ask.question, header: ask.header };
  try {
    const got = await $.ui.ask(ask.question, { options: ask.options, header: ask.header });
    return got === 'Send' || got === 'Discard' ? got : null;
  } catch { return null; } finally { asking = null; }
}

/** An empty drawing: the row is not drawn at all (live 2.1.296: an empty Box takes no line). */
const EMPTY: RenderElement = { type: 'Box', props: {}, children: [] };

/** The prompt holds typed text (the last PromptHint drawn said isDraft): module state, lost on reload (then false). */
let draft = false;

/** $.clock.now(), else the process's own clock (as mod/deliver.ts holds the copy book's times). */
const nowOf = ($: EngineInterface): Promise<number> => $.clock.now().then(t => (typeof t === 'number' ? t : Date.now()), () => Date.now());

/** The copy card's Pre: the card (Copy / Skip) in place of the call's input while the book holds the invite's line,
 * else a deny that says it is gone (mod/core/copy.ts). The ref is remembered by the call's id for its Post. */
async function copyPre($: EngineInterface, asked: { ref: string | null }, toolUseId: unknown): Promise<{ ask: string; updatedInput: Record<string, unknown> } | { deny: string }> {
  const now = await nowOf($);
  const refs = copies.refs(now);
  const ref = asked.ref ?? (refs.length === 1 ? refs[0] ?? null : null);
  if (!ref || !copies.lineFor(ref, now)) return { deny: `sub-human: ${GONE}` };
  if (typeof toolUseId === 'string') copies.ask(toolUseId, ref);
  return { ask: `sub-human: copy invite ${ref}'s line to the clipboard?`, updatedInput: copyCard() };
}

/** The copy card's Post: the person's answer read (exact: an edited card is no answer); on Copy the line goes to the
 * first clipboard tool that takes it, on stdin. The person gets the outcome as a notice, the model as context. */
async function copyPost($: EngineInterface, e: { tool_use_id?: unknown; tool_input?: unknown; tool_response?: unknown }): Promise<string> {
  const now = await nowOf($);
  // the ref the Pre showed this call's card for; else the one the call names, or the one invite held
  const refs = copies.refs(now);
  const ref = (typeof e.tool_use_id === 'string' ? copies.askedRef(e.tool_use_id) : null)
    ?? copyAsked(e.tool_input)?.ref ?? (refs.length === 1 ? refs[0] ?? null : null);
  const line = ref ? copies.lineFor(ref, now) : null;
  const out = copyOutcome(isRec(e.tool_response) ? e.tool_response : null, isRec(e.tool_input) ? e.tool_input : null, line);
  // the session's later invites: copied with no card after a Copy, no card after a Skip (mod/deliver.ts offerCopy)
  if (out.choice) copies.choose(out.choice);
  let said: string;
  if ('say' in out) said = out.say;
  else {
    // the module's $ stays in the file that uses it: the same steps as mod/deliver.ts clip
    const or = (p: Promise<string | undefined>) => p.catch(() => undefined);
    const commands = clipboardCommands({
      WAYLAND_DISPLAY: await or($.env.get('WAYLAND_DISPLAY')), DISPLAY: await or($.env.get('DISPLAY')),
      WSL_DISTRO_NAME: await or($.env.get('WSL_DISTRO_NAME')), WSL_INTEROP: await or($.env.get('WSL_INTEROP')),
    });
    said = (await copyTo((name, init) => $.process.run(['sh', `${$.plugin.root}/scripts/clip.sh`, name], init), out.copy, commands)) === 'copied' ? COPIED : NO_TOOL;
  }
  if (copyNews(said)) $.ui.log(said); else $.ui.log(`copy card: ${said}`, { to: 'debug' });
  return copySaid(said);
}

/** The AskUserQuestion call (or its result) is the copy card's: it asks "copy invite …", or shows the card's question. */
const isCopyCard = (input: unknown, response?: unknown): ReturnType<typeof copyAsked> => copyAsked(input)
  ?? (isRec(response) && JSON.stringify(response.questions ?? []).includes(COPY_QUESTION) ? { ref: null } : null);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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
      let lines = result.additionalContext ?? [];
      // #34: the note's Send / Discard first, asked here while plan mode is still on; consent records the answer and
      // its line (nothing to build, the closing call next) replaces the refusal's "the card next"
      const ask = noteAskOf(said.subHuman);
      if (ask) {
        const label = await askNote($, ask);
        // read as the refusal's own event: its context joins the refusal (toClassic keeps only the fields an event reads)
        const run = await runConsent($, { hook_event_name: NOTE_ANSWER, session_id: sid, sub_human_note: label }, sid).catch(() => null);
        const answered = run ? toClassic('PostToolUseFailure', run) : null;
        // consent did not answer (its report missing: it failed or timed out): the person's Send or Discard may or may
        // not have been recorded first, so they hear that it may not have gone; the model keeps the refusal's own line
        if (!answered || !answered.subHuman) { if (label) $.ui.log(NOTE_NOT_TAKEN); }
        else {
          const { result: res, ...rest } = answered;
          await apply($, rest);
          if (res.additionalContext && res.additionalContext.length) lines = res.additionalContext;
        }
      }
      if (!lines.length) return r;
      return r.deny !== undefined ? { deny: [r.deny, ...lines].join('\n\n') } : { ...r, context: [...(r.context ?? []), ...lines] };
    } catch { return r; }
  }).catch((_$, e, next) => next(e)); // the flag stays as it was; past next, a failure returns the refusal as it came

  on('classic.PreToolUse', { tool: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', /^mcp__plugin_sub-human_room__/] }, async ($, e, next) => {
    if (e.tool === 'AskUserQuestion' && ownCard(e)) return next(e); // the module's own note card ($.ui.ask): not consent's
    // the invite's copy card is the module's alone (the line is only in its memory): no node consent for it
    const copy = e.tool === 'AskUserQuestion' ? isCopyCard(e) : null;
    if (copy) {
      const card = await copyPre($, copy, e.tool_use_id);
      if ('deny' in card) return { deny: card.deny };
      return { ask: card.ask, updatedInput: card.updatedInput };
    }
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
    if (e.tool_name === 'AskUserQuestion' && ownCard(e.tool_input)) return next(e); // the module's own note card: its answer is read where it was asked
    if (e.tool_name === 'AskUserQuestion' && isCopyCard(e.tool_input, e.tool_response)) {
      return mergeClassic({ additionalContext: [await copyPost($, e)] }, await next(e));
    }
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

  // a room plan edit's seed: the plan file is known here, as the request is made (cc CONTRACT module-plan-mode-detail);
  // consent writes the base version there and gives a line to append to the reminder (never replacing its text: it
  // carries plan mode's own rules). Main loop only; nothing runs while no edit or review may be open.
  on('prompt.attachment', { type: 'plan_mode' }, async ($, e, next) => {
    const r = await next(e);
    if (e.agentId || r.text == null) return r;
    const file = e.detail ? e.detail.planFilePath : undefined;
    if (typeof file !== 'string' || !file) return r;
    const sid = await $.session.id();
    const hello = await helloOf($);
    if (!seatedOrUnsure(hello, sid) || !consentNeeded(hello, sid, await flagOf($))) return r;
    if (hello && hello.cc && hello.cc.off.includes('plan-edit')) return r; // plan mode's edit is off: no edit to seed (the plan tool's put)
    const payload = { hook_event_name: PLAN_ATTACHMENT, session_id: sid, cwd: await $.session.cwd().catch(() => undefined), plan_file_path: file, permission_mode: 'plan' };
    const { subHuman, ...said } = toClassic(PLAN_ATTACHMENT, await runConsent($, payload, sid));
    await apply($, { ...said, subHuman });
    const line = subHuman && typeof subHuman.attach === 'string' ? subHuman.attach : '';
    return line ? { text: `${r.text}\n\n${line}` } : r;
  }).catch((_$, e, next) => next(e)); // no seed: the edit's ExitPlanMode seeds the file instead (lib/consent/edit.ts)

  // the room row's fallback call (auto mode refused the module's own spawn, so the model makes it: mod/deliver.ts
  // tellAsk) draws nothing either, as the module's spawn draws nothing; only that one agent type, from the main loop,
  // while the fallback asks for it
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (!e.agentId && rowOffered() && e.subagent_type === ROOM_AGENT) {
      await hideCall($, e.tool_use_id).catch(() => {});
    }
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
