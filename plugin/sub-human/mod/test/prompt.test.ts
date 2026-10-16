// Wiring: the prompt gate and the UserPromptSubmit shim (mod/prompt.ts). Run with `npm run test:mods`.
// The gate's table and the prefilter are tested in node (test/mod-core.node-test.ts, test/hooks/security.node-test.ts); this
// checks the hooks: a peer @room is dropped before anything beneath runs, an unseated prompt starts no node, a
// seated one runs hooks/handlers/prompt.ts with the origin in its stdin, and the shim's answer and notices reach the session.
import type { ClassicResultOf, EventOf, On } from 'claude-code'
import { test, expect, mock, type Engine } from 'claude-code/testing'
import { SEAT, OUT, must, ran, scriptOf, session, start, stdinOf, helloOf, seatOf } from './support.ts'

const SID = 'sid-p'
const NONCE = /^[0-9a-f]{32}$/
/** An @room's receipt (hooks/handlers/at-room.ts): the stop reason the shim answers with. */
const SENT = `✓ sent to room ${SEAT.code} (Claude wasn't asked)`

/**
 * The engine beneath the plugin: a session, mod-hello answering `hello`, hooks/handlers/prompt.ts answering `prompt`, and a
 * core that, like the engine's, runs the UserPromptSubmit hooks inside prompt.submit (cc CONTRACT
 * prompt-submit-ups-order). Returns what ran: the scripts and their stdin, the classic results, the logged lines.
 */
