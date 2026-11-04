// Wiring: consent's hooks (mod/consent.ts). Run with `npm run test:mods`.
// A turn end and a room tool run node consent only while a review may be open; consent's own report clears the flag;
// EnterPlanMode / ExitPlanMode set it again; AskUserQuestion and the plan tools run it for a seat; every PreToolUse hook
// beneath sees each call; the PreToolUse payload carries what the module last saw of the session (mod/core/facts.ts).
import type { On } from 'claude-code'
import { test, expect, type Engine } from 'claude-code/testing'
import { debugLines, seatOf, helloOf, must, ran, scriptOf, session, start, stdinOf } from './support.ts'

const OUT = helloOf(seatOf('bob'))
const SID = 'sid-c'
const POST = 'mcp__plugin_sub-human_room__post'
const READ = 'mcp__plugin_sub-human_room__read'

/** The engine beneath: mod-hello answering `hello`, consent.ts answering in turn from `answers` (the last repeats). */
/** ask: the person's answer on a card the module asks itself ($.ui.ask, an AskUserQuestion call); null: dismissed. */
/** fail: the consent run (0-based) that fails (exit 1, no report). */
type Options = { hello?: ReturnType<typeof helloOf> & { cc?: { version: string; verified: boolean | null; off: string[] } }; answers?: object[]; exit?: { deny: string }; ask?: string | null; fail?: number }
type Seen = { consent: { stdin: Record<string, unknown>; env: Record<string, string> | undefined }[]; beneathStop: number; beneathPre: string[]; tools: string[]; logs: string[] }
function world(on: On, { hello = OUT, answers = [{ subHuman: { reviewOpen: false } }], exit, ask, fail }: Options = {}) {
  const seen: Seen = { consent: [], beneathStop: 0, beneathPre: [], tools: [], logs: [] }
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('ui.log', (_$, e) => { if (e.to === 'debug') debugLines.push(e.text); else seen.logs.push(e.text); return { value: undefined } })
  on('process.run', (_$, e) => {
    const script = scriptOf(e)
    if (script === 'mod-hello.ts') return ran(JSON.stringify(hello))
    seen.consent.push({ stdin: stdinOf(e), env: e.init?.env })
    if (fail === seen.consent.length - 1) return ran('', 1, 'consent failed')
    const a = answers[Math.min(seen.consent.length - 1, answers.length - 1)]
    return ran(JSON.stringify(a))
  })
  on('classic.Stop', () => { seen.beneathStop++; return {} })
  // stands for every settings hook beneath the module: consent's command hook (hooks.json PreToolUse
  // ^mcp__plugin_sub-human_room__), another plugin's, the user's
  on('classic.PreToolUse', (_$, e) => { seen.beneathPre.push(e.tool); return {} })
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', (_$, e) => {
    seen.tools.push(e.tool)
    if (e.tool === 'AskUserQuestion' && ask !== undefined) {
      if (ask === null) return { deny: 'The user doesn\'t want to proceed with this tool use.' }
      const q = String(e.questions[0]?.question)
      return { result: { questions: e.questions, answers: { [q]: ask } }, text: `"${q}"="${ask}"` }
    }
    return e.tool === 'ExitPlanMode' && exit ? exit : { result: 'ok', text: 'ok' }
  })
  on('ui.render', () => ({ type: 'Text', children: ['the engine\'s line'] })) // the engine's drawing, beneath
  return seen
}
const stop = ($: Engine) => $.classic.Stop({ session_id: SID, stop_hook_active: false, permission_mode: 'default' })
/** ExitPlanMode with a plan, as these tests have always called it (the typed input has no `plan`). */
const exitPlan = ($: Engine, plan: string) => $.tool.call({
  tool: 'ExitPlanMode',
  // @ts-expect-error -- deliberate: `plan` is not in the typed ExitPlanMode input; it rides along into the consent payload
  plan,
})
const post = ($: Engine) => $.tool.call({ tool: POST, text: 'hi' })

test('a turn end with no review open starts no node once consent said so; the flag comes back with EnterPlanMode', async ($, on) => {
  const seen = world(on)
  await start($)
  await stop($) // unsure after session.start: consent runs and reports no review
  expect(seen.consent.length).toBe(1)
  const first = must(seen.consent[0], 'the consent run')
  expect(first.env?.SUB_HUMAN_SHIM).toBe('1')
  expect(first.env?.CLAUDE_CODE_SESSION_ID).toBe(SID)
  expect(first.stdin.hook_event_name).toBe('Stop')
  await stop($)
  await stop($)
  expect(seen.consent.length).toBe(1)
  expect(seen.beneathStop).toBe(3)
  await $.tool.call({ tool: 'EnterPlanMode' })
  await stop($)
  expect(seen.consent.length).toBe(2)
})

