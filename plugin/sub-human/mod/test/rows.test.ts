// Wiring: the agent-panel rows' hooks (mod/rows.ts). Run with `npm run test:mods`.
// Only a row agent's call or stop, in a seated (or unsure) session, starts node (hooks/run.ts row-guard, row-map,
// row-hold); every hook beneath still sees each call (next(e) always runs: cc CONTRACT classic-chain-order), and row-guard
// gets the agentId its tool.call carried, which classic.PreToolUse does not.
import type { On } from 'claude-code'
import { test, expect, type ClassicFields, type Engine } from 'claude-code/testing'
import { SEAT, helloOf, must, ran, scriptOf, session, start, stdinOf, type Seat } from './support.ts'

const SID = 'sid-r'
const ROW = { subagent_type: 'sub-human:room', prompt: 'room: otter-4821', description: 'otter-4821' }

/** The engine beneath: mod-hello answering for `seat`; row-guard, row-map and row-hold answering `answer`; the
 * PreToolUse, PostToolUse and SubagentStop hooks beneath recorded. */
function world(on: On, { seat = SEAT, answer = {} }: { seat?: Seat | null; answer?: Record<string, unknown> } = {}) {
  const seen: { runs: { script: string; stdin: Record<string, unknown> }[]; beneathPre: string[]; beneathPost: number; beneathStop: number } = { runs: [], beneathPre: [], beneathPost: 0, beneathStop: 0 }
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('process.run', (_$, e) => {
    const script = scriptOf(e)
    if (script === 'mod-hello.ts') return ran(JSON.stringify(helloOf(seat)))
    seen.runs.push({ script, stdin: stdinOf(e) })
    const a = answer[script]
    return a === undefined ? ran('') : ran(JSON.stringify(a))
  })
  on('classic.PreToolUse', (_$, e) => { seen.beneathPre.push(e.tool); return {} })
  on('classic.PostToolUse', () => { seen.beneathPost++; return {} })
  on('classic.SubagentStop', () => { seen.beneathStop++; return {} })
  on('classic.UserPromptSubmit', () => ({}))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  return seen
}
const base = { session_id: SID, cwd: '/w', transcript_path: '/t.jsonl', permission_mode: 'default' }
const posted = ($: Engine, input: Record<string, unknown>, extra: Partial<ClassicFields<'PostToolUse'>> = {}) => $.classic.PostToolUse({ ...base, tool_name: 'Agent', tool_input: input, tool_response: { agentId: 'a7' }, tool_use_id: 'tu-1', ...extra })
const stopped = ($: Engine, type: string) => $.classic.SubagentStop({ ...base, agent_id: 'a7', agent_transcript_path: '/t/a7.jsonl', agent_type: type, stop_hook_active: false, last_assistant_message: '' })

test('a row agent\'s spawn: row-guard with the call as the classic payload (agent_id from its tool.call), its deny written out: the call goes no further', async ($, on) => {
  const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'sub-human: The room row otter-4821 is already running' } }
  const seen = world(on, { answer: { 'row-guard.ts': deny } })
  await start($)
  await $.classic.UserPromptSubmit({ ...base, prompt: 'hi' }) // what the module knows of the session
  seen.runs.length = 0 // prompt.ts, for that prompt
  const r = await $.tool.call({
    tool: 'Agent', ...ROW,
    // @ts-expect-error -- deliberate: a call from inside a subagent's loop carries its agentId, which $.tool.call's input does not type
    agentId: 'parent-1',
  })
  expect(seen.runs.map(x => x.script)).toEqual(['row-guard.ts'])
  expect(seen.beneathPre).toEqual([]) // a deny is the module's return: the hooks beneath do not run for that call
  // a classic.PreToolUse deny reaches the model as the call's error result
  expect([r.isError, r.text]).toEqual([true, 'sub-human: The room row otter-4821 is already running'])
  const { stdin } = must(seen.runs[0], 'the row-guard run')
  expect([stdin.hook_event_name, stdin.session_id, stdin.tool_name, stdin.agent_id, stdin.transcript_path, stdin.permission_mode, stdin.cwd])
    .toEqual(['PreToolUse', SID, 'Agent', 'parent-1', '/t.jsonl', 'default', '/w'])
  expect(stdin.tool_input).toEqual(ROW)
})

