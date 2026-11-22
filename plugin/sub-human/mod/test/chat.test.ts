// Wiring: the room row as the room's chat (mod/chat.ts, room-chat on). Run with `npm run test:mods`.
// The row (sub-human:room, named the room code) is spawned at a turn's start; the module answers every one of its
// steps and its keeper's, so no step reaches the model beneath (`model` counts the ones that did). A typed line posts
// the person's exact words through node at-room; a room line from the tail is sent to the row and drawn there with its
// author; the status line under main's prompt is the row's.
import type { AgentInfo, Chunk, On, TurnStepInput } from 'claude-code'
import { test, expect, type Engine } from 'claude-code/testing'
import { CODE, SEAT, helloOf, must, ran, scriptOf, session, start, stdinOf } from './support.ts'

const SID = 'sid-c'
const TYPED = (text: string) => `The user sent a new message while you were working:\n${text}\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue.`

type Seen = {
  agents: AgentInfo[]; spawns: Record<string, unknown>[]; sends: { to: string; text: string }[]; posts: Record<string, unknown>[]
  statuses: (string | undefined)[]; model: number; store: Map<string, unknown>; feed: (ev: object) => void; now: number
  /** what $.session.messages answers (an agent's rows: its keeper's hold result) */
  messages: { role: 'user' | 'assistant'; text: string; toolUses: []; toolResults?: { tool_use_id: string; text: string; isError: boolean }[] }[]
  /** main's prompts the module submitted, and the user rows it appended to main */
  submits: string[]; appends: string[]; logs: string[]
}
function world(on: On, { off = [] }: { off?: string[] } = {}): Seen {
  const seen: Seen = { agents: [], spawns: [], sends: [], posts: [], statuses: [], model: 0, store: new Map(), feed: () => {}, now: 1_000_000, messages: [], submits: [], appends: [], logs: [] }
  const fed: string[] = []
  let poke = () => {}
  seen.feed = ev => { fed.push(JSON.stringify(ev) + '\n'); poke() }
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('process.run', (_$, e) => {
    const script = scriptOf(e)
    if (script === 'mod-hello.ts') return ran(JSON.stringify({ ...helloOf(SEAT), ...(off.length ? { cc: { version: '2.1.302', verified: false, off } } : {}) }))
    if (script === 'at-room.ts') { seen.posts.push(stdinOf(e)); return ran(JSON.stringify({ continue: false, stopReason: 'Sent', hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } })) }
    return ran('')
  })
  // the tail child: whatever the test feeds it
  on('process.spawn', async function* () {
    for (;;) {
      const next = fed.shift()
      if (next) yield { stream: 'stdout', text: next }
      else await new Promise<void>(r => { poke = r })
    }
  })
  on('ui.log', (_$, e) => { if (e.to !== 'debug') seen.logs.push(e.text); return { value: undefined } })
  on('ui.status', (_$, e) => { seen.statuses.push(e.text); return { value: undefined } })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', (_$, e) => ({ type: 'Text', children: [`engine ${e.component}`] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => { seen.submits.push(e.text); return { text: e.text } })
  on('session.append', (_$, e, next) => { if (!e.agentId && e.message.type === 'user') seen.appends.push(e.message.content.map(b => ('text' in b ? String(b.text) : '')).join('')); return next(e) })
  on('clock.now', () => ({ value: seen.now }))
  on('classic.SessionStart', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('agent.list', () => ({ value: seen.agents.map(a => ({ ...a })) }))
  on('agent.spawn', (_$, e) => {
    const raw: Record<string, unknown> = { ...e }
    seen.spawns.push({ subagentType: e.subagentType ?? raw.subagent_type, name: e.name, description: e.description, prompt: e.prompt })
    const id = `row${seen.spawns.length}`
    seen.agents.push({ id, type: String(e.subagentType ?? raw.subagent_type), status: 'running', description: e.description, ...(e.name ? { name: e.name } : {}) })
    return { model: 'm', agentId: id }
  })
  on('agent.offer', () => ({ isOffered: true }))
  on('session.send', (_$, e) => { seen.sends.push({ to: e.to, text: e.text }); return { isDelivered: true } })
  on('session.messages', () => ({ value: seen.messages }))
  on('clock.sleep', () => ({ value: undefined }))
  on('store.get', (_$, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', (_$, e) => { seen.store.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:sub-human:room' } }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  // the model beneath: a step that reaches it is counted
  on('turn.step', async function* (_$, e) {
    seen.model++
    yield { kind: 'text', index: 0, text: 'model' }
    return { turnId: e.turnId, index: e.index, answer: 'model', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return seen
}

const settle = () => new Promise(r => setTimeout(r, 40))
let turns = 0
const turn = async ($: Engine) => { await $.turn.start({ text: 'hi', turnId: `t${++turns}` }); await settle() }
/** One step of agent id's loop: its chunks, and its result. */
async function step($: Engine, agentId: string, index = 0, turnId = `s${++turns}`) {
  const input: TurnStepInput = { turnId, index, model: 'm', messageCount: 1, agentId }
  const s = $.turn.step(input)
  const chunks: Chunk<'turn.step'>[] = []
  let r = await s.next()
  while (!r.done) { chunks.push(r.value); r = await s.next() }
  return { chunks, result: r.value }
}
const textOf = (r: Awaited<ReturnType<typeof step>>) => r.result.answer
const toolOf = (r: Awaited<ReturnType<typeof step>>) => r.result.toolUses[0]
/** The row is up and its keeper holds: the room's first turn. */
async function rowUp($: Engine, seen: Seen) {
  await start($)
  await turn($)
  const s0 = await step($, 'row1', 0)
  seen.agents.push({ id: 'k1', type: 'sub-human:keeper', status: 'running', description: 'keeper', parentId: 'row1' })
  return s0
}
const typed = ($: Engine, text: string, uuid = 'u-typed') => $.session.append({
  message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: TYPED(text) }] },
  door: 'prompt', origin: { kind: 'composer' }, uuid, agentId: 'row1',
})

