// Wiring: consent's hooks (mod/consent.ts). Run with `npm run test:mods`.
// A turn end and a room tool run node consent only while a review may be open; consent's own report clears the flag;
// EnterPlanMode / ExitPlanMode set it again; AskUserQuestion and the plan tools run it for a seat; every PreToolUse hook
// beneath sees each call; the PreToolUse payload carries what the module last saw of the session (mod/core/facts.ts).
import { test, expect } from 'claude-code/testing'
import { seatOf, helloOf, ran, scriptOf, session, start } from './support.ts'

const OUT = helloOf(seatOf('bob'))
const SID = 'sid-c'
const POST = 'mcp__plugin_sub-human_room__post'

/** The engine beneath: mod-hello answering `hello`, consent.ts answering in turn from `answers` (the last repeats). */
function world(on: any, { hello = OUT as any, answers = [{ subHuman: { reviewOpen: false } }] as any[] } = {}) {
  const seen = { consent: [] as any[], beneathStop: 0, beneathPre: [] as string[], tools: [] as string[], logs: [] as string[] }
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('ui.log', ($: any, e: any) => { seen.logs.push(e.text); return { value: undefined } })
  on('process.run', ($: any, e: any) => {
    const script = scriptOf(e)
    if (script === 'mod-hello.ts') return ran(JSON.stringify(hello))
    seen.consent.push({ stdin: JSON.parse(e.init.stdin), env: e.init.env })
    const a = answers[Math.min(seen.consent.length - 1, answers.length - 1)]
    return ran(JSON.stringify(a))
  })
  on('classic.Stop', () => { seen.beneathStop++; return {} })
  // stands for every settings hook beneath the module: consent's command hook (hooks.json PreToolUse
  // ^mcp__plugin_sub-human_room__), another plugin's, the user's
  on('classic.PreToolUse', ($: any, e: any) => { seen.beneathPre.push(e.tool); return {} })
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', ($: any, e: any) => { seen.tools.push(e.tool); return { result: 'ok', text: 'ok' } })
  return seen
}
const stop = ($: any) => $.classic.Stop({ session_id: SID, stop_hook_active: false, permission_mode: 'default' } as any)
const post = ($: any) => $.tool.call({ tool: POST, text: 'hi' } as any)

test('a turn end with no review open starts no node once consent said so; the flag comes back with EnterPlanMode', async ($, on) => {
  const seen = world(on)
  await start($)
  await stop($) // unsure after session.start: consent runs and reports no review
  expect(seen.consent.length).toBe(1)
  expect(seen.consent[0].env.SUB_HUMAN_SHIM).toBe('1')
  expect(seen.consent[0].env.CLAUDE_CODE_SESSION_ID).toBe(SID)
  expect(seen.consent[0].stdin.hook_event_name).toBe('Stop')
  await stop($)
  await stop($)
  expect(seen.consent.length).toBe(1)
  expect(seen.beneathStop).toBe(3)
  await $.tool.call({ tool: 'EnterPlanMode' } as any)
  await stop($)
  expect(seen.consent.length).toBe(2)
})

