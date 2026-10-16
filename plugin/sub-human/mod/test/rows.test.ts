// Wiring: the agent-panel rows' hooks (mod/rows.ts). Run with `npm run test:mods`.
// Only a row agent's call or stop, in a seated (or unsure) session, starts node (hooks/run.ts row-guard, row-map,
// row-hold); every hook beneath still sees each call (next(e) always runs: cc CONTRACT classic-chain-order), and row-guard
// gets the agentId its tool.call carried, which classic.PreToolUse does not.
import { test, expect } from 'claude-code/testing'
import { SEAT, helloOf, ran, scriptOf, session, start } from './support.ts'

const SID = 'sid-r'
const ROW = { subagent_type: 'sub-human:room', prompt: 'room: otter-4821', description: 'otter-4821' }

/** The engine beneath: mod-hello answering for `seat`; row-guard, row-map and row-hold answering `answer`; the
 * PreToolUse, PostToolUse and SubagentStop hooks beneath recorded. */
function world(on: any, { seat = SEAT as any, answer = {} as Record<string, unknown> } = {}) {
  const seen = { runs: [] as { script: string; stdin: any }[], beneathPre: [] as string[], beneathPost: 0, beneathStop: 0 }
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('process.run', (_$: any, e: any) => {
    const script = scriptOf(e)
    if (script === 'mod-hello.ts') return ran(JSON.stringify(helloOf(seat)))
    seen.runs.push({ script, stdin: JSON.parse(e.init.stdin) })
    const a = answer[script]
    return a === undefined ? ran('') : ran(JSON.stringify(a))
  })
  on('classic.PreToolUse', (_$: any, e: any) => { seen.beneathPre.push(e.tool); return {} })
  on('classic.PostToolUse', () => { seen.beneathPost++; return {} })
  on('classic.SubagentStop', () => { seen.beneathStop++; return {} })
  on('classic.UserPromptSubmit', () => ({}))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  return seen
}
const base = { session_id: SID, cwd: '/w', transcript_path: '/t.jsonl', permission_mode: 'default' }
const posted = ($: any, input: any, extra: any = {}) => $.classic.PostToolUse({ ...base, tool_name: 'Agent', tool_input: input, tool_response: { agentId: 'a7' }, tool_use_id: 'tu-1', ...extra } as any)
const stopped = ($: any, type: string) => $.classic.SubagentStop({ ...base, agent_id: 'a7', agent_type: type, stop_hook_active: false, last_assistant_message: '' } as any)

test('a row agent\'s spawn: row-guard with the call as the classic payload (agent_id from its tool.call), its deny above the hooks beneath, which still ran', async ($, on) => {
  const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'sub-human: The room row otter-4821 is already running' } }
  const seen = world(on, { answer: { 'row-guard.ts': deny } })
  await start($)
  await $.classic.UserPromptSubmit({ ...base, prompt: 'hi' } as any) // what the module knows of the session
  seen.runs.length = 0 // prompt.ts, for that prompt
  const r: any = await $.tool.call({ tool: 'Agent', ...ROW, agentId: 'parent-1' } as any)
  expect(seen.runs.map(x => x.script)).toEqual(['row-guard.ts'])
  expect(seen.beneathPre).toEqual(['Agent'])
  // a classic.PreToolUse deny reaches the model as the call's error result
  expect([r.isError, r.text]).toEqual([true, 'sub-human: The room row otter-4821 is already running'])
  const { stdin } = seen.runs[0]
  expect([stdin.hook_event_name, stdin.session_id, stdin.tool_name, stdin.agent_id, stdin.transcript_path, stdin.permission_mode, stdin.cwd])
    .toEqual(['PreToolUse', SID, 'Agent', 'parent-1', '/t.jsonl', 'default', '/w'])
  expect(stdin.tool_input).toEqual(ROW)
})

