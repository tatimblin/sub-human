// Wiring: the room row (mod/deliver.ts roomRow, mod/rows.ts). Run with `npm run test:mods`.
// The row is the module's own: spawned with $.agent.spawn at a main-loop turn's start for a member's seat, unless
// $.agent.list still runs one; never offered to the model; its stop runs node row-hold; its hand-back and "finished"
// notification start no turn. Every hook beneath still sees each call (next(e) always runs: cc CONTRACT
// classic-chain-order).
import type { AgentInfo, On } from 'claude-code'
import { test, expect, type Engine } from 'claude-code/testing'
import { CODE, SEAT, helloOf, must, ran, scriptOf, seatOf, session, start, stdinOf, type Seat } from './support.ts'
import { QUIET_ROW } from '../core/constants.ts'

const SID = 'sid-r'
const MINUTE = 60_000

type Agent = AgentInfo
/** The engine beneath: mod-hello answering for `seat` (with `off`: the verdict's features off); row-hold answering
 * `answer`; $.agent.list answering `agents`, $.agent.spawn recording each spawn (and listing it as running), the room
 * server connected unless `down`; the clock at `clock.now`. */
type Seen = { runs: { script: string; stdin: Record<string, unknown> }[]; beneathStop: number; spawns: Record<string, unknown>[]; agents: Agent[]; clock: { now: number }; offered: string[]; debug: string[] }
function world(on: On, { seat = SEAT, answer = {}, off = [], down = false }: { seat?: Seat | null; answer?: Record<string, unknown>; off?: string[]; down?: boolean } = {}) {
  const seen: Seen = { runs: [], beneathStop: 0, spawns: [], agents: [], clock: { now: 1_000_000 }, offered: [], debug: [] }
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('process.run', (_$, e) => {
    const script = scriptOf(e)
    if (script === 'mod-hello.ts') return ran(JSON.stringify({ ...helloOf(seat), ...(off.length ? { cc: { version: '2.1.302', verified: false, off } } : {}) }))
    seen.runs.push({ script, stdin: stdinOf(e) })
    const a = answer[script]
    return a === undefined ? ran('') : ran(JSON.stringify(a))
  })
  on('classic.SubagentStop', () => { seen.beneathStop++; return {} })
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('ui.log', (_$, e) => { if (e.to === 'debug') seen.debug.push(e.text); return { value: undefined } })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('clock.now', () => ({ value: seen.clock.now }))
  on('agent.list', () => ({ value: seen.agents.map(a => ({ ...a })) }))
  on('agent.spawn', (_$, e) => {
    // the test engine hands the spawn on as the Agent tool's input (subagent_type), the engine as AgentSpawnInput
    const raw: Record<string, unknown> = { ...e }
    const type = String(e.subagentType ?? raw.subagent_type)
    seen.spawns.push({ subagentType: type, description: e.description, prompt: e.prompt })
    const id = `row${seen.spawns.length}`
    seen.agents.push({ id, type, status: 'running', description: e.description })
    return { model: 'm', agentId: id } // the test engine keeps no hook's agentId (core sets it): $.agent.list names it
  })
  on('agent.offer', (_$, e) => { seen.offered.push(e.agent); return { isOffered: true } })
  on('mcp.connect', () => ({ value: down ? { isConnected: false, reason: 'failed', message: 'Skipping connection (recent failure cached)' } : { isConnected: true, server: 'plugin:sub-human:room' } }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  return seen
}
let turns = 0
/** A main-loop turn starts; the row's spawn is not awaited there, so the test waits it out. */
const turn = async ($: Engine) => { await $.turn.start({ text: 'hi', turnId: `t${++turns}` }); await new Promise(r => setTimeout(r, 30)) }
const stopped = ($: Engine, type: string, last = '') => $.classic.SubagentStop({ session_id: SID, cwd: '/w', transcript_path: '/t.jsonl', permission_mode: 'default', agent_id: 'a7', agent_transcript_path: '/t/a7.jsonl', agent_type: type, stop_hook_active: false, last_assistant_message: last })

test('one room row, the module\'s own: a member\'s first turn spawns it ($.agent.spawn, the code its label, prompt "room: CODE"), and never a second while it runs', async ($, on) => {
  const seen = world(on)
  await start($)
  expect(seen.spawns).toEqual([]) // no row before a turn: a resume or a /clear gets it back at the next one
  await turn($)
  expect(seen.spawns).toEqual([{ subagentType: 'sub-human:room', description: CODE, prompt: `room: ${CODE}` }])
  await turn($)
  await turn($)
  expect(seen.spawns.length).toBe(1) // $.agent.list runs it: nothing more
  expect(seen.runs).toEqual([]) // no node for a spawn: no row-guard, no row map
  expect(seen.debug).toContain(`rows: room row ${CODE} started`)
})

test('a resume, a fork or a /clear brings the room row back with no prompt (once the restore put the seat back); one still running is left alone', async ($, on) => {
  const seen = world(on)
  await start($)
  await $.classic.SessionStart({ session_id: SID, source: 'resume', cwd: '/w', permission_mode: 'default' })
  await new Promise(r => setTimeout(r, 30))
  expect(seen.runs.map(x => x.script)).toEqual(['session-restore.ts'])
  expect(seen.spawns.length).toBe(1) // no turn needed
  await $.classic.SessionStart({ session_id: SID, source: 'clear', cwd: '/w', permission_mode: 'default' })
  await new Promise(r => setTimeout(r, 30))
  expect(seen.spawns.length).toBe(1) // a /clear left the row running: $.agent.list has it
})

test('the row that died (Esc, a crash, a /clear that ended it) comes back at a later turn, at most once a minute and five times: never a loop', async ($, on) => {
  const seen = world(on)
  await start($)
  await turn($)
  const kill = () => { for (const a of seen.agents) a.status = 'killed' }
  kill()
  await turn($)
  expect(seen.spawns.length).toBe(1) // within the minute
  for (let i = 0; i < 6; i++) { seen.clock.now += MINUTE; kill(); await turn($) }
  expect(seen.spawns.length).toBe(5) // ROW_SPAWNS_MAX: a row that dies at once never loops
})

test('no room row: the room session keeps no row', async ($, on) => {
  const seen = world(on, { seat: seatOf('claude', 'claude') })
  await start($)
  await turn($)
  expect(seen.spawns).toEqual([])
})

test('no room row: a session surely without a seat has none', async ($, on) => {
  const seen = world(on, { seat: null })
  await start($)
  await turn($)
  expect(seen.spawns).toEqual([])
})

test('no room row: with the verdict\'s room-row off there is none (FALLBACK: no room row)', async ($, on) => {
  const seen = world(on, { off: ['room-row'] })
  await start($)
  await turn($)
  expect(seen.spawns).toEqual([])
})

test('no room row: while the room server is not connected (the row\'s one tool is its hold) none is spawned', async ($, on) => {
  const seen = world(on, { down: true })
  await start($)
  await turn($)
  expect(seen.spawns).toEqual([])
})

test('the room row is never offered to the model (no Agent call of its own ever spawns one); any other agent is', async ($, on) => {
  const seen = world(on)
  await start($)
  const room = await $.agent.offer({ agent: 'sub-human:room', description: 'x', source: 'plugin', provider: { plugin: 'sub-human', tier: 'append' } })
  const other = await $.agent.offer({ agent: 'Explore', description: 'x', source: 'built-in', provider: { plugin: 'engine', tier: 'core' } })
  expect([room.isOffered, other.isOffered]).toEqual([false, true])
  expect(seen.offered).toEqual(['Explore'])
})

test('the room row\'s stop runs node row-hold; any other agent\'s stop starts none', async ($, on) => {
  const block = { decision: 'block', reason: `Room ${CODE} is still wanted` }
  const seen = world(on, { answer: { 'row-hold.ts': block } })
  await start($)
  await stopped($, 'Explore')
  await stopped($, 'sub-human:participant') // an older version's row: let go
  expect(seen.runs).toEqual([])
  const r = await stopped($, 'sub-human:room')
  expect(seen.runs.map(x => x.script)).toEqual(['row-hold.ts'])
  expect(must(seen.runs[0]).stdin.agent_type).toBe('sub-human:room')
  expect(r.block).toMatch(/still wanted/)
  expect(seen.beneathStop).toBe(3)
})

test('a session surely without a seat starts no node for the row\'s stop either', async ($, on) => {
  const seen = world(on, { seat: null })
  await start($)
  await stopped($, 'sub-human:room')
  expect(seen.runs).toEqual([])
  expect(seen.beneathStop).toBe(1)
})

test('a row hook that fails leaves the stop as it was', async ($, on) => {
  on('session.id', () => ({ value: SID }))
  on('process.run', () => ({ deny: 'no processes here' }))
  on('classic.SubagentStop', () => ({}))
  const s = await stopped($, 'sub-human:room')
  expect(s.block).toBeUndefined()
})

test('stage 8e I.2 (live verify, remote/16b; shv9 carol): the row\'s hand-back ("left" after a leave) and its "finished" notification start no turn; another agent\'s pass', async ($, on) => {
  const seen = world(on)
  const entered: string[] = []
  on('prompt.submit', (_$, e) => { entered.push(e.text); return { text: e.text } })
  on('session.receive', (_$, e) => ({ text: e.text }))
  await start($)
  await turn($) // the room row, spawned by the module: its id noted
  const ROWID = must(seen.agents[0], 'the room row').id, OTHER = 'a0000000000000001'
  const handback = (id: string, report = 'left') => `Another Claude session sent a message:\n<agent-message from="${id}">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. … The report follows:\n  ${report}\n</agent-message>`
  const finished = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>Agent "falcon-7297" finished</summary>\n</task-notification>`
  const got = await $.session.receive({ origin: { kind: 'peer' }, text: handback(ROWID, 'bye') })
  expect(seen.debug).toContain(`rows: room row ${CODE} started`)
  expect(got.consumed).toBe('sub-human: row ended, nothing to do') // known by its id, whatever its last word
  const r = await $.prompt.submit({ text: handback(ROWID), origin: { kind: 'peer' }, wait: false })
  expect(r.drop).toBe('sub-human: row ended, nothing to do')
  const n = await $.prompt.submit({ text: finished(ROWID), origin: { kind: 'task-notification' }, wait: false })
  expect(n.drop).toBe('sub-human: row ended, nothing to do')
  const other = await $.prompt.submit({ text: handback(OTHER, 'found 3 files'), origin: { kind: 'peer' }, wait: false })
  const otherDone = await $.prompt.submit({ text: finished(OTHER), origin: { kind: 'task-notification' }, wait: false })
  expect([other.drop, otherDone.drop]).toEqual([undefined, undefined])
  expect(entered).toEqual([handback(OTHER, 'found 3 files'), finished(OTHER)])
  // stage 8f item 1: a fork's or a reload's row, never seen spawned here, ends with its last word: taken, its notification too
  const FORKED = 'a1111111111111111'
  const f = await $.session.receive({ origin: { kind: 'peer' }, text: handback(FORKED) })
  expect(f.consumed).toBe('sub-human: row ended, nothing to do')
  const fDone = await $.session.receive({ origin: { kind: 'task-notification' }, text: finished(FORKED) })
  expect(fDone.consumed).toBe('sub-human: row ended, nothing to do')
  const err = await $.prompt.submit({ text: handback('a2222222222222222', 'error'), origin: { kind: 'peer' }, wait: false })
  expect(err.drop).toBe('sub-human: row ended, nothing to do')
  expect(entered.length).toBe(2)
})

test('live 2.1.296: a row-ended drop\'s warning row says nothing (QUIET_ROW, a rewrite the engine keeps), without Claude Code\'s frame; no other row changes', async ($, on) => {
  world(on, { seat: null })
  const kept: string[] = []
  on('session.append', (_$, e, next) => {
    const block = must(e.message.content[0], 'a content block')
    if (block.type !== 'text') throw new Error(`a ${block.type} block`)
    kept.push(String(block.text))
    return next(e)
  })
  await start($)
  let n = 0
  const append = async (text: string, type: 'system' | 'user' = 'system') => {
    await $.session.append({
      message: { type, ...(type === 'system' ? { name: 'informational' } : { role: 'user', isMeta: true }), content: [{ type: 'text', text }] },
      door: type === 'system' ? 'notice' : 'note', origin: { kind: 'engine' }, uuid: `r${n++}`,
    }).catch(() => null)
    return kept.at(-1)
  }
  const DROPPED = 'Prompt dropped by a hook: sub-human: row ended, nothing to do'
  expect(await append(DROPPED)).toBe(QUIET_ROW)
  expect(await append(DROPPED)).toBe(QUIET_ROW) // the hand-back's and the notification's: each its own row
  expect(await append('Prompt dropped by a hook: another plugin')).toBe('Prompt dropped by a hook: another plugin')
  expect(await append(DROPPED, 'user')).toBe(DROPPED) // only the warning row
})
