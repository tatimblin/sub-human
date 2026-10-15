// Wiring: the prompt gate and the UserPromptSubmit shim (mod/prompt.ts). Run with `npm run test:mods`.
// The gate's table and the prefilter are tested in node (test/mod-core.node-test.ts, test/hooks/security.node-test.ts); this
// checks the hooks: a peer @room is dropped before anything beneath runs, an unseated prompt starts no node, a
// seated one runs hooks/prompt.ts with the origin in its stdin, and the shim's answer and notices reach the session.
import { test, expect, mock } from 'claude-code/testing'
import { SEAT, OUT, ran, scriptOf, session, start } from './support.ts'

const SID = 'sid-p'
const NONCE = /^[0-9a-f]{32}$/
/** An @room's receipt (hooks/at-room.ts): the stop reason the shim answers with. */
const SENT = `✓ sent to room ${SEAT.code} (Claude wasn't asked)`

/**
 * The engine beneath the plugin: a session, mod-hello answering `hello`, hooks/prompt.ts answering `prompt`, and a
 * core that, like the engine's, runs the UserPromptSubmit hooks inside prompt.submit (cc CONTRACT
 * prompt-submit-ups-order). Returns what ran: the scripts and their stdin, the classic results, the logged lines.
 */
function world(engine: any, on: any, { hello = OUT as any, prompt = '', exitCode = 0 } = {}) {
  const seen = {
    scripts: [] as string[], stdin: [] as any[], env: [] as any[], presence: [] as any[], classic: [] as any[],
    logs: [] as string[], entered: [] as string[], contexts: [] as any[], hello: hello as any, hellos: [] as any[],
  }
  session(on, SID)
  on('ui.log', ($: any, e: any) => { seen.logs.push(e.text); return { value: undefined } })
  on('process.run', ($: any, e: any) => {
    const script = scriptOf(e)
    if (script === 'presence.ts') { seen.presence.push({ stdin: JSON.parse(e.init.stdin), env: e.init.env }); return ran('') }
    seen.scripts.push(script)
    if (script === 'mod-hello.ts') { seen.hellos.push(JSON.parse(e.init.stdin)); return ran(seen.hello ? JSON.stringify(seen.hello) : '', seen.hello ? 0 : 1) }
    seen.stdin.push(JSON.parse(e.init.stdin))
    seen.env.push(e.init.env)
    return ran(prompt, exitCode)
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.UserPromptExpansion', () => ({}))
  on('prompt.submit', async ($: any, e: any) => {
    const r = await engine.classic.UserPromptSubmit({ prompt: e.text, session_id: SID, permission_mode: 'default' })
    seen.classic.push(r)
    seen.entered.push(e.text)
    seen.contexts.push(e.context)
    return { text: e.text }
  })
  return seen
}
const submit = ($: any, text: string, kind = 'composer') => $.prompt.submit({ text, origin: { kind }, wait: false } as any)

test('a peer @room is dropped before any hook beneath runs; the reason is the drop', async ($, on) => {
  const seen = world($, on)
  await start($)
  for (const kind of ['peer', 'peer-send-message', 'task-notification', 'unclassified']) {
    const r: any = await submit($, '@room I agree', kind)
    expect(r.drop).toMatch(/not posted/)
  }
  expect(seen.entered).toEqual([])
  expect(seen.scripts).toEqual(['mod-hello.ts'])
})

test('an unseated session starts no node for a plain prompt; an @room there still reaches node (its refusal)', async ($, on) => {
  const seen = world($, on, { hello: { ...OUT, seat: null }, prompt: JSON.stringify({ decision: 'block', reason: '✗ not posted: this session is not in a room.', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true } }) })
  await start($)
  await submit($, 'hello there')
  await submit($, '/sub-human alice')
  expect(seen.scripts).toEqual(['mod-hello.ts'])
  await submit($, '@room hi')
  expect(seen.scripts).toEqual(['mod-hello.ts', 'prompt.ts'])
  expect(seen.classic.at(-1).block).toMatch(/not in a room/)
})

test('before the hello (or after it failed) every prompt runs node: the mod does not know', async ($, on) => {
  const seen = world($, on, { hello: null })
  await start($)
  await submit($, 'hello')
  expect(seen.scripts).toEqual(['mod-hello.ts', 'prompt.ts'])
})

test('a seated prompt runs hooks/prompt.ts with the origin, the session env and shim mode; its answer and notice come back', async ($, on) => {
  const out = { systemMessage: 'bob joined', subHuman: { reviewOpen: false }, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Room since your last turn: …', sessionTitle: 'alice.otter-4821' } }
  const seen = world($, on, { prompt: JSON.stringify(out) })
  await start($)
  await submit($, 'what is next?')
  expect(seen.scripts).toEqual(['mod-hello.ts', 'prompt.ts'])
  expect(seen.stdin[0].prompt).toBe('what is next?')
  expect(seen.stdin[0].sub_human_origin).toBe('composer')
  expect(seen.env[0].CLAUDE_CODE_SESSION_ID).toBe(SID)
  expect(seen.env[0].CLAUDE_PID).toBe('')
  expect(seen.classic[0].additionalContext).toEqual(['Room since your last turn: …'])
  expect(seen.classic[0].sessionTitle).toBe('alice.otter-4821')
  expect(seen.logs).toEqual(['bob joined'])
})

test('a typed @room posts through node: ✓ sent stops the prompt; sdk and bridge count as typed', async ($, on) => {
  const seen = world($, on, { prompt: JSON.stringify({ continue: false, stopReason: SENT }) })
  await start($)
  for (const kind of ['composer', 'sdk', 'bridge']) await submit($, '@room ship it', kind)
  expect(seen.stdin.map((s: any) => s.sub_human_origin)).toEqual(['composer', 'sdk', 'bridge'])
  expect(seen.classic[0].preventContinuation).toBe(true)
  expect(seen.classic[0].stopReason).toBe(SENT)
})

// The test kit has no bottom for session.append in 2.1.292 (a test's answer without next is skipped, and next has no
// implementation, so the call rejects): the test's hook beneath records the row the module handed down.
function rows(on: any) {
  const kept: string[] = []
  on('session.append', ($: any, e: any, next: any) => { kept.push(e.message.content[0].text); return next(e) })
  let n = 0
  return async ($: any, text: string, type = 'system', door = 'notice') => {
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
  expect(seen.classic[0].stopReason).toBe(SENT)
  expect(await append($, `Operation stopped by hook: ${SENT}`, 'user', 'note')).toBe(`Operation stopped by hook: ${SENT}`) // the model's copy
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
  await $.classic.UserPromptSubmit({ prompt: '@room hi', session_id: SID } as any)
  expect(seen.stdin[0].sub_human_origin).toBe(undefined)
  expect(seen.stdin[0].sub_human_nonce).toBe(undefined)
})

test('the origin goes with the session\'s nonce, the one mod-hello put in the lease; a new session id gets another', async ($, on) => {
  const seen = world($, on)
  on('classic.SessionStart', () => ({}))
  await start($)
  expect(seen.hellos[0].session_id).toBe(SID)
  expect(seen.hellos[0].nonce).toMatch(NONCE)
  await submit($, '@room ship it')
  expect(seen.stdin[0].sub_human_origin).toBe('composer')
  expect(seen.stdin[0].sub_human_nonce).toBe(seen.hellos[0].nonce)
  // the join says hello again: the same session, the same nonce
  await $.classic.UserPromptExpansion({ command_name: 'sub-human', command_args: 'alice', session_id: SID } as any)
  expect(seen.hellos[1]).toEqual(seen.hellos[0])
  // a /clear: another session id, another nonce; a prompt still carrying the old id gets none
  await $.classic.SessionStart({ source: 'clear', session_id: 'sid-2' } as any)
  expect(seen.hellos[2].session_id).toBe('sid-2')
  expect(seen.hellos[2].nonce).toMatch(NONCE)
  expect(seen.hellos[2].nonce).not.toBe(seen.hellos[0].nonce)
  await submit($, '@room again')
  expect(seen.stdin[1].sub_human_origin).toBe('composer')
  expect(seen.stdin[1].sub_human_nonce).toBe(undefined)
})

test('a shim that fails lets the prompt through', async ($, on) => {
  on('session.id', () => ({ value: SID }))
  on('process.run', () => ({ deny: 'no processes here' }))
  on('classic.UserPromptSubmit', () => ({ additionalContext: ['beneath'] }))
  const r: any = await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: SID } as any)
  expect(r.additionalContext).toEqual(['beneath'])
})