test('an open review: the nudge continues the turn, and consent runs at every turn end until it closes', async ($, on) => {
  const nudge = { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: "sub-human: bob's room review is still open" }, subHuman: { reviewOpen: true } }
  const seen = world(on, { answers: [nudge, nudge, { subHuman: { reviewOpen: false } }] })
  await start($)
  const r = await stop($)
  expect(r.additionalContext).toEqual(["sub-human: bob's room review is still open"])
  await stop($)
  await stop($)
  await stop($)
  expect(seen.consent.length).toBe(3)
})

test('an unseated session never runs consent', async ($, on) => {
  const seen = world(on, { hello: { ...OUT, seat: null } })
  await start($)
  await stop($)
  await post($)
  expect(seen.consent.length).toBe(0)
})

test('every PreToolUse hook beneath runs on a room tool, a review open or not; node consent only while a review may be open, and always for the post tool (a waiting note refuses it: stage 8e D)', async ($, on) => {
  const seen = world(on)
  await start($)
  const read = ($: Engine) => $.tool.call({ tool: READ })
  await read($) // unsure after session.start: consent runs (and reports no review)
  await stop($) // no review: no node
  await read($)
  await post($)
  await post($)
  expect(seen.beneathPre).toEqual([READ, READ, POST, POST])
  expect(seen.consent.map(c => `${String(c.stdin.hook_event_name)} ${String(c.stdin.tool_name)}`)).toEqual([`PreToolUse ${READ}`, `PreToolUse ${POST}`, `PreToolUse ${POST}`])
})

test('a consent shim that fails leaves the turn end to what is beneath', async ($, on) => {
  on('session.id', () => ({ value: SID }))
  on('process.run', () => ({ deny: 'no processes here' }))
  on('classic.Stop', () => ({ additionalContext: ['beneath'] }))
  const r = await stop($)
  expect(r.additionalContext).toEqual(['beneath'])
})

const REVIEWING = { subHuman: { reviewOpen: true } }

test('a room tool during a review: consent gets the call as the classic payload, with the mode and transcript last seen; its deny is written out and the call goes no further', async ($, on) => {
  const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'sub-human: First call ExitPlanMode now' }, ...REVIEWING }
  const seen = world(on, { answers: [deny] })
  on('classic.PostToolUse', () => ({}))
  await start($)
  // what the module last saw of the main loop: EnterPlanMode's PostToolUse, in plan mode now
  await $.classic.PostToolUse({ session_id: SID, transcript_path: '/t/sid-c.jsonl', cwd: '/w', permission_mode: 'plan', tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 'r1' })
  const r = await $.tool.call({ tool: POST, text: 'hi' })
  expect([r.isError, r.text]).toEqual([true, 'sub-human: First call ExitPlanMode now'])
  // the deny is the module's return, written out (the plugin directory reads it): the hooks beneath do not run for a
  // call it denies
  expect(seen.beneathPre).toEqual([])
  const { stdin, env } = must(seen.consent[0], 'the consent run')
  expect([stdin.hook_event_name, stdin.session_id, stdin.tool_name, stdin.permission_mode, stdin.transcript_path, stdin.cwd])
    .toEqual(['PreToolUse', SID, POST, 'plan', '/t/sid-c.jsonl', '/w'])
  expect(stdin.tool_input).toEqual({ text: 'hi' })
  expect(typeof stdin.tool_use_id).toBe('string')
  expect(env?.SUB_HUMAN_SHIM).toBe('1')
})