test('an open review: the nudge continues the turn, and consent runs at every turn end until it closes', async ($, on) => {
  const nudge = { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: "sub-human: bob's room review is still open" }, subHuman: { reviewOpen: true } }
  const seen = world(on, { answers: [nudge, nudge, { subHuman: { reviewOpen: false } }] })
  await start($)
  const r: any = await stop($)
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

test('every PreToolUse hook beneath runs on a room tool, a review open or not; node consent only while a review may be open', async ($, on) => {
  const seen = world(on)
  await start($)
  await post($) // unsure after session.start: consent runs (and reports no review)
  await stop($) // no review: no node
  await post($)
  await post($)
  expect(seen.beneathPre).toEqual([POST, POST, POST])
  expect(seen.tools).toEqual([POST, POST, POST])
  expect(seen.consent.map((c: any) => `${c.stdin.hook_event_name} ${c.stdin.tool_name}`)).toEqual([`PreToolUse ${POST}`])
})

test('a consent shim that fails leaves the turn end to what is beneath', async ($, on) => {
  on('session.id', () => ({ value: SID }))
  on('process.run', () => ({ deny: 'no processes here' }))
  on('classic.Stop', () => ({ additionalContext: ['beneath'] }))
  const r: any = await stop($)
  expect(r.additionalContext).toEqual(['beneath'])
})

const REVIEWING = { subHuman: { reviewOpen: true } }

test('a room tool during a review: consent gets the call as the classic payload, with the mode and transcript last seen; its deny stands above the hooks beneath', async ($, on) => {
  const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'sub-human: First call ExitPlanMode now' }, ...REVIEWING }
  const seen = world(on, { answers: [deny] })
  on('classic.PostToolUse', () => ({}))
  await start($)
  // what the module last saw of the main loop: EnterPlanMode's PostToolUse, in plan mode now
  await $.classic.PostToolUse({ session_id: SID, transcript_path: '/t/sid-c.jsonl', cwd: '/w', permission_mode: 'plan', tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 'r1' } as any)
  const r: any = await $.tool.call({ tool: POST, text: 'hi' } as any)
  expect([r.isError, r.text]).toEqual([true, 'sub-human: First call ExitPlanMode now'])
  expect(seen.beneathPre).toEqual([POST])
  const { stdin, env } = seen.consent[0]
  expect([stdin.hook_event_name, stdin.session_id, stdin.tool_name, stdin.permission_mode, stdin.transcript_path, stdin.cwd])
    .toEqual(['PreToolUse', SID, POST, 'plan', '/t/sid-c.jsonl', '/w'])
  expect(stdin.tool_input).toEqual({ text: 'hi' })
  expect(typeof stdin.tool_use_id).toBe('string')
  expect(env.SUB_HUMAN_SHIM).toBe('1')
})

test('the plan tools run consent for a seat (Pre, Post, and PermissionRequest while a review may be open); an allow\'s reason is a notice', async ($, on) => {
  const allow = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'sub-human: opening proposal abcdef012345 for bob' }, ...REVIEWING }
  const exit = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: {}, updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] } }, subHuman: { reviewOpen: false } }
  const seen = world(on, { answers: [allow, REVIEWING, exit, { subHuman: { reviewOpen: false } }] })
  on('classic.PostToolUse', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  await start($)
  const r: any = await $.tool.call({ tool: 'EnterPlanMode' } as any)
  expect(r.isError).toBeUndefined()
  expect(seen.logs).toContain('opening proposal abcdef012345 for bob')
  await $.classic.PostToolUse({ session_id: SID, tool_name: 'EnterPlanMode', tool_input: {}, tool_response: {}, tool_use_id: 'e1', permission_mode: 'plan' } as any)
  const p: any = await $.classic.PermissionRequest({ session_id: SID, tool_name: 'ExitPlanMode', tool_input: {}, permission_mode: 'plan' } as any)
  expect(p.decision.behavior).toBe('allow')
  expect(p.decision.updatedPermissions[0].mode).toBe('default')
  // the review is closed (consent said so): another PermissionRequest starts no node
  await $.classic.PermissionRequest({ session_id: SID, tool_name: 'ExitPlanMode', tool_input: {}, permission_mode: 'default' } as any)
  expect(seen.consent.map((c: any) => `${c.stdin.hook_event_name} ${c.stdin.tool_name}`))
    .toEqual(['PreToolUse EnterPlanMode', 'PostToolUse EnterPlanMode', 'PermissionRequest ExitPlanMode'])
})

test('an unseated session runs no consent on the plan tools or the card', async ($, on) => {
  const seen = world(on, { hello: { ...OUT, seat: null } })
  on('classic.PostToolUse', () => ({}))
  await start($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as any)
  await $.tool.call({ tool: 'ExitPlanMode' } as any)
  await $.classic.PostToolUse({ session_id: SID, tool_name: 'AskUserQuestion', tool_input: {}, tool_response: {}, tool_use_id: 'q1' } as any)
  expect(seen.consent).toEqual([])
  expect(seen.beneathPre).toEqual(['AskUserQuestion', 'ExitPlanMode'])
})