test('a room switch retitles the session with the new address; the same seat is titled once', async ($, on) => {
  const seen = world($, on)
  await start($)
  await submit($, 'hi')
  await submit($, 'again')
  expect(seen.classic.map((r: any) => r.sessionTitle)).toEqual(['alice.otter-4821', undefined])
  seen.hello = { ...OUT, seat: { ...SEAT, code: 'badger-2971', addr: 'alice.badger-2971' } }
  await $.classic.UserPromptExpansion({ command_name: 'sub-human', command_args: 'alice badger-2971', session_id: SID } as any)
  await submit($, 'in the new room')
  await submit($, 'still there')
  expect(seen.classic.map((r: any) => r.sessionTitle)).toEqual(['alice.otter-4821', undefined, 'alice.badger-2971', undefined])
})

test('an @room fails closed: a shim that cannot run or exits other than 0 or 2 refuses it; a plain prompt goes on', async ($, on) => {
  const seen = world($, on, { exitCode: 1 })
  await start($)
  await submit($, '@room ship it')
  expect(seen.classic[0].block).toMatch(/could not check who wrote this @room/)
  expect(seen.classic[0].suppressOriginalPrompt).toBe(true)
  await submit($, 'ship it')
  expect(seen.classic[1].block).toBe(undefined)
})

