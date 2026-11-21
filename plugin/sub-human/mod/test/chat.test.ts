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
}
function world(on: On, { off = [] }: { off?: string[] } = {}): Seen {
  const seen: Seen = { agents: [], spawns: [], sends: [], posts: [], statuses: [], model: 0, store: new Map(), feed: () => {}, now: 1_000_000 }
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
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_$, e) => { seen.statuses.push(e.text); return { value: undefined } })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', (_$, e) => ({ type: 'Text', children: [`engine ${e.component}`] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
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
  on('session.messages', () => ({ value: [] }))
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
async function step($: Engine, agentId: string, index = 0) {
  const input: TurnStepInput = { turnId: `s${++turns}`, index, model: 'm', messageCount: 1, agentId }
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
  expect(textOf(await step($, 'row1', 0))).toBe('bob: pushed the cursor change')
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

test('room-chat: main\'s model is refused its own Agent call for a row agent; the row\'s own keeper call goes on', async ($, on) => {
  const seen = world(on)
  await rowUp($, seen)
  const call = (agentId?: string) => $.tool.call({ tool: 'Agent', tool_use_id: `t-${agentId ?? 'main'}`, subagent_type: 'sub-human:keeper', description: 'k', prompt: 'keep', ...(agentId ? { agentId } : {}) })
  expect(await call()).toEqual({ deny: 'sub-human starts the room row itself' })
  expect(await call('row1')).toEqual({ result: 'ok', text: 'ok' })
})
