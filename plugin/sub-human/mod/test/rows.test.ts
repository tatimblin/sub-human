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
  on('process.run', ($: any, e: any) => {
    const script = scriptOf(e)
    if (script === 'mod-hello.ts') return ran(JSON.stringify(helloOf(seat)))
    seen.runs.push({ script, stdin: JSON.parse(e.init.stdin) })
    const a = answer[script]
    return a === undefined ? ran('') : ran(JSON.stringify(a))
  })
  on('classic.PreToolUse', ($: any, e: any) => { seen.beneathPre.push(e.tool); return {} })
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