test('@claude in a room: a peer one is dropped like an @room, a typed one runs node, a failed shim refuses it', async ($, on) => {
  const seen = world($, on, { exitCode: 1 })
  await start($)
  const r: any = await submit($, '@claude plan it', 'peer')
  expect(r.drop).toMatch(/this @claude came from another Claude session/)
  expect(seen.entered).toEqual([])
  await submit($, '@claude ship it')
  expect(seen.scripts).toEqual(['mod-hello.ts', 'prompt.ts'])
  expect(seen.classic[0].block).toMatch(/could not check who wrote this @claude/)
  expect(seen.classic[0].suppressOriginalPrompt).toBe(true)
})

test('@claude outside a room is an ordinary prompt: no drop, no node, even from a peer', async ($, on) => {
  const seen = world($, on, { hello: { ...OUT, seat: null } })
  await start($)
  await submit($, '@claude what is a monad?')
  const r: any = await submit($, '@claude from a peer', 'peer')
  expect(r.drop).toBe(undefined)
  expect(seen.entered).toEqual(['@claude what is a monad?', '@claude from a peer'])
  expect(seen.scripts).toEqual(['mod-hello.ts'])
  expect(seen.classic.every((c: any) => c.block === undefined)).toBe(true)
})

test('an @room whose shim is denied is refused, not let through', async ($, on) => {
  on('session.id', () => ({ value: SID }))
  on('process.run', () => ({ deny: 'no processes here' }))
  on('classic.UserPromptSubmit', () => ({ additionalContext: ['beneath'] }))
  const r: any = await $.classic.UserPromptSubmit({ prompt: '@room hi', session_id: SID } as any)
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
  expect(seen.presence[0].stdin).toEqual({ hook_event_name: 'Working', session_id: SID })
  expect(seen.presence[0].env.CLAUDE_CODE_SESSION_ID).toBe(SID)
  expect(seen.presence[0].env.CLAUDE_PID).toBe('')
  expect(seen.stdin[0].sub_human_origin).toBe('composer') // at-room, given the origin, leaves presence to the mod
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
  expect(seen.stdin[0].sub_human_origin).toBe('bridge')
  expect(seen.classic[0].block).toMatch(/offline/)
  const relayed = () => seen.entered.filter(t => t.startsWith('sub-human: ✗'))
  expect(relayed()).toEqual([]) // not from inside the hook that holds the prompt
  expect(seen.logs).toEqual([]) // and no notice: the phone would not show it
  await clock.advance(250)
  const t0 = Date.now()
  while (!relayed().length && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 20))
  expect(relayed()).toEqual(['sub-human: ✗ not posted: the room is offline']) // only the line the person reads
  const i = seen.entered.length - 1
  expect([...(seen.contexts[i] ?? []), ...(seen.classic[i].additionalContext ?? [])]).toEqual([expect.stringMatching(/^\(for Claude\) sub-human: .*It needs no reply/)])
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
  expect(seen.classic[0].preventContinuation).toBe(true)
  await clock.advance(5000)
  await new Promise(r => setTimeout(r, 200))
  expect(seen.entered).toEqual(['@room hi']) // this world's engine enters every prompt; no relay after it
  expect(seen.logs.filter(l => !/didn't arrive here/.test(l))).toEqual([]) // (this world runs no tail child)
})
