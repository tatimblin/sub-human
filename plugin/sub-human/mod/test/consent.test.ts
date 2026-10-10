// Wiring: consent's per-turn checks (mod/consent.ts). Run with `npm run test:mods`.
// A turn end runs node hooks/consent.ts only while a review may be open; consent's own report clears the flag;
// EnterPlanMode / ExitPlanMode set it again; every PreToolUse hook beneath sees each room tool call.
import { test, expect } from 'claude-code/testing'
import { seatOf, helloOf, ran, scriptOf, session, start } from './support.ts'

const OUT = helloOf(seatOf('bob'))
const SID = 'sid-c'
const POST = 'mcp__plugin_sub-human_room__post'

/** The engine beneath: mod-hello answering `hello`, consent.ts answering in turn from `answers` (the last repeats). */
function world(on: any, { hello = OUT as any, answers = [{ subHuman: { reviewOpen: false } }] as any[] } = {}) {
  const seen = { consent: [] as any[], beneathStop: 0, beneathPre: [] as string[], tools: [] as string[] }
  session(on, SID)
  on('ui.log', () => ({ value: undefined }))
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

test('every PreToolUse hook beneath runs on a room tool, a review open or not; no node starts for it in the module', async ($, on) => {
  const seen = world(on)
  await start($)
  await post($) // unsure
  await stop($) // consent: no review
  await post($)
  await post($)
  expect(seen.beneathPre).toEqual([POST, POST, POST])
  expect(seen.tools).toEqual([POST, POST, POST])
  expect(seen.consent.length).toBe(1) // the Stop only: the room tools' check is the command hook's
})

test('a consent shim that fails leaves the turn end to what is beneath', async ($, on) => {
  on('session.id', () => ({ value: SID }))
  on('process.run', () => ({ deny: 'no processes here' }))
  on('classic.Stop', () => ({ additionalContext: ['beneath'] }))
  const r: any = await stop($)
  expect(r.additionalContext).toEqual(['beneath'])
})
