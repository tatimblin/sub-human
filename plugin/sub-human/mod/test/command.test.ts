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
  const seen = { joins: [] as any[], logs: [] as string[], ran: 0, expansions: [] as any[], hellos: 0, commands: [] as string[] }
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'SUB_HUMAN_ROOM' ? room : undefined }))
  on('ui.log', ($: any, e: any) => { seen.logs.push(e.text); return { value: undefined } })
  on('process.run', ($: any, e: any) => {
    const script = scriptOf(e)
    if (script === 'mod-hello.ts') { seen.hellos++; return ran(JSON.stringify(OUT)) }
    if (script === 'join.ts') {
      const stdin = JSON.parse(e.init.stdin)
      seen.joins.push({ stdin, env: e.init.env })
      const j = typeof join === 'function' ? join(stdin) : join
      return ran(typeof j === 'string' ? j : JSON.stringify(j))
    }
    return ran('')
  })
  on('classic.UserPromptExpansion', ($: any, e: any) => { seen.expansions.push(e); return { additionalContext: ['from the classic join hook'] } })
  on('command.run', async ($: any, e: any) => {
    seen.commands.push(`${e.command} ${e.args ?? ''}`.trim())
    if (e.command === 'rename') return { text: `Session renamed to: ${e.args}` }
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

test('an invite\'s line and PIN go to the status line (saved in no transcript), the notices say where they are', async ($, on) => {
  const say = 'invite to room otter-4821 for one machine … are pinned under the prompt until 12:15 …'
  const seen = world($, on, { join: { subHuman: { say, refused: false, shareable: false, pinned: { status: 'invite to otter-4821 until 12:15: /sub-human join me@box otter-4821 SECRET  ·  its PIN, apart from the line (say it, or send it another way): 4821', ms: 900000 } } } })
  const statuses: (string | undefined)[] = []
  on('ui.status', ($: any, e: any) => { statuses.push(e.text); return { value: undefined } })
  await start($)
  const r: any = await typed($, 'invite')
  expect(r.text).toBeUndefined()
  expect(seen.logs.join('\n')).not.toContain(': 4821')
  expect(seen.logs.join('\n')).not.toContain('SECRET')
  expect(statuses.length).toBe(1)
  expect(statuses[0]).toContain('/sub-human join me@box otter-4821 SECRET')
  expect(statuses[0]).toContain(': 4821')
})

test('item 2 (D): a terminal narrower than the whole line pins the PIN and SECRET only, and the notices give the line with SECRET in its place; a cancel of that invite takes it off at once', async ($, on) => {
  const ref = 'abcdef012345'
  const word = '2hmejp4am3wm6rh3767dwrkeg99yyp05ry9js2b'
  const status = `PIN 4821 · /sub-human join tristan@box.example otter-4821 ${word} --home /Users/tristan/.sub-human`
  const pinned = { status, ms: 900000, short: `PIN 4821 · SECRET ${word}`, cut: 'invite to room otter-4821 … Send them this line with SECRET replaced by the word under the prompt:\n  /sub-human join tristan@box.example otter-4821 SECRET --home /Users/tristan/.sub-human\nand tell them the PIN apart', ref }
  const cancel = { subHuman: { say: `invite ${ref} cancelled`, refused: false, shareable: true } }
  const seen = world($, on, { join: (stdin: any) => (String(stdin.command_args).startsWith('invite --cancel') ? cancel : { subHuman: { say: 'invite to room otter-4821 … pinned under the prompt until 12:15 …', refused: false, shareable: false, pinned } }) })
  const statuses: (string | undefined)[] = []
  on('ui.status', ($: any, e: any) => { statuses.push(e.text); return { value: undefined } })
  await start($)
  await $.command.run({ command: 'sub-human:sub-human', args: 'invite', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as any)
  expect(statuses).toEqual([`PIN 4821 · SECRET ${word}`])
  expect(seen.logs.some(l => l.includes('otter-4821 SECRET --home'))).toBe(true)
  expect(seen.logs.join('\n')).not.toContain(word)
  expect(seen.logs.join('\n')).not.toContain('4821 ·')
  await $.command.run({ command: 'sub-human:sub-human', args: 'invite', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 200 } } as any)
  expect(statuses[1]).toBe(status) // wide enough: the whole line, the PIN first
  await typed($, 'invite --cancel')
  expect(statuses.at(-1)).toBeUndefined()
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

test('the room\'s Claude: a typed /clear is answered with the refusal and never runs', async ($, on) => {
  const seen = world($, on, { room: 'otter-4821' })
  await start($)
  const r: any = await $.command.run({ command: 'clear', args: '', origin: { kind: 'composer' } } as any)
  expect(r.text).toMatch(/the room's Claude takes no typed input, commands included/)
  expect(seen.ran).toBe(0)
})

test('a member\'s session: /clear runs as usual', async ($, on) => {
  const seen = world($, on)
  await start($)
  await $.command.run({ command: 'clear', args: '', origin: { kind: 'composer' } } as any)
  expect(seen.ran).toBe(1)
})

test('12 (J): /sub-human leave renames the session to the name alone at once (its NAME.CODE address goes with the seat), not at the next prompt', async ($, on) => {
  const seen = world($, on, { join: { subHuman: { say: 'left otter-4821 · /sub-human joins again', refused: false, shareable: true } } })
  const clock = mock.clock(on, { now: 0 })
  await start($)
  await typed($, 'leave')
  expect(seen.commands).toEqual([]) // nothing from inside the hook: the engine refuses a command.run raised there
  await clock.advance(200)
  for (let i = 0; i < 20 && !seen.commands.includes('rename alice'); i++) await new Promise(r => setTimeout(r, 10))
  expect(seen.commands).toEqual(['rename alice'])
})

test('12: a refused leave, or another command, renames nothing', async ($, on) => {
  const seen = world($, on, { join: { subHuman: { say: '✗ this session is not in a room', refused: true, shareable: true } } })
  await start($)
  await typed($, 'leave')
  await typed($, 'help')
  await new Promise(r => setTimeout(r, 30))
  expect(seen.commands.filter(c => c.startsWith('rename'))).toEqual([])
})