test('the plan tools run consent for a seat (Pre and Post); the closing call is an ask with its plan emptied: the module never allows', async ($, on) => {
  const leave = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'sub-human: the room review is over; this only leaves plan mode (no plan is approved)', updatedInput: { plan: '' } }, subHuman: { reviewOpen: false } }
  const seen = world(on, { answers: [REVIEWING, REVIEWING, leave] })
  on('classic.PostToolUse', () => ({}))
  await start($)
  const r = await $.tool.call({ tool: 'EnterPlanMode' })
  expect(r.isError).toBeUndefined()
  await $.classic.PostToolUse({ session_id: SID, tool_name: 'EnterPlanMode', tool_input: {}, tool_response: {}, tool_use_id: 'e1', permission_mode: 'plan' })
  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(seen.consent.map(c => `${String(c.stdin.hook_event_name)} ${String(c.stdin.tool_name)}`))
    .toEqual(['PreToolUse EnterPlanMode', 'PostToolUse EnterPlanMode', 'PreToolUse ExitPlanMode'])
  // EnterPlanMode: consent answered nothing, so the hooks beneath decided; the closing call's ask stood above them
  expect(seen.beneathPre).toEqual(['EnterPlanMode'])
  expect(seen.tools).toEqual(['EnterPlanMode', 'ExitPlanMode'])
})

test('an unseated session runs no consent on the plan tools or the card', async ($, on) => {
  const seen = world(on, { hello: { ...OUT, seat: null } })
  on('classic.PostToolUse', () => ({}))
  await start($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.classic.PostToolUse({ session_id: SID, tool_name: 'AskUserQuestion', tool_input: {}, tool_response: {}, tool_use_id: 'q1' })
  expect(seen.consent).toEqual([])
  expect(seen.beneathPre).toEqual(['AskUserQuestion', 'ExitPlanMode'])
})

test('M (live verify): an ExitPlanMode refused in the plan view goes to consent at once as a PostToolUseFailure; its line rides on the refusal the model reads, the person gets a notice', async ($, on) => {
  const refusal = "The user doesn't want to proceed with this tool use. … the user said:\nplease also add a CODE_OF_CONDUCT\n\nNote: The user's next message …"
  const line = 'sub-human: nothing is recorded yet: bob\'s note on abcdef012345 waits for its card (Send or Discard)'
  const answer = { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: line }, systemMessage: 'sub-human: your note on "Add CONTRIBUTING" is not sent yet', subHuman: { reviewOpen: true, noteWaits: true } }
  const pre = { subHuman: { reviewOpen: true, noteWaits: false } }
  const seen = world(on, { answers: [pre, answer, { subHuman: { reviewOpen: true, noteWaits: true } }], exit: { deny: refusal } })
  await start($)
  const r = await exitPlan($, 'proposal abcdef012345')
  expect(seen.consent.map(c => c.stdin.hook_event_name)).toEqual(['PreToolUse', 'PostToolUseFailure'])
  const sent = must(seen.consent[1], 'the failure\'s consent run').stdin
  expect([sent.hook_event_name, sent.tool_name, sent.permission_mode, sent.error]).toEqual(['PostToolUseFailure', 'ExitPlanMode', 'plan', refusal])
  expect(r.deny).toBe(`${refusal}\n\n${line}`)
  expect(seen.logs).toEqual(['your note on "Add CONTRIBUTING" is not sent yet'])
  // the note waits: a post goes to consent (which refuses it), whatever review flag
  await post($)
  expect(seen.consent.length).toBe(3)
  expect(seen.consent[2]?.stdin.tool_name).toBe(POST)
})

/** #34: a refusal with a note that consent asks the module to put on its own card first (subHuman.noteAsk). */
function noteFirst(on: On, ask: string | null, fail?: number) {
  const refusal = "The user doesn't want to proceed with this tool use. … the user said:\ncap pages at 100\n\nNote: The user's next message …"
  const waits = 'sub-human: nothing is recorded yet: bob\'s note on abcdef012345 waits for its card (Send or Discard)'
  const card = { question: 'room proposal abcdef012345: send bob\'s note to alice?', header: 'Room plan', options: ['Send', 'Discard'] }
  const rejected = { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: waits }, subHuman: { reviewOpen: true, noteWaits: true, noteAsk: card } }
  const said = ask === 'Send' ? 'Recorded. bob objected to proposal abcdef012345. Next, call ExitPlanMode now (no plan needed)'
    : ask === 'Discard' ? 'bob discarded the note; nothing was recorded. Next, call ExitPlanMode now (no plan needed)' : waits
  const answered = { hookSpecificOutput: { hookEventName: 'NoteAnswer', additionalContext: said }, subHuman: { reviewOpen: true, noteWaits: ask === null } }
  const seen = world(on, { answers: [{ subHuman: { reviewOpen: true, noteWaits: false } }, rejected, answered], exit: { deny: refusal }, ask, ...(fail !== undefined ? { fail } : {}) })
  return { seen, refusal, said, card, waits }
}

