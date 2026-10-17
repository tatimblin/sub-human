// Wiring: consent's hooks (mod/consent.ts). Run with `npm run test:mods`.
// A turn end and a room tool run node consent only while a review may be open; consent's own report clears the flag;
// EnterPlanMode / ExitPlanMode set it again; AskUserQuestion and the plan tools run it for a seat; every PreToolUse hook
// beneath sees each call; the PreToolUse payload carries what the module last saw of the session (mod/core/facts.ts).
import type { On } from 'claude-code'
import { test, expect, type Engine } from 'claude-code/testing'
import { seatOf, helloOf, must, ran, scriptOf, session, start, stdinOf } from './support.ts'

const OUT = helloOf(seatOf('bob'))
const SID = 'sid-c'
const POST = 'mcp__plugin_sub-human_room__post'
const READ = 'mcp__plugin_sub-human_room__read'

/** The engine beneath: mod-hello answering `hello`, consent.ts answering in turn from `answers` (the last repeats). */
type Options = { hello?: ReturnType<typeof helloOf>; answers?: object[]; exit?: { deny: string } }
type Seen = { consent: { stdin: Record<string, unknown>; env: Record<string, string> | undefined }[]; beneathStop: number; beneathPre: string[]; tools: string[]; logs: string[] }
function world(on: On, { hello = OUT, answers = [{ subHuman: { reviewOpen: false } }], exit }: Options = {}) {
  const seen: Seen = { consent: [], beneathStop: 0, beneathPre: [], tools: [], logs: [] }
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('ui.log', (_$, e) => { seen.logs.push(e.text); return { value: undefined } })
  on('process.run', (_$, e) => {
    const script = scriptOf(e)
    if (script === 'mod-hello.ts') return ran(JSON.stringify(hello))
    seen.consent.push({ stdin: stdinOf(e), env: e.init?.env })
    const a = answers[Math.min(seen.consent.length - 1, answers.length - 1)]
    return ran(JSON.stringify(a))
  })
  on('classic.Stop', () => { seen.beneathStop++; return {} })
  // stands for every settings hook beneath the module: consent's command hook (hooks.json PreToolUse
  // ^mcp__plugin_sub-human_room__), another plugin's, the user's
  on('classic.PreToolUse', (_$, e) => { seen.beneathPre.push(e.tool); return {} })
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', (_$, e) => { seen.tools.push(e.tool); return e.tool === 'ExitPlanMode' && exit ? exit : { result: 'ok', text: 'ok' } })
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

test('a room tool during a review: consent gets the call as the classic payload, with the mode and transcript last seen; its deny stands above the hooks beneath', async ($, on) => {
  const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'sub-human: First call ExitPlanMode now' }, ...REVIEWING }
  const seen = world(on, { answers: [deny] })
  on('classic.PostToolUse', () => ({}))
  await start($)
  // what the module last saw of the main loop: EnterPlanMode's PostToolUse, in plan mode now
  await $.classic.PostToolUse({ session_id: SID, transcript_path: '/t/sid-c.jsonl', cwd: '/w', permission_mode: 'plan', tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 'r1' })
  const r = await $.tool.call({ tool: POST, text: 'hi' })
  expect([r.isError, r.text]).toEqual([true, 'sub-human: First call ExitPlanMode now'])
  expect(seen.beneathPre).toEqual([POST])
  const { stdin, env } = must(seen.consent[0], 'the consent run')
  expect([stdin.hook_event_name, stdin.session_id, stdin.tool_name, stdin.permission_mode, stdin.transcript_path, stdin.cwd])
    .toEqual(['PreToolUse', SID, POST, 'plan', '/t/sid-c.jsonl', '/w'])
  expect(stdin.tool_input).toEqual({ text: 'hi' })
  expect(typeof stdin.tool_use_id).toBe('string')
  expect(env?.SUB_HUMAN_SHIM).toBe('1')
})

test('the plan tools run consent for a seat (Pre, Post, and PermissionRequest while a review may be open); an allow\'s reason is a notice', async ($, on) => {
  const allow = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'sub-human: opening proposal abcdef012345 for bob' }, ...REVIEWING }
  const exit = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: {}, updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] } }, subHuman: { reviewOpen: false } }
  const seen = world(on, { answers: [allow, REVIEWING, exit, { subHuman: { reviewOpen: false } }] })
  on('classic.PostToolUse', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  await start($)
  const r = await $.tool.call({ tool: 'EnterPlanMode' })
  expect(r.isError).toBeUndefined()
  expect(seen.logs).toContain('opening proposal abcdef012345 for bob')
  await $.classic.PostToolUse({ session_id: SID, tool_name: 'EnterPlanMode', tool_input: {}, tool_response: {}, tool_use_id: 'e1', permission_mode: 'plan' })
  const p = await $.classic.PermissionRequest({ session_id: SID, tool_name: 'ExitPlanMode', tool_input: {}, permission_mode: 'plan' })
  const decision = must(p.decision, 'a decision')
  expect(decision.behavior).toBe('allow')
  const perm = decision.behavior === 'allow' ? decision.updatedPermissions?.[0] : undefined
  expect(perm && 'mode' in perm ? perm.mode : undefined).toBe('default')
  // the review is closed (consent said so): another PermissionRequest starts no node
  await $.classic.PermissionRequest({ session_id: SID, tool_name: 'ExitPlanMode', tool_input: {}, permission_mode: 'default' })
  expect(seen.consent.map(c => `${String(c.stdin.hook_event_name)} ${String(c.stdin.tool_name)}`))
    .toEqual(['PreToolUse EnterPlanMode', 'PostToolUse EnterPlanMode', 'PermissionRequest ExitPlanMode'])
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