test('room-chat: a turn spawns the row named the room code; its first step starts the keeper, its next draws who is here, and no step reaches the model', async ($, on) => {
  const seen = world(on)
  const s0 = await rowUp($, seen)
  expect(seen.spawns).toEqual([{ subagentType: 'sub-human:room', name: CODE, description: 'type here', prompt: `chat: ${CODE}` }])
  expect(toolOf(s0)).toEqual({ name: 'Agent', input: { subagent_type: 'sub-human:keeper', description: 'keeper', prompt: `keep: ${CODE}`, run_in_background: true } })
  expect(textOf(await step($, 'row1', 1))).toBe('·') // who is here not known yet (no here event): drawn as nothing
  const k0 = await step($, 'k1', 0)
  expect(toolOf(k0)).toEqual({ name: 'mcp__plugin_sub-human_room__hold', input: { room: CODE, take: true } })
  expect(seen.model).toBe(0)
  expect(seen.store.get('chatRows')).toEqual({ [SID]: { code: CODE, id: 'row1' } })
  // who is here, once the tail knows it: the row's first line, sent once
  seen.feed({ type: 'here', text: 'bob here' })
  await new Promise(r => setTimeout(r, 10))
  expect(seen.sends.filter(x => x.text === 'bob here')).toEqual([{ to: 'row1', text: 'bob here' }])
  seen.feed({ type: 'here', text: 'bob, carol here' })
  await new Promise(r => setTimeout(r, 10))
  expect(seen.sends.filter(x => x.text === 'bob, carol here')).toEqual([])
})

test('room-chat: a typed line is posted once as the person\'s exact words (node at-room, origin composer), drawn as "you: …", with no model step', async ($, on) => {
  const seen = world(on)
  await rowUp($, seen)
  await step($, 'row1', 1)
  const words = 'exact: "quotes" <b>tag</b> \\ back — ünïcode 🚀\nline two'
  await typed($, words)
  const r = await step($, 'row1', 0)
  expect(seen.posts.length).toBe(1)
  const post = must(seen.posts[0], 'the post')
  expect(post.prompt).toBe(`@room ${words}`)
  expect(post.sub_human_origin).toBe('composer')
  expect(post.session_id).toBe(SID)
  expect(textOf(r)).toBe(`you: ${words}`)
  expect(seen.model).toBe(0)
  // the native ❯ row of it draws as nothing
  expect(await $.ui.render({ surface: 'terminal', component: 'UserMessage', requestId: 'u-typed', props: { text: words, origin: { kind: 'composer' }, isExpanded: false } })).toEqual({ type: 'Box', props: {}, children: [] })
})