type Stdin = Record<string, unknown>
type Env = Record<string, string> | undefined
type Seen = {
  scripts: string[]; stdin: Stdin[]; env: Env[]; presence: { stdin: Stdin; env: Env }[]; classic: ClassicResultOf['classic.UserPromptSubmit'][]
  logs: string[]; entered: string[]; contexts: EventOf['prompt.submit']['context'][]; hello: ReturnType<typeof helloOf> | null; hellos: Stdin[]
}
function world(engine: Engine, on: On, { hello = OUT, prompt = '', exitCode = 0 }: { hello?: ReturnType<typeof helloOf> | null; prompt?: string; exitCode?: number } = {}) {
  const seen: Seen = { scripts: [], stdin: [], env: [], presence: [], classic: [], logs: [], entered: [], contexts: [], hello, hellos: [] }
  session(on, SID)
  on('ui.log', (_$, e) => { seen.logs.push(e.text); return { value: undefined } })
  on('process.run', (_$, e) => {
    const script = scriptOf(e)
    if (script === 'presence.ts') { seen.presence.push({ stdin: stdinOf(e), env: e.init?.env }); return ran('') }
    seen.scripts.push(script)
    if (script === 'mod-hello.ts') { seen.hellos.push(stdinOf(e)); return ran(seen.hello ? JSON.stringify(seen.hello) : '', seen.hello ? 0 : 1) }
    if (script !== 'prompt.ts') return ran('') // session-restore after a /clear: nothing to say here
    seen.stdin.push(stdinOf(e))
    seen.env.push(e.init?.env)
    return ran(prompt, exitCode)
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.UserPromptExpansion', () => ({}))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  let turns = 0
  on('prompt.submit', async (_$, e) => {
    const r = await engine.classic.UserPromptSubmit({ prompt: e.text, session_id: SID, permission_mode: 'default' })
    seen.classic.push(r)
    seen.entered.push(e.text)
    seen.contexts.push(e.context)
    // as the engine does: a prompt a hook stopped or blocked starts no turn
    if (!r.block && !r.preventContinuation) await engine.turn.start({ text: e.text, turnId: `t${++turns}` }).catch(() => {})
    return { text: e.text }
  })
  return seen
}
/** Where a prompt comes from: typed (composer, sdk, bridge) or not. */
type Kind = 'composer' | 'sdk' | 'bridge' | 'peer' | 'peer-send-message' | 'task-notification' | 'unclassified'
const submit = ($: Engine, text: string, kind: Kind = 'composer') => $.prompt.submit({ text, origin: { kind }, wait: false })

test('a peer @room is dropped before any hook beneath runs; the reason is the drop', async ($, on) => {
  const seen = world($, on)
  await start($)
  const kinds: Kind[] = ['peer', 'peer-send-message', 'task-notification', 'unclassified']
  for (const kind of kinds) {
    const r = await submit($, '@room I agree', kind)
    expect(r.drop).toMatch(/not posted/)
  }
  expect(seen.entered).toEqual([])
  expect(seen.scripts).toEqual(['mod-hello.ts'])
})

test('an unseated session starts no node for a prompt: an @room there is refused by the module, in at-room\'s words', async ($, on) => {
  const seen = world($, on, { hello: { ...OUT, seat: null } })
  await start($)
  await submit($, 'hello there')
  await submit($, '/sub-human alice')
  expect(seen.scripts).toEqual(['mod-hello.ts'])
  await submit($, '@room hi')
  await submit($, '@claude hi') // outside a room an ordinary prompt
  expect(seen.scripts).toEqual(['mod-hello.ts'])
  expect(seen.classic.at(-2)).toEqual({ preventContinuation: true, stopReason: "✗ not posted: this session isn't in a room. Join one first: /sub-human" })
  expect(must(seen.classic.at(-1), 'the last result').block).toBeUndefined()
})

test('before the hello (or after it failed) every prompt runs node: the mod does not know', async ($, on) => {
  const seen = world($, on, { hello: null })
  await start($)
  await submit($, 'hello')
  expect(seen.scripts).toEqual(['mod-hello.ts', 'prompt.ts'])
})

test('a seated prompt runs hooks/handlers/prompt.ts with the origin, the session env and shim mode; its answer and notice come back', async ($, on) => {
  const out = { systemMessage: 'bob joined', subHuman: { reviewOpen: false }, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Room since your last turn: …', sessionTitle: 'alice.otter-4821' } }
  const seen = world($, on, { prompt: JSON.stringify(out) })
  await start($)
  await submit($, 'what is next?')
  expect(seen.scripts).toEqual(['mod-hello.ts', 'prompt.ts'])
  expect(seen.stdin[0]?.prompt).toBe('what is next?')
  expect(seen.stdin[0]?.sub_human_origin).toBe('composer')
  expect(seen.env[0]?.CLAUDE_CODE_SESSION_ID).toBe(SID)
  expect(seen.env[0]?.CLAUDE_PID).toBe('')
  expect(seen.classic[0]?.additionalContext).toEqual(['Room since your last turn: …'])
  expect(seen.classic[0]?.sessionTitle).toBe('alice.otter-4821')
  expect(seen.logs).toEqual(['bob joined'])
})

test('a typed @room posts through node: ✓ sent stops the prompt; sdk and bridge count as typed', async ($, on) => {
  const seen = world($, on, { prompt: JSON.stringify({ continue: false, stopReason: SENT }) })
  await start($)
  const kinds: Kind[] = ['composer', 'sdk', 'bridge']
  for (const kind of kinds) await submit($, '@room ship it', kind)
  expect(seen.stdin.map(s => s.sub_human_origin)).toEqual(['composer', 'sdk', 'bridge'])
  expect(seen.classic[0]?.preventContinuation).toBe(true)
  expect(seen.classic[0]?.stopReason).toBe(SENT)
})

// The test kit has no bottom for session.append in 2.1.292 (a test's answer without next is skipped, and next has no
// implementation, so the call rejects): the test's hook beneath records the row the module handed down.
function rows(on: On) {
  const kept: string[] = []
  on('session.append', (_$, e, next) => {
    const block = must(e.message.content[0], 'a content block')
    if (block.type !== 'text') throw new Error(`a ${block.type} block`)
    kept.push(String(block.text))
    return next(e)
  })
  let n = 0
  return async ($: Engine, text: string, type: 'system' | 'user' = 'system', door: EventOf['session.append']['door'] = 'notice') => {
    await $.session.append({
      message: { type, ...(type === 'system' ? { name: 'informational' } : { role: 'user', isMeta: true }), content: [{ type: 'text', text }] },
      door, origin: { kind: 'engine' }, uuid: `u${n++}`,
    }).catch(() => null)
    return kept.at(-1)
  }
}

test('an @room receipt shows as itself: its stop\'s warning row loses "Operation stopped by hook: ", no other row does', async ($, on) => {
  const seen = world($, on, { prompt: JSON.stringify({ continue: false, stopReason: SENT }) })
  const append = rows(on)
  await start($)
  expect(await append($, `Operation stopped by hook: ${SENT}`)).toBe(`Operation stopped by hook: ${SENT}`) // nothing posted yet
  await submit($, '@room ship it')
  expect(seen.classic[0]?.stopReason).toBe(SENT)
  // stage 8e B: the model's copy says the line went to the room and asks nothing of it
  expect(await append($, `Operation stopped by hook: ${SENT}`, 'user', 'note')).toBe(`sub-human: the person's @room line above went to the room, not to you (${SENT}); nothing is asked of you.`)
  expect(await append($, 'Operation stopped by hook: another plugin')).toBe('Operation stopped by hook: another plugin')
  expect(await append($, `Operation stopped by hook: ${SENT}`)).toBe(SENT)
  expect(await append($, `Operation stopped by hook: ${SENT}`)).toBe(`Operation stopped by hook: ${SENT}`) // once per stop
})

test('a refused @room (a block) leaves no receipt waiting', async ($, on) => {
  const refused = { decision: 'block', reason: '✗ not posted: the room is offline', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true } }
  world($, on, { prompt: JSON.stringify(refused) })
  const append = rows(on)
  await start($)
  await submit($, '@room ship it')
  const frame = 'Operation stopped by hook: ✗ not posted: the room is offline'
  expect(await append($, frame)).toBe(frame)
})

test('a classic UserPromptSubmit with no prompt.submit above it (a lost hand-off) runs node without an origin or nonce', async ($, on) => {
  const seen = world($, on)
  await start($)
  await $.classic.UserPromptSubmit({ prompt: '@room hi', session_id: SID })
  expect(must(seen.stdin[0], 'stdin 0').sub_human_origin).toBe(undefined)
  expect(must(seen.stdin[0], 'stdin 0').sub_human_nonce).toBe(undefined)
})

test('the origin goes with the session\'s nonce, the one mod-hello put in the lease; a new session id gets another', async ($, on) => {
  const seen = world($, on)
  on('classic.SessionStart', () => ({}))
  await start($)
  expect(seen.hellos[0]?.session_id).toBe(SID)
  expect(seen.hellos[0]?.nonce).toMatch(NONCE)
  await submit($, '@room ship it')
  expect(seen.stdin[0]?.sub_human_origin).toBe('composer')
  expect(seen.stdin[0]?.sub_human_nonce).toBe(seen.hellos[0]?.nonce)
  // the join says hello again: the same session, the same nonce
  await $.classic.UserPromptExpansion({ expansion_type: 'slash_command', command_name: 'sub-human', command_args: 'alice', prompt: '/sub-human alice', session_id: SID })
  expect(seen.hellos[1]).toEqual(seen.hellos[0])
  // a /clear: another session id, another nonce; a prompt still carrying the old id gets none
  await $.classic.SessionStart({ source: 'clear', session_id: 'sid-2' })
  expect(seen.hellos[2]?.session_id).toBe('sid-2')
  expect(seen.hellos[2]?.nonce).toMatch(NONCE)
  expect(seen.hellos[2]?.nonce).not.toBe(seen.hellos[0]?.nonce)
  await submit($, '@room again')
  expect(seen.stdin[1]?.sub_human_origin).toBe('composer')
  expect(must(seen.stdin[1], 'stdin 1').sub_human_nonce).toBe(undefined)
})

test('a shim that fails lets the prompt through', async ($, on) => {
  on('session.id', () => ({ value: SID }))
  on('process.run', () => ({ deny: 'no processes here' }))
  on('classic.UserPromptSubmit', () => ({ additionalContext: ['beneath'] }))
  const r = await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: SID })
  expect(r.additionalContext).toEqual(['beneath'])
})

