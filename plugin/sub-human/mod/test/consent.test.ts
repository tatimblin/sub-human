// Wiring: consent's per-turn checks (mod/consent.mjs). Run with `npm run test:mods`.
// A turn end runs node hooks/consent.js only while a review may be open; consent's own report clears the flag;
// EnterPlanMode / ExitPlanMode set it again; a room tool skips consent's command hook while it is clear.
import { test, expect } from 'claude-code/testing'

const SEAT = { name: 'bob', code: 'otter-4821', role: 'member', addr: 'bob.otter-4821' }
const OUT = { home: '/u/.sub-human', realHome: '/u/.sub-human', userHome: '/u', pluginRoot: '/p/sub-human', seat: SEAT }
const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const SID = 'sid-c'
const POST = 'mcp__plugin_sub-human_room__post'

/** The engine beneath: mod-hello answering `hello`, consent.js answering in turn from `answers` (the last repeats). */
function world(on: any, { hello = OUT as any, answers = [{ subHuman: { reviewOpen: false } }] as any[] } = {}) {
  const seen = { consent: [] as any[], beneathStop: 0, beneathPre: [] as string[], tools: [] as string[] }
  on('session.id', () => ({ value: SID }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', ($: any, e: any) => {
    const script = String(e.argv[1]).replace(/^.*\/hooks\//, '')
    if (script === 'mod-hello.js') return ran(JSON.stringify(hello))
    seen.consent.push({ stdin: JSON.parse(e.init.stdin), env: e.init.env })
    const a = answers[Math.min(seen.consent.length - 1, answers.length - 1)]
    return ran(JSON.stringify(a))
  })
  on('classic.Stop', () => { seen.beneathStop++; return {} })
  // stands for consent's command hook (hooks.json PreToolUse ^mcp__plugin_sub-human_room__) beneath the module
  on('classic.PreToolUse', ($: any, e: any) => { seen.beneathPre.push(e.tool); return {} })
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', ($: any, e: any) => { seen.tools.push(e.tool); return { result: 'ok', text: 'ok' } })
  return seen
}
const start = ($: any) => $.session.start({ cwd: '/w', surface: null, isInteractive: true })
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

test('a room tool skips consent\'s command hook while no review is open, and reaches it while one may be', async ($, on) => {
  const seen = world(on)
  await start($)
  await post($) // unsure: consent's command hook runs
  expect(seen.beneathPre).toEqual([POST])
  await stop($) // consent: no review
  await post($)
  await post($)
  expect(seen.beneathPre).toEqual([POST])
  expect(seen.tools).toEqual([POST, POST, POST])
  await $.tool.call({ tool: 'ExitPlanMode' } as any)
  await post($)
  expect(seen.beneathPre).toEqual([POST, 'ExitPlanMode', POST])
})

test('a consent shim that fails leaves the turn end to what is beneath', async ($, on) => {
  on('session.id', () => ({ value: SID }))
  on('process.run', () => ({ deny: 'no processes here' }))
  on('classic.Stop', () => ({ additionalContext: ['beneath'] }))
  const r: any = await stop($)
  expect(r.additionalContext).toEqual(['beneath'])
})