test('room-chat: a room line from the tail is sent to the row, drawn there with its author (no bullet), and counted on the status line until the person types', async ($, on) => {
  const seen = world(on)
  await rowUp($, seen)
  await step($, 'row1', 1)
  seen.feed({ type: 'seat', seat: SEAT })
  seen.feed({ type: 'here', text: 'bob here' })
  await settle()
  expect(seen.statuses.at(-1)).toBe(`${CODE} · bob here`)
  seen.feed({ type: 'chat', lines: ['bob: pushed the cursor change'] })
  await settle()
  expect(seen.sends.at(-1)).toEqual({ to: 'row1', text: 'bob: pushed the cursor change' })
  expect(seen.statuses.at(-1)).toBe(`${CODE} · bob here · 1 new`)
  expect(textOf(await step($, 'row1', 0))).toBe('bob here\nbob: pushed the cursor change') // the roster first (it opened before who's here was known)
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'bob: pushed the cursor change' }] }, door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'u-line', agentId: 'row1' })
  const drawn = await $.ui.render({ surface: 'terminal', component: 'AssistantMessage', requestId: 'u-line', props: { text: 'bob: pushed the cursor change', isFirstOfReply: true, onScreen: null } })
  expect(JSON.stringify(drawn)).toContain('"bold":true')
  expect(JSON.stringify(drawn)).toContain('bob:')
  // main's own lines are the engine's
  const main = await $.ui.render({ surface: 'terminal', component: 'AssistantMessage', requestId: 'u-main', props: { text: 'bob: x', isFirstOfReply: true } })
  expect(JSON.stringify(main)).not.toContain('"bold":true')
  await typed($, 'on it')
  expect(seen.statuses.at(-1)).toBe(`${CODE} · bob here`)
  expect(seen.model).toBe(0)
})

test('room-chat (Phase 3): a room line (a notice) is drawn in the row only, never a line in main; room-chat off it is main\'s', async ($, on) => {
  const seen = world(on)
  await rowUp($, seen)
  await step($, 'row1', 1)
  seen.feed({ type: 'seat', seat: SEAT })
  seen.feed({ type: 'chat', lines: ['bob joined', 'bob: hi all'] })
  await settle()
  expect(seen.sends.at(-1)).toEqual({ to: 'row1', text: 'bob joined\nbob: hi all' })
  expect(seen.logs.filter(l => /bob/.test(l))).toEqual([])
})

test('room-chat off: a room line is main\'s notice, as in 0.7.0', async ($, on) => {
  const seen = world(on, { off: ['room-chat'] })
  await start($)
  await turn($)
  seen.feed({ type: 'seat', seat: SEAT })
  seen.feed({ type: 'chat', lines: ['bob: hi all'] })
  await settle()
  expect(seen.logs).toContain('bob: hi all')
})

test('room-chat (Phase 4): "plan …" typed in the row is not posted; once the row\'s turn completes, main\'s Claude is asked for a room plan with the person\'s line', async ($, on) => {
  const seen = world(on)
  await rowUp($, seen)
  await step($, 'row1', 1)
  await typed($, 'Plan cursor paging for GET /tasks')
  const r = await step($, 'row1', 0, 'tp')
  expect(textOf(r)).toBe('you: Plan cursor paging for GET /tasks')
  expect(seen.posts).toEqual([])
  expect(seen.submits).toEqual([])
  await $.turn.complete({ turnId: 'tp', agentId: 'row1', answer: textOf(r), reason: 'answer', durationMs: 50, isAborted: false })
  await settle()
  expect(seen.submits).toEqual(['Plan cursor paging for GET /tasks'])
  expect(seen.model).toBe(0)
})