test('a room switch retitles the session with the new address; the same seat is titled once', async ($, on) => {
  const seen = world($, on)
  await start($)
  await submit($, 'hi')
  await submit($, 'again')
  expect(seen.classic.map(r => r.sessionTitle)).toEqual(['alice.otter-4821', undefined])
  seen.hello = { ...OUT, seat: { ...SEAT, code: 'badger-2971', addr: 'alice.badger-2971' } }
  await $.classic.UserPromptExpansion({ expansion_type: 'slash_command', command_name: 'sub-human', command_args: 'alice badger-2971', prompt: '/sub-human alice badger-2971', session_id: SID })
  await submit($, 'in the new room')
  await submit($, 'still there')
  expect(seen.classic.map(r => r.sessionTitle)).toEqual(['alice.otter-4821', undefined, 'alice.badger-2971', undefined])
})

test('an @room fails closed: a shim that cannot run or exits other than 0 or 2 refuses it; a plain prompt goes on', async ($, on) => {
  const seen = world($, on, { exitCode: 1 })
  await start($)
  await submit($, '@room ship it')
  expect(seen.classic[0]?.block).toMatch(/could not check who wrote this @room/)
  expect(seen.classic[0]?.suppressOriginalPrompt).toBe(true)
  await submit($, 'ship it')
  expect(must(seen.classic[1], 'classic 1').block).toBe(undefined)
})