test('a row agent\'s spawn, stop and map run node; any other agent\'s start none', async ($, on) => {
  const block = { decision: 'block', reason: "otter-4821's row is still wanted" }
  const seen = world(on, { answer: { 'row-hold.ts': block } })
  await start($)
  await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', prompt: 'look', description: 'look' })
  await posted($, { subagent_type: 'Explore' })
  await stopped($, 'Explore')
  expect(seen.runs).toEqual([])
  await $.tool.call({ tool: 'Agent', ...ROW })
  await posted($, ROW)
  const r = await stopped($, 'sub-human:room')
  expect(seen.runs.map(x => x.script)).toEqual(['row-guard.ts', 'row-map.ts', 'row-hold.ts'])
  expect(seen.runs[1]?.stdin.tool_response).toEqual({ agentId: 'a7' })
  expect(r.block).toMatch(/still wanted/)
  expect([seen.beneathPre.length, seen.beneathPost, seen.beneathStop]).toEqual([2, 2, 2])
})

test('a session surely without a seat starts no node for a row agent either', async ($, on) => {
  const seen = world(on, { seat: null })
  await start($)
  await $.tool.call({ tool: 'Agent', ...ROW })
  await posted($, ROW)
  await stopped($, 'sub-human:participant')
  expect(seen.runs).toEqual([])
  expect([seen.beneathPre.length, seen.beneathPost, seen.beneathStop]).toEqual([1, 1, 1])
})

test('a row hook that fails leaves the call and the stop as they were', async ($, on) => {
  on('session.id', () => ({ value: SID }))
  on('process.run', () => ({ deny: 'no processes here' }))
  on('classic.PreToolUse', () => ({}))
  on('classic.SubagentStop', () => ({}))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  const r = await $.tool.call({ tool: 'Agent', ...ROW })
  expect([r.isError, r.text]).toEqual([undefined, 'ok'])
  const s = await stopped($, 'sub-human:room')
  expect(s.block).toBeUndefined()
})

test('stage 8e I.2 (live verify, remote/16b; shv9 carol): a row\'s hand-back ("left" after a leave) and its "finished" notification start no turn; another agent\'s pass', async ($, on) => {
  world(on, { seat: null })
  const entered: string[] = []
  on('prompt.submit', (_$, e) => { entered.push(e.text); return { text: e.text } })
  on('session.receive', (_$, e) => ({ text: e.text }))
  await start($)
  const ROWID = 'a8fbba36c5b5b5ae1', OTHER = 'a0000000000000001'
  await posted($, ROW, { tool_response: { agentId: ROWID } }) // the room row, spawned
  await posted($, { subagent_type: 'Explore', prompt: 'look', description: 'look' }, { tool_response: { agentId: OTHER } })
  const handback = (id: string, report = 'left') => `Another Claude session sent a message:\n<agent-message from="${id}">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. … The report follows:\n  ${report}\n</agent-message>`
  const finished = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>Agent "falcon-7297" finished</summary>\n</task-notification>`
  const got = await $.session.receive({ origin: { kind: 'peer' }, text: handback(ROWID) })
  expect(got.consumed).toBe('sub-human: row ended, nothing to do')
  const r = await $.prompt.submit({ text: handback(ROWID), origin: { kind: 'peer' }, wait: false })
  expect(r.drop).toBe('sub-human: row ended, nothing to do')
  const n = await $.prompt.submit({ text: finished(ROWID), origin: { kind: 'task-notification' }, wait: false })
  expect(n.drop).toBe('sub-human: row ended, nothing to do')
  const other = await $.prompt.submit({ text: handback(OTHER, 'found 3 files'), origin: { kind: 'peer' }, wait: false })
  const otherDone = await $.prompt.submit({ text: finished(OTHER), origin: { kind: 'task-notification' }, wait: false })
  expect([other.drop, otherDone.drop]).toEqual([undefined, undefined])
  expect(entered).toEqual([handback(OTHER, 'found 3 files'), finished(OTHER)])
  // stage 8f item 1: a fork's row, never seen spawned here, ends with its last word: taken, its notification too
  const FORKED = 'a1111111111111111'
  const f = await $.session.receive({ origin: { kind: 'peer' }, text: handback(FORKED) })
  expect(f.consumed).toBe('sub-human: row ended, nothing to do')
  const fDone = await $.session.receive({ origin: { kind: 'task-notification' }, text: finished(FORKED) })
  expect(fDone.consumed).toBe('sub-human: row ended, nothing to do')
  const err = await $.prompt.submit({ text: handback('a2222222222222222', 'error'), origin: { kind: 'peer' }, wait: false })
  expect(err.drop).toBe('sub-human: row ended, nothing to do')
  expect(entered.length).toBe(2)
})