test('room-chat: a keeper call that was refused (auto mode\'s "no verdict") is made once more in that turn, never a third time', async ($, on) => {
  const seen = world(on)
  await start($)
  await turn($)
  expect(toolOf(await step($, 'row1', 0, 'tr'))?.name).toBe('Agent')
  const refusal = 'The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one. Issue the action again once, as-is'
  seen.messages = [{ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: refusal, isError: true }] }]
  expect(toolOf(await step($, 'row1', 1, 'tr'))?.name).toBe('Agent') // once more
  expect(toolOf(await step($, 'row1', 2, 'tr'))).toBeUndefined() // refused again: the turn ends, no loop
  seen.messages = [{ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b', text: 'Async agent launched successfully', isError: false }] }]
  expect(toolOf(await step($, 'row1', 1, 'tl'))).toBeUndefined() // a call that started one is never repeated
  expect(seen.model).toBe(0)
})

test('room-chat: a row nothing sends to, left idle with no keeper, is replaced at main\'s next turn (the spawn ledger bounds it)', async ($, on) => {
  const seen = world(on)
  seen.store.set('chatRows', { [SID]: { code: CODE, id: 'w1', wake: true } })
  seen.agents.push({ id: 'w1', type: 'sub-human:room', status: 'completed', description: 'type here', name: CODE })
  seen.agents.push({ id: 'k1', type: 'sub-human:keeper', status: 'running', description: 'keeper', parentId: 'w1' })
  await start($)
  await turn($)
  expect(seen.spawns).toEqual([]) // it idles with its keeper: kept
  seen.agents = seen.agents.filter(a => a.id !== 'k1') // its keeper ended and none came back
  await turn($)
  expect(seen.spawns).toEqual([{ subagentType: 'sub-human:room', name: CODE, description: 'type here', prompt: `chat: ${CODE}` }])
  for (const a of seen.agents) a.status = 'completed'
  seen.agents = seen.agents.filter(a => a.type !== 'sub-human:keeper')
  await turn($)
  expect(seen.spawns.length).toBe(1) // the new row has its own keeper to start; and a minute must pass between spawns
})

test('room-chat off (the verdict, or SUB_HUMAN_CC_OFF): the row is 0.7.0\'s read-only hold-row, and its steps are the model\'s', async ($, on) => {
  const seen = world(on, { off: ['room-chat'] })
  await start($)
  await turn($)
  expect(seen.spawns).toEqual([{ subagentType: 'sub-human:room', name: undefined, description: CODE, prompt: `room: ${CODE}` }])
  await step($, 'row1', 0)
  expect(seen.model).toBe(1)
  seen.feed({ type: 'chat', lines: ['bob: hi'] })
  await settle()
  expect(seen.sends).toEqual([])
})

test('room-chat: a keeper that keeps dying is started again at most five times in ten minutes, never in a loop', async ($, on) => {
  const seen = world(on)
  await start($)
  await turn($)
  const calls: string[] = []
  for (let i = 0; i < 8; i++) {
    const r = await step($, 'row1', 0)
    calls.push(toolOf(r)?.name ?? textOf(r))
  }
  expect(calls.filter(c => c === 'Agent').length).toBe(5)
  expect(seen.model).toBe(0)
})

test('room-chat: a resume sends to the row kept for this session id (it comes back from disk) before spawning a new one', async ($, on) => {
  const seen = world(on)
  seen.store.set('chatRows', { [SID]: { code: CODE, id: 'old1' } })
  await start($)
  await turn($)
  expect(seen.spawns).toEqual([])
  expect(seen.sends).toEqual([{ to: 'old1', text: '·' }])
  expect(toolOf(await step($, 'old1', 0))?.name).toBe('Agent') // its keeper again, no model
  expect(seen.model).toBe(0)
})

test('room-chat: main\'s model is refused its own Agent call for a row agent; the row\'s keeper call goes on, but never a second while one lives', async ($, on) => {
  const seen = world(on)
  await rowUp($, seen)
  const call = (agentId?: string) => $.tool.call({ tool: 'Agent', tool_use_id: `t-${agentId ?? 'main'}`, subagent_type: 'sub-human:keeper', description: 'k', prompt: 'keep', ...(agentId ? { agentId } : {}) })
  expect(await call()).toEqual({ deny: 'The room row is already running. Say nothing about it.' })
  // its rows are drawn as nothing (0.8.1: a repeat of the fallback's call drew a red Error in main)
  const ui = await $.ui.mount({ plugin: 'sub-human', surface: 'terminal' as const, component: 'ToolResult', props: { tool_use_id: 't-main', tool: 'Agent', output: 'denied', isErrored: true } })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual([])
  expect(await call('row1')).toEqual({ deny: 'the room row has its keeper' }) // the row's model calling again
  seen.agents = seen.agents.filter(a => a.id !== 'k1')
  expect(await call('row1')).toEqual({ result: 'ok', text: 'ok' })
})

