// Wiring: the skeleton (mod/register.mjs). Run with `npm run test:mods` (claude plugin test plugin/sub-human).
// The test's $ has no state noun, so what the module kept in $.state sub-human/hello is read through the guard:
// a room tool is allowed (tool.check) only once the hello names a seat.
import { test, expect } from 'claude-code/testing'

const POST = 'mcp__plugin_sub-human_room__post'
const SEAT = { name: 'alice', code: 'otter-4821', role: 'member', addr: 'alice.otter-4821' }
const OUT = { home: '/u/.sub-human', realHome: '/private/u/.sub-human', userHome: '/u', pluginRoot: '/p/sub-human', seat: SEAT }
/** The engine beneath: a session id, and the verdict a room tool gets without the module (ask). */
function world(on: any, sid = 'sid-test') {
  on('session.id', () => ({ value: sid }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('tool.check', () => ({ decision: 'ask' }))
}
const verdict = async ($: any) => (await $.tool.check({ tool: POST, input: { text: 'hi' } })).decision
const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('session.start runs hooks/mod-hello.js with the payload session id and keeps the hello in $.state', async ($, on) => {
  const runs: any[] = []
  world(on)
  on('process.run', ($, e: any) => { runs.push(e); return ran(JSON.stringify(OUT) + '\n') })
  expect(await verdict($)).toBe('ask')
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  expect(runs.length).toBe(1)
  const sid = 'sid-test'
  expect(runs[0].argv[0]).toBe('node')
  expect(runs[0].argv[1]).toMatch(/\/hooks\/mod-hello\.js$/)
  expect(JSON.parse(runs[0].init.stdin)).toEqual({ session_id: sid })
  expect(runs[0].init.env.CLAUDE_CODE_SESSION_ID).toBe(sid)
  expect(runs[0].init.env.CLAUDE_PID).toBe('')
  expect(runs[0].init.env.CLAUDE_PLUGIN_ROOT).toBe(runs[0].argv[1].replace(/\/hooks\/mod-hello\.js$/, ''))
  expect(await verdict($)).toBe('allow')
})

test('a failed hello leaves $.state as it was (the module does not know)', async ($, on) => {
  world(on)
  on('process.run', () => ran('', 1))
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  expect(await verdict($)).toBe('ask')
})

test('a hello with no seat keeps the room tools behind the permission prompt', async ($, on) => {
  world(on)
  on('process.run', () => ran(JSON.stringify({ ...OUT, seat: null })))
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  expect(await verdict($)).toBe('ask')
})

test('the join (classic.UserPromptExpansion /sub-human) runs beneath first, then mod-hello for the new seat', async ($, on) => {
  const order: string[] = []
  world(on)
  on('process.run', ($, e: any) => { order.push('hello'); return ran(JSON.stringify(OUT)) })
  on('classic.UserPromptExpansion', () => { order.push('join'); return { additionalContext: ['joined'] } })
  const r = await $.classic.UserPromptExpansion({ expansion_type: 'slash_command', command_name: 'sub-human', command_args: 'alice', prompt: '/sub-human alice', session_id: 'sid-join' } as any)
  expect(r.additionalContext).toEqual(['joined'])
  expect(order).toEqual(['join', 'hello'])
  expect(await verdict($)).toBe('allow')
  // another command: no hello
  await $.classic.UserPromptExpansion({ expansion_type: 'slash_command', command_name: 'review', command_args: '', prompt: '/review' } as any)
  expect(order).toEqual(['join', 'hello', 'join'])
})

test('classic.SessionStart after /clear refreshes the seat for the new session id; startup does not', async ($, on) => {
  const sids: string[] = []
  on('process.run', ($, e: any) => { sids.push(JSON.parse(e.init.stdin).session_id); return ran(JSON.stringify(OUT)) })
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({ source: 'startup', session_id: 'sid-a' } as any)
  await $.classic.SessionStart({ source: 'clear', session_id: 'sid-b' } as any)
  expect(sids).toEqual(['sid-b'])
})

test('a hello that fails does not get in the join\'s way', async ($, on) => {
  on('process.run', () => ({ deny: 'no processes here' }))
  on('classic.UserPromptExpansion', () => ({ additionalContext: ['joined'] }))
  const r = await $.classic.UserPromptExpansion({ expansion_type: 'slash_command', command_name: 'sub-human:sub-human', command_args: 'alice', prompt: '/sub-human alice' } as any)
  expect(r.additionalContext).toEqual(['joined'])
})