test('@claude in a room: a peer one is dropped like an @room, a typed one runs node, a failed shim refuses it', async ($, on) => {
  const seen = world($, on, { exitCode: 1 })
  await start($)
  const r = await submit($, '@claude plan it', 'peer')
  expect(r.drop).toMatch(/this @claude came from another Claude session/)
  expect(seen.entered).toEqual([])
  await submit($, '@claude ship it')
  expect(seen.scripts).toEqual(['mod-hello.ts', 'prompt.ts'])
  expect(seen.classic[0]?.block).toMatch(/could not check who wrote this @claude/)
  expect(seen.classic[0]?.suppressOriginalPrompt).toBe(true)
})

test('@claude outside a room is an ordinary prompt: no drop, no node, even from a peer', async ($, on) => {
  const seen = world($, on, { hello: { ...OUT, seat: null } })
  await start($)
  await submit($, '@claude what is a monad?')
  const r = await submit($, '@claude from a peer', 'peer')
  expect(r.drop).toBe(undefined)
  expect(seen.entered).toEqual(['@claude what is a monad?', '@claude from a peer'])
  expect(seen.scripts).toEqual(['mod-hello.ts'])
  expect(seen.classic.every(c => c.block === undefined)).toBe(true)
})

test('an @room whose shim is denied is refused, not let through', async ($, on) => {
  on('session.id', () => ({ value: SID }))
  on('process.run', () => ({ deny: 'no processes here' }))
  on('classic.UserPromptSubmit', () => ({ additionalContext: ['beneath'] }))
  const r = await $.classic.UserPromptSubmit({ prompt: '@room hi', session_id: SID })
  expect(r.block).toMatch(/could not check who wrote this @room/)
  expect(r.suppressOriginalPrompt).toBe(true)
})

test('a member\'s typed prompt writes "working" once from the mod, delivering or not; a peer or an unseated one none', async ($, on) => {
  const seen = world($, on)
  await start($)
  await submit($, 'hi')
  await submit($, 'again')
  await submit($, 'a peer asks', 'peer')
  await new Promise(r => setTimeout(r, 20))
  expect(seen.presence.length).toBe(1)
  expect(seen.presence[0]?.stdin).toEqual({ hook_event_name: 'Working', session_id: SID })
  expect(seen.presence[0]?.env?.CLAUDE_CODE_SESSION_ID).toBe(SID)
  expect(seen.presence[0]?.env?.CLAUDE_PID).toBe('')
  expect(seen.stdin[0]?.sub_human_origin).toBe('composer') // at-room, given the origin, leaves presence to the mod
})

test('O (live verify): a typed prompt the plugin stops (an @room\'s receipt) or refuses starts no turn and writes no "working"', async ($, on) => {
  const stopped = { continue: false, stopReason: '✓ sent', subHuman: { reviewOpen: false } }
  const seen = world($, on, { prompt: JSON.stringify(stopped) })
  await start($)
  await submit($, '@room hi')
  await new Promise(r => setTimeout(r, 20))
  expect(seen.classic[0]?.preventContinuation).toBe(true)
  expect(seen.presence.length).toBe(0)
})