test('room-chat: one keeper call per turn of the row: a later step of that turn (its model numbered it 0 again) draws, never spawns', async ($, on) => {
  const seen = world(on)
  await start($)
  await turn($)
  expect(toolOf(await step($, 'row1', 0, 'tk'))?.name).toBe('Agent')
  expect(toolOf(await step($, 'row1', 0, 'tk'))).toBeUndefined() // the keeper not listed yet: still no second call
  expect(seen.model).toBe(0)
})

test('room-chat (Phase 2): a line naming this person is drawn in the row and wakes main by submit even mid-turn (never the mid-turn append)', async ($, on) => {
  const seen = world(on)
  await rowUp($, seen)
  await step($, 'row1', 1)
  seen.feed({ type: 'seat', seat: SEAT })
  await $.turn.start({ text: 'working', turnId: 'busy' }) // main is mid-turn
  seen.feed({ type: 'wake', text: 'bob: alice, which branch are you on?', chat: true })
  await settle()
  expect(seen.submits).toEqual(['bob: alice, which branch are you on?']) // Claude Code queues it for the turn's end
  expect(seen.appends).toEqual([]) // no mid-turn append: it waits for the turn's end
  expect(seen.sends.at(-1)).toEqual({ to: 'row1', text: 'bob: alice, which branch are you on?' }) // and it is in the row
  // any other wake mid-turn is the append it was
  seen.feed({ type: 'wake', text: 'claude proposed: x (abcdef)' })
  await settle()
  expect(seen.submits.length).toBe(1)
  expect(seen.appends.length).toBe(1)
})

test('room-chat: a row main\'s model started (the fallback) is never sent to: its keeper\'s hold wakes it, and the keeper after a wake is not counted', async ($, on) => {
  const seen = world(on)
  seen.store.set('chatRows', { [SID]: { code: CODE, id: 'w1', wake: true } })
  seen.agents.push({ id: 'w1', type: 'sub-human:room', status: 'completed', description: 'type here', name: CODE })
  seen.agents.push({ id: 'k1', type: 'sub-human:keeper', status: 'running', description: 'keeper', parentId: 'w1' })
  await start($)
  await turn($)
  expect(seen.spawns).toEqual([])
  seen.feed({ type: 'seat', seat: SEAT })
  seen.feed({ type: 'chat', lines: ['bob: hi'] })
  await settle()
  expect(seen.sends).toEqual([]) // a send would hand its whole run to its model (re-entry), or be refused in auto mode
  expect(toolOf(await step($, 'k1', 0))).toEqual({ name: 'mcp__plugin_sub-human_room__hold', input: { room: CODE, take: true, wake: true } })
  seen.messages = [{ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'h', text: `WAKE: a new line in room ${CODE}. End now without calling any tool.`, isError: false }] }]
  expect(textOf(await step($, 'k1', 1))).toBe('left')
  seen.agents = seen.agents.filter(a => a.id !== 'k1')
  // its "finished" notification is the row's turn: a keeper again, then the line
  for (let i = 0; i < 6; i++) {
    expect(toolOf(await step($, 'w1', 0, `wake${i}`))?.name).toBe('Agent')
    seen.agents.push({ id: `kx${i}`, type: 'sub-human:keeper', status: 'running', description: 'keeper', parentId: 'w1' })
    expect(textOf(await step($, `kx${i}`, 1))).toBe('left') // each keeper ends on a WAKE: never counted against the cap
    seen.agents = seen.agents.filter(a => a.id !== `kx${i}`)
  }
  seen.messages = [{ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'Async agent launched successfully', isError: false }] }]
  expect(textOf(await step($, 'w1', 1, 'wake5'))).toBe('bob: hi')
  expect(seen.model).toBe(0)
})