test('#34 keep-mode: consent failing on the person\'s Send leaves the refusal\'s line for the model, and tells the person in one line that the note still waits', async ($, on) => {
  const { seen, refusal, waits } = noteFirst(on, 'Send', 2)
  await start($)
  const r = await exitPlan($, 'proposal abcdef012345')
  expect(seen.consent.map(c => c.stdin.hook_event_name)).toEqual(['PreToolUse', 'PostToolUseFailure', 'NoteAnswer'])
  expect(r.deny).toBe(`${refusal}\n\n${waits}`)
  expect(seen.logs).toEqual(['your note is not sent yet; it still waits. Ask your Claude for its card to Send or Discard it.'])
})

for (const ask of ['Send', 'Discard', null] as const) {
  test(`#34 keep-mode: a refusal with a note puts Send / Discard on the module's own card at once, in plan mode; the answer (${String(ask)}) goes to consent, and its line replaces the refusal's`, async ($, on) => {
    const { seen, refusal, said, card } = noteFirst(on, ask)
    await start($)
    const r = await exitPlan($, 'proposal abcdef012345')
    expect(seen.consent.map(c => c.stdin.hook_event_name)).toEqual(['PreToolUse', 'PostToolUseFailure', 'NoteAnswer'])
    // the card: the module's own AskUserQuestion, never sent through consent's card rewrite (its own hooks pass it by)
    expect(seen.tools).toEqual(['ExitPlanMode', 'AskUserQuestion'])
    expect(seen.beneathPre).toContain('AskUserQuestion')
    const answer = must(seen.consent[2], 'the answer\'s consent run').stdin
    expect([answer.session_id, answer.sub_human_note]).toEqual([SID, ask])
    expect(r.deny).toBe(`${refusal}\n\n${said}`)
    expect(card.options).toEqual(['Send', 'Discard'])
  })
}

test('M: an ExitPlanMode that ran (a Yes) is not a refusal: no consent run from tool.call', async ($, on) => {
  const seen = world(on)
  await start($)
  const r = await $.tool.call({ tool: 'ExitPlanMode' })
  expect(r.text).toBe('ok')
  expect(seen.consent.map(c => c.stdin.hook_event_name)).toEqual(['PreToolUse'])
})

test('8: the prompt holding typed text as the plan view opens goes with ExitPlanMode\'s consent payload (sub_human_typing); an empty prompt sends none', async ($, on) => {
  const seen = world(on, { answers: [{ subHuman: { reviewOpen: true, noteWaits: false } }] })
  await start($)
  const hint = (isDraft: boolean) => $.ui.mount({ plugin: 'sub-human', surface: 'terminal', component: 'PromptHint', props: { isDraft, isWorking: true, hint: 'esc to interrupt' } })
  let ui = await hint(true)
  await exitPlan($, 'proposal abcdef012345')
  expect(seen.consent[0]?.stdin.sub_human_typing).toBe(true)
  await ui.unmount()
  ui = await hint(false)
  await exitPlan($, 'proposal abcdef012345')
  expect(seen.consent.at(-1)?.stdin.sub_human_typing).toBeUndefined()
  await ui.unmount()
})

test('a plan_mode attachment runs consent only while a review or an edit may be open; consent\'s line is appended, the engine\'s text kept', async ($, on) => {
  const seen = world(on, { answers: [{ subHuman: { reviewOpen: false } }, { subHuman: { reviewOpen: true, attach: 'sub-human: room plan room starts in the plan file' } }] })
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  await start($)
  await stop($) // consent reports no review: the flag is false
  const att: Parameters<typeof $.prompt.attachment>[0] = { type: 'plan_mode', text: 'plan mode rules', origin: { kind: 'engine' }, detail: { reminder: 'full', planFilePath: '/p/x.md', hasPlan: false } }
  expect((await $.prompt.attachment(att)).text).toBe('plan mode rules')
  expect(seen.consent.length).toBe(1)
  // the plan tool (its edit op opens an edit): the next plan_mode attachment goes to consent
  await $.tool.call({ tool: 'mcp__plugin_sub-human_room__plan' })
  expect((await $.prompt.attachment(att)).text).toBe('plan mode rules\n\nsub-human: room plan room starts in the plan file')
  const last = must(seen.consent.at(-1), 'the attachment run')
  expect(last.stdin.hook_event_name).toBe('PlanAttachment')
  expect(last.stdin.plan_file_path).toBe('/p/x.md')
})