test('a row agent\'s spawn, stop and map run node; any other agent\'s start none', async ($, on) => {
  const block = { decision: 'block', reason: "otter-4821's row is still wanted" }
  const seen = world(on, { answer: { 'row-hold.ts': block } })
  await start($)
  await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', prompt: 'look', description: 'look' } as any)
  await posted($, { subagent_type: 'Explore' })
  await stopped($, 'Explore')
  expect(seen.runs).toEqual([])
  await $.tool.call({ tool: 'Agent', ...ROW } as any)
  await posted($, ROW)
  const r: any = await stopped($, 'sub-human:room')
  expect(seen.runs.map(x => x.script)).toEqual(['row-guard.ts', 'row-map.ts', 'row-hold.ts'])
  expect(seen.runs[1].stdin.tool_response).toEqual({ agentId: 'a7' })
  expect(r.block).toMatch(/still wanted/)
  expect([seen.beneathPre.length, seen.beneathPost, seen.beneathStop]).toEqual([2, 2, 2])
})

test('a session surely without a seat starts no node for a row agent either', async ($, on) => {
  const seen = world(on, { seat: null })
  await start($)
  await $.tool.call({ tool: 'Agent', ...ROW } as any)
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
  const r: any = await $.tool.call({ tool: 'Agent', ...ROW } as any)
  expect([r.isError, r.text]).toEqual([undefined, 'ok'])
  const s: any = await stopped($, 'sub-human:room')
  expect(s.block).toBeUndefined()
})

test('stage 8e I.2 (live verify, remote/16b; shv9 carol): a row\'s hand-back ("left" after a leave) and its "finished" notification start no turn; another agent\'s pass', async ($, on) => {
  world(on, { seat: null })
  const entered: string[] = []
  on('prompt.submit', (_$: any, e: any) => { entered.push(e.text); return { text: e.text } })
  on('session.receive', (_$: any, e: any) => ({ text: e.text }))
  await start($)
  const ROWID = 'a8fbba36c5b5b5ae1', OTHER = 'a0000000000000001'
  await posted($, ROW, { tool_response: { agentId: ROWID } }) // the room row, spawned
  await posted($, { subagent_type: 'Explore', prompt: 'look', description: 'look' }, { tool_response: { agentId: OTHER } })
  const handback = (id: string, report = 'left') => `Another Claude session sent a message:\n<agent-message from="${id}">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. … The report follows:\n  ${report}\n</agent-message>`
  const finished = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>Agent "falcon-7297" finished</summary>\n</task-notification>`
  const got: any = await $.session.receive({ origin: { kind: 'peer' }, text: handback(ROWID) } as any)
  expect(got.consumed).toBe('sub-human: row ended, nothing to do')
  const r: any = await $.prompt.submit({ text: handback(ROWID), origin: { kind: 'peer' }, wait: false } as any)
  expect(r.drop).toBe('sub-human: row ended, nothing to do')
  const n: any = await $.prompt.submit({ text: finished(ROWID), origin: { kind: 'task-notification' }, wait: false } as any)
  expect(n.drop).toBe('sub-human: row ended, nothing to do')
  const other: any = await $.prompt.submit({ text: handback(OTHER, 'found 3 files'), origin: { kind: 'peer' }, wait: false } as any)
  const otherDone: any = await $.prompt.submit({ text: finished(OTHER), origin: { kind: 'task-notification' }, wait: false } as any)
  expect([other.drop, otherDone.drop]).toEqual([undefined, undefined])
  expect(entered).toEqual([handback(OTHER, 'found 3 files'), finished(OTHER)])
  // stage 8f item 1: a fork's row, never seen spawned here, ends with its last word: taken, its notification too
  const FORKED = 'a1111111111111111'
  const f: any = await $.session.receive({ origin: { kind: 'peer' }, text: handback(FORKED) } as any)
  expect(f.consumed).toBe('sub-human: row ended, nothing to do')
  const fDone: any = await $.session.receive({ origin: { kind: 'task-notification' }, text: finished(FORKED) } as any)
  expect(fDone.consumed).toBe('sub-human: row ended, nothing to do')
  const err: any = await $.prompt.submit({ text: handback('a2222222222222222', 'error'), origin: { kind: 'peer' }, wait: false } as any)
  expect(err.drop).toBe('sub-human: row ended, nothing to do')
  expect(entered.length).toBe(2)
})