test('O: a refused prompt (a block) writes no "working" either', async ($, on) => {
  const refused = { decision: 'block', reason: '✗ not posted', subHuman: { reviewOpen: false } }
  const seen = world($, on, { prompt: JSON.stringify(refused) })
  await start($)
  await submit($, '@room hi')
  await new Promise(r => setTimeout(r, 20))
  expect(seen.presence.length).toBe(0)
})

test('an unseated session writes no presence', async ($, on) => {
  const seen = world($, on, { hello: { ...OUT, seat: null } })
  await start($)
  await submit($, 'hi')
  await new Promise(r => setTimeout(r, 20))
  expect(seen.presence.length).toBe(0)
})

test('an @room typed through Remote Control: a refusal is relayed as a prompt of its own (no notice shows there); "✓ sent" is not', async ($, on) => {
  const refused = { decision: 'block', reason: '✗ not posted: the room is offline', systemMessage: 'sub-human: ✗ not posted: the room is offline', subHuman: { reviewOpen: false }, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true } }
  const seen = world($, on, { prompt: JSON.stringify(refused) })
  const clock = mock.clock(on, { now: 0 })
  await start($)
  await submit($, '@room ship it', 'bridge')
  expect(seen.stdin[0]?.sub_human_origin).toBe('bridge')
  expect(seen.classic[0]?.block).toMatch(/offline/)
  const relayed = () => seen.entered.filter(t => t.startsWith('sub-human: ✗'))
  expect(relayed()).toEqual([]) // not from inside the hook that holds the prompt
  expect(seen.logs).toEqual([]) // and no notice: the phone would not show it
  await clock.advance(250)
  const t0 = Date.now()
  while (!relayed().length && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 20))
  expect(relayed()).toEqual(['sub-human: ✗ not posted: the room is offline']) // only the line the person reads
  const i = seen.entered.length - 1
  expect([...(seen.contexts[i] ?? []), ...(must(seen.classic[i], 'the relay\'s result').additionalContext ?? [])]).toEqual([expect.stringMatching(/^\(for Claude\) sub-human: .*It needs no reply/)])
  expect(seen.scripts.filter(x => x === 'prompt.ts').length).toBe(1) // no node for the relay
  // typed here, the same answer is a notice
  const n = seen.logs.length
  await submit($, '@room again')
  expect(seen.logs.slice(n)).toEqual(['✗ not posted: the room is offline']) // $.ui.log puts "sub-human: " before it: never twice
})

test('an @room typed through Remote Control that posted ("✓ sent", no systemMessage) relays nothing: no model turn', async ($, on) => {
  const sent = { continue: false, stopReason: SENT, subHuman: { reviewOpen: false }, hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } }
  const seen = world($, on, { prompt: JSON.stringify(sent) })
  const clock = mock.clock(on, { now: 0 })
  await start($)
  await submit($, '@room hi', 'bridge')
  expect(seen.classic[0]?.preventContinuation).toBe(true)
  await clock.advance(5000)
  await new Promise(r => setTimeout(r, 200))
  expect(seen.entered).toEqual(['@room hi']) // this world's engine enters every prompt; no relay after it
  expect(seen.logs.filter(l => !/didn't arrive here/.test(l))).toEqual([]) // (this world runs no tail child)
})

test('13 (K/Q): a plain prompt typed into the room\'s Claude is a stop with the hint, drawn as the hint alone: no "blocked by hook" frame, nothing put back in the input, no turn', async ($, on) => {
  const HINT = '✗ the room\'s Claude takes no typed input; type @claude in your own session, or ask your Claude to message claude.otter-4821'
  const seen = world($, on, { hello: helloOf(seatOf('claude', 'claude')), prompt: JSON.stringify({ continue: false, stopReason: HINT, subHuman: { reviewOpen: false } }) })
  const append = rows(on)
  await start($)
  await submit($, 'please tidy the task list')
  expect(seen.classic[0]?.preventContinuation).toBe(true)
  expect(must(seen.classic[0], 'classic 0').block).toBeUndefined()
  expect(seen.classic[0]?.stopReason).toBe(HINT)
  expect(await append($, `Operation stopped by hook: ${HINT}`)).toBe(HINT)
  expect(seen.presence.length).toBe(0)
})
