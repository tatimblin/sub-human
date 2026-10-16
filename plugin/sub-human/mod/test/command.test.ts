// Wiring: /sub-human answered by the module (command.run in mod/deliver.ts). Run with `npm run test:mods`.
// The rules are tested in node (test/mod-core-command.node-test.ts) and join.ts's replies in test/hooks/join.node-test.ts; this
// checks the hook: typed here, join.ts runs once through the shim with the nonce and its reply comes back as notices
// (a secret) or the command's output (none), never as the command running; a join expands as before with the
// mechanics block handed to the expansion hook in place of a second join; the room's Claude, the SDK and a reply that
// failed take the paths they should.
import { test, expect, mock } from 'claude-code/testing'
import { OUT, ran, scriptOf, session, start } from './support.ts'

const SID = 'sid-c'

/** The engine beneath: a session (its cwd), mod-hello, hooks/handlers/join.ts answering `join`, and the command itself (when the
 * hook passes it on: `ran` counts it, and a join's expansion raises classic.UserPromptExpansion as the engine does). */
function world(engine: any, on: any, { join = {} as any, room = undefined as string | undefined } = {}) {
  const seen = { joins: [] as any[], logs: [] as string[], ran: 0, expansions: [] as any[], hellos: 0 }
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'SUB_HUMAN_ROOM' ? room : undefined }))
  on('ui.log', ($: any, e: any) => { seen.logs.push(e.text); return { value: undefined } })
  on('process.run', ($: any, e: any) => {
    const script = scriptOf(e)
    if (script === 'mod-hello.ts') { seen.hellos++; return ran(JSON.stringify(OUT)) }
    if (script === 'join.ts') { seen.joins.push({ stdin: JSON.parse(e.init.stdin), env: e.init.env }); return ran(typeof join === 'string' ? join : JSON.stringify(join)) }
    return ran('')
  })
  on('classic.UserPromptExpansion', ($: any, e: any) => { seen.expansions.push(e); return { additionalContext: ['from the classic join hook'] } })
  on('command.run', async ($: any, e: any) => {
    seen.ran++
    const r = await engine.classic.UserPromptExpansion({ expansion_type: 'slash_command', command_name: 'sub-human:sub-human', command_args: e.args, prompt: `/sub-human ${e.args}`.trim(), session_id: SID } as any)
    return { text: undefined, context: r.additionalContext }
  })
  return seen
}
const typed = ($: any, args: string, kind = 'composer') => $.command.run({ command: 'sub-human:sub-human', args, origin: { kind } } as any)

test('typed here: join.ts runs once through the shim with the nonce; an invite comes back as notices only (no output row, no command run)', async ($, on) => {
  const say = 'invite to room otter-4821 for one machine …\n\n  /sub-human join me@box otter-4821 4821\n'
  const seen = world($, on, { join: { subHuman: { say, refused: false, shareable: false } } })
  await start($)
  const r: any = await typed($, 'invite')
  expect(seen.joins.length).toBe(1)
  const { stdin, env } = seen.joins[0]
  expect([stdin.sub_human_via, stdin.command_args, stdin.session_id, stdin.cwd]).toEqual(['command.run', 'invite', SID, '/w'])
  expect(stdin.sub_human_nonce).toMatch(/^[0-9a-f]{32}$/)
  expect(env.CLAUDE_PID).toBe('')
  expect(seen.ran).toBe(0)
  expect(r.text).toBeUndefined()
  expect(JSON.stringify(r)).not.toContain('4821')
  expect(seen.logs).toEqual(['invite to room otter-4821 for one machine …', '  /sub-human join me@box otter-4821 4821'])
})

test('a reply with no secret is a notice here (the model never reads it, so never repeats it), and the output row through Remote Control', async ($, on) => {
  const seen = world($, on, { join: { subHuman: { say: 'left otter-4821 · /sub-human joins again', refused: false, shareable: true } } })
  await start($)
  const r: any = await typed($, 'leave')
  expect(r.text).toBeUndefined()
  expect(seen.logs).toEqual(['left otter-4821 · /sub-human joins again'])
  const phone: any = await typed($, 'leave', 'bridge')
  expect(phone.text).toMatch(/left otter-4821 · \/sub-human joins again$/)
  expect(seen.logs.length).toBe(1)
  expect(seen.ran).toBe(0)
})

test('a join that worked expands as before: the mechanics block reaches the expansion without a second join, and the confirmation is a notice', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const seen = world($, on, { join: { hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: 'SUB-HUMAN: you are alice…' }, subHuman: { say: 'joined otter-4821 as alice, with bob · @room to talk', joined: true, shareable: true } } })
  await start($)
  const r: any = await typed($, 'alice')
  expect(seen.ran).toBe(1)
  expect(seen.expansions).toEqual([]) // the classic join hook beneath never ran: the module answered with join.ts's block
  expect(r.context).toEqual(['SUB-HUMAN: you are alice…'])
  expect(seen.joins.length).toBe(1)
  await clock.advance(200)
  expect(seen.logs).toEqual(['joined otter-4821 as alice, with bob · @room to talk'])
})

test('the room\'s Claude, the SDK and a PIN typed through Remote Control go to the classic hook; a shim that failed is one notice, and the command does not run', async ($, on) => {
  const seen = world($, on, { join: '' })
  await start($)
  await typed($, '', 'sdk')
  expect([seen.joins.length, seen.ran]).toEqual([0, 1])
  await typed($, 'join dev otter-4821 4821', 'bridge')
  expect([seen.joins.length, seen.ran]).toEqual([0, 2])
  const r: any = await typed($, 'help')
  expect([seen.joins.length, seen.ran]).toEqual([1, 2])
  expect(r.text).toBeUndefined()
  expect(seen.logs).toEqual(['✗ /sub-human did not finish here. Run /sub-human doctor.'])
})

test('in the room\'s Claude (SUB_HUMAN_ROOM set) the launch /sub-human is the classic hook\'s', async ($, on) => {
  const seen = world($, on, { room: 'otter-4821' })
  await start($)
  await typed($, '')
  expect([seen.joins.length, seen.ran]).toEqual([0, 1])
})
