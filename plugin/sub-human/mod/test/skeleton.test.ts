// Wiring: the skeleton (mod/register.ts). Run with `npm run test:mods` (claude plugin test plugin/sub-human).
// The test's $ has no state noun, so what the module kept in $.state sub-human/hello is read through the guard:
// a room tool is allowed (tool.check) only once the hello names a seat.
import type { EventOf, On } from 'claude-code'
import { test, expect, type Engine } from 'claude-code/testing'
import { OUT as HELLO, ran, scriptOf, must, session, stdinOf } from './support.ts'

const POST = 'mcp__plugin_sub-human_room__post'
const OUT = { ...HELLO, realHome: '/private/u/.sub-human' }
/** The engine beneath: a session id, and the verdict a room tool gets without the module (ask). */
function world(on: On, sid = 'sid-test') {
  session(on, sid)
  on('tool.check', () => ({ decision: 'ask' }))
}
const verdict = async ($: Engine) => (await $.tool.check({ tool: POST, input: { text: 'hi' } })).decision

test('session.start runs hooks/run.ts mod-hello with the payload session id and keeps the hello in $.state', async ($, on) => {
  const runs: EventOf['process.run'][] = []
  world(on)
  on('process.run', (_$, e) => { runs.push(e); return ran(JSON.stringify(OUT) + '\n') })
  expect(await verdict($)).toBe('ask')
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  expect(runs.length).toBe(1)
  const sid = 'sid-test'
  const run = must(runs[0], 'the hello run')
  expect(run.argv[0]).toBe('sh')
  expect(run.argv[1]).toMatch(/\/hooks\/node\.sh$/)
  expect(run.argv[2]).toBe('--import')
  expect(run.argv[3]).toMatch(/\/hooks\/compile-cache\.js$/)
  expect(run.argv[4]).toMatch(/\/hooks\/run\.ts$/)
  expect(run.argv[5]).toBe('mod-hello')
  const stdin = stdinOf(run)
  expect(stdin.session_id).toBe(sid)
  expect(stdin.nonce).toMatch(/^[0-9a-f]{32}$/) // the lease keeps it; at-room checks an origin against it
  const env = must(run.init?.env, 'its env')
  expect(env.CLAUDE_CODE_SESSION_ID).toBe(sid)
  expect(env.CLAUDE_PID).toBe('')
  expect(env.CLAUDE_PLUGIN_ROOT).toBe(must(run.argv[4], 'the runner path').replace(/\/hooks\/run\.ts$/, ''))
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

test('the join (classic.UserPromptExpansion /sub-human): the lease first, the join beneath, then mod-hello for the new seat', async ($, on) => {
  const order: string[] = []
  world(on)
  on('process.run', () => { order.push('hello'); return ran(JSON.stringify(OUT)) })
  on('classic.UserPromptExpansion', () => { order.push('join'); return { additionalContext: ['joined'] } })
  const r = await $.classic.UserPromptExpansion({ expansion_type: 'slash_command', command_name: 'sub-human', command_args: 'alice', prompt: '/sub-human alice', session_id: 'sid-join' })
  expect(r.additionalContext).toEqual(['joined'])
  // no hello for this session id yet: its lease (the join refuses a session without one), then the new seat's
  expect(order).toEqual(['hello', 'join', 'hello'])
  expect(await verdict($)).toBe('allow')
  // the same session again: the lease is written already
  await $.classic.UserPromptExpansion({ expansion_type: 'slash_command', command_name: 'sub-human', command_args: '', prompt: '/sub-human', session_id: 'sid-join' })
  expect(order).toEqual(['hello', 'join', 'hello', 'join', 'hello'])
  // another command: no hello
  await $.classic.UserPromptExpansion({ expansion_type: 'slash_command', command_name: 'review', command_args: '', prompt: '/review' })
  expect(order).toEqual(['hello', 'join', 'hello', 'join', 'hello', 'join'])
})

test('classic.SessionStart after /clear puts the seat back (session-restore) and says hello for the new session id; startup does neither', async ($, on) => {
  const runs: string[] = []
  on('process.run', (_$, e) => { runs.push(`${scriptOf(e)} ${String(stdinOf(e).session_id)}`); return ran(scriptOf(e) === 'mod-hello.ts' ? JSON.stringify(OUT) : '') })
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({ source: 'startup', session_id: 'sid-a' })
  await $.classic.SessionStart({ source: 'clear', session_id: 'sid-b' })
  expect(runs).toEqual(['session-restore.ts sid-b', 'mod-hello.ts sid-b'])
})

test('a hello that fails does not get in the join\'s way', async ($, on) => {
  on('process.run', () => ({ deny: 'no processes here' }))
  on('classic.UserPromptExpansion', () => ({ additionalContext: ['joined'] }))
  const r = await $.classic.UserPromptExpansion({ expansion_type: 'slash_command', command_name: 'sub-human:sub-human', command_args: 'alice', prompt: '/sub-human alice' })
  expect(r.additionalContext).toEqual(['joined'])
})