test('author first: an ExitPlanMode refused with a note on the person\'s own new version: consent\'s line (write the next version) rides on the refusal, and no note card holds the post tool', async ($, on) => {
  const refusal = "The user doesn't want to proceed with this tool use. … the user said:\ncap pages at 100\n\nNote: The user's next message …"
  const line = 'sub-human: First call ExitPlanMode now (no plan needed; the hooks close the review). Then: Nothing was sent or recorded: bob wants changes to their own new version (plan room v2).'
  const answer = { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: line }, subHuman: { reviewOpen: true, noteWaits: false } }
  const seen = world(on, { answers: [{ subHuman: { reviewOpen: true, noteWaits: false } }, answer, { subHuman: { reviewOpen: false, noteWaits: false } }], exit: { deny: refusal } })
  await start($)
  const r = await exitPlan($, 'proposal abcdef012345')
  expect(seen.consent.map(c => c.stdin.hook_event_name)).toEqual(['PreToolUse', 'PostToolUseFailure'])
  expect(r.deny).toBe(`${refusal}\n\n${line}`)
  expect(seen.logs).toEqual([]) // no notice: nothing waits for the person
  // the closing ExitPlanMode (consent closes the review), then the room is clear: a read runs no consent
  await $.tool.call({ tool: 'ExitPlanMode' })
  const runs = seen.consent.length
  await $.tool.call({ tool: READ })
  expect(seen.consent.length).toBe(runs)
})

/** A tool row as ui.render raises it, for the call id. */
const toolRow = (component: 'ToolUse' | 'ToolResult', id: string, tool: string, isErrored = false) => ({
  plugin: 'sub-human', surface: 'terminal' as const, component,
  props: component === 'ToolUse'
    ? { tool_use_id: id, tool, input: {}, isRunning: false, isErrored, isInterrupted: false }
    : { tool_use_id: id, tool, output: 'User has approved your plan.', isErrored },
})

test('0.6.0 quiet rows (#9, spike 2): the rows of a call consent names quiet (a review\'s plan view, an edit\'s save) draw as nothing; any other call, and every call while quiet-plan is off, draws the engine\'s', async ($, on) => {
  const view = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'sign-off on plan paging v2', updatedInput: { plan: 'Room plan · paging v2 · …' } }, subHuman: { reviewOpen: true, quiet: true } }
  const seen = world(on, { answers: [view, { subHuman: { reviewOpen: true } }] })
  await start($)
  await exitPlan($, 'plan paging v2')
  const id = String(must(seen.consent[0], 'the plan view run').stdin.tool_use_id)
  expect(id.length > 0).toBe(true)
  for (const component of ['ToolUse', 'ToolResult'] as const) {
    let ui = await $.ui.mount(toolRow(component, id, 'ExitPlanMode'))
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual([])
    await ui.unmount()
    // the person's own plan mode, or any other call: never hidden
    ui = await $.ui.mount(toolRow(component, 'toolu_persons_own', 'ExitPlanMode', true))
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(["the engine's line"])
    await ui.unmount()
  }
  // a report that names no quiet call adds none
  await exitPlan($, 'my own plan')
  const other = String(must(seen.consent[1], 'the second run').stdin.tool_use_id)
  const ui = await $.ui.mount(toolRow('ToolResult', other, 'ExitPlanMode'))
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(["the engine's line"])
  await ui.unmount()
})

test('0.6.0 quiet rows: with the verdict\'s quiet-plan off (SUB_HUMAN_CC_OFF or a failed render-tool-rows-hide), a quiet report hides nothing', async ($, on) => {
  const view = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'sign-off', updatedInput: { plan: 'x' } }, subHuman: { reviewOpen: true, quiet: true } }
  const seen = world(on, { hello: { ...OUT, cc: { version: '2.1.302', verified: false, off: ['quiet-plan'] } }, answers: [view] })
  await start($)
  await exitPlan($, 'plan paging v2')
  const id = String(must(seen.consent[0], 'the plan view run').stdin.tool_use_id)
  const ui = await $.ui.mount(toolRow('ToolResult', id, 'ExitPlanMode'))
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(["the engine's line"])
  await ui.unmount()
})
