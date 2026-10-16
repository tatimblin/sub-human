// Wiring: how many node processes the hooks module starts per event ($.process.run and $.process.spawn), for a session
// with no seat and for a seated member. Run with `npm run test:mods`. Together with the hooks.json entries (the
// /sub-human expansion; SessionEnd, whose shell check starts node only for a session with a lease or a seat:
// test/manifest.node-test.ts) this is the node-start table in docs/ARCHITECTURE.md "Performance". The target, held
// here: a session with no seat starts no node on any event but /sub-human.
import { test, expect } from 'claude-code/testing'
import { SEAT, helloOf, ran, scriptOf, session, start } from './support.ts'

const SID = 'sid-n'
const HOME = '/u/.sub-human'

/** The engine beneath: every node start counted (by script), the hello answered for `seat`, every other script
 * answering nothing (consent: no review open), the tail child idle until the test ends, every tool allowed and run. */
function world(engine: any, on: any, seat: any) {
  const seen = { runs: [] as string[], spawns: 0, release: () => {} }
  const held = new Promise<void>(r => { seen.release = r })
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'HOME' ? '/u' : undefined }))
  on('fs.exists', ($: any, e: any) => ({ value: !!seat && e.path === `${HOME}/sessions/by-sid/${SID}.json` }))
  on('fs.stat', ($: any, e: any) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', ($: any, e: any) => {
    const script = scriptOf(e)
    seen.runs.push(script)
    if (script === 'mod-hello.ts') return ran(JSON.stringify(helloOf(seat)))
    if (script === 'consent.ts' || script === 'prompt.ts') return ran(JSON.stringify({ subHuman: { reviewOpen: false } }))
    return ran('')
  })
  on('process.spawn', async function* () { seen.spawns++; await held; return { value: { code: 0, signal: null } } })
  on('prompt.submit', async ($: any, e: any) => {
    await engine.classic.UserPromptSubmit({ prompt: e.text, session_id: SID, permission_mode: 'default' })
    return { text: e.text }
  })
  on('command.run', () => ({ text: undefined }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  for (const ev of ['UserPromptSubmit', 'UserPromptExpansion', 'PostToolUse', 'PermissionRequest', 'SubagentStop', 'Stop',
    'TaskCompleted', 'Notification', 'StopFailure', 'SessionStart']) on(`classic.${ev}`, () => ({}))
  return seen
}

const base = { session_id: SID, cwd: '/w', transcript_path: '/t.jsonl', permission_mode: 'default' }
/** A main-loop tool call as the engine runs it (tool.call, then classic.PostToolUse), and only its PostToolUse. */
const call = async ($: any, tool: string, input: any = {}) => {
  await $.tool.call({ tool, ...input } as any)
  await $.classic.PostToolUse({ ...base, tool_name: tool, tool_input: input, tool_response: {}, tool_use_id: `tu-${tool}` } as any)
}
/** Each event, as the engine raises it. */
const EVENTS: [string, ($: any) => Promise<unknown>][] = [
  // the prompt, then the turn it starts (presence "working" is written there: a stopped prompt starts none)
  ['a plain prompt', async $ => { await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false }); await $.turn.start({ text: 'hello', turnId: 'tp' } as any).catch(() => {}) }],
  ['an @room', $ => $.prompt.submit({ text: '@room hi', origin: { kind: 'composer' }, wait: false })],
  ['Bash, Read, Write', async $ => { await call($, 'Bash', { command: 'ls' }); await call($, 'Read', { file_path: '/w/a' }); await call($, 'Write', { file_path: '/w/a', content: '' }) }],
  ['Agent (Explore)', $ => call($, 'Agent', { subagent_type: 'Explore', prompt: 'look', description: 'look' })],
  ['Agent (a row)', $ => call($, 'Agent', { subagent_type: 'sub-human:room', prompt: 'room: otter-4821', description: 'otter-4821' })],
  ['SubagentStop (Explore)', $ => $.classic.SubagentStop({ ...base, agent_id: 'a1', agent_type: 'Explore', stop_hook_active: false, last_assistant_message: 'done' } as any)],
  ['SubagentStop (a row)', $ => $.classic.SubagentStop({ ...base, agent_id: 'a2', agent_type: 'sub-human:room', stop_hook_active: false, last_assistant_message: 'x' } as any)],
  ['AskUserQuestion', $ => call($, 'AskUserQuestion', { questions: [] })],
  ['EnterPlanMode', $ => call($, 'EnterPlanMode')],
  ['ExitPlanMode', async $ => {
    await $.tool.call({ tool: 'ExitPlanMode' } as any)
    await $.classic.PermissionRequest({ ...base, tool_name: 'ExitPlanMode', tool_input: {} } as any)
    await $.classic.PostToolUse({ ...base, tool_name: 'ExitPlanMode', tool_input: {}, tool_response: {}, tool_use_id: 'tu-x' } as any)
  }],
  ['a room MCP tool', $ => call($, 'mcp__plugin_sub-human_room__post', { text: 'hi' })],
  ['TaskCreate', $ => $.classic.PostToolUse({ ...base, tool_name: 'TaskCreate', tool_input: { subject: 'x' }, tool_response: {}, tool_use_id: 'tu-t' } as any)],
  ['TaskCompleted', $ => $.classic.TaskCompleted({ ...base, task_id: '2', task_subject: 'x' } as any)],
  ['turn end (Stop)', $ => $.classic.Stop({ ...base, stop_hook_active: false } as any)],
  ['Notification idle_prompt', $ => $.classic.Notification({ ...base, notification_type: 'idle_prompt', message: 'idle' } as any)],
  ['StopFailure', $ => $.classic.StopFailure({ ...base, error: 'rate_limit' } as any)],
  ['/compact', $ => $.classic.SessionStart({ ...base, source: 'compact' } as any)],
  ['/clear', async $ => {
    await $.session.end({ reason: 'clear', sessionId: SID, resume: { id: SID } } as any)
    await $.classic.SessionStart({ ...base, source: 'clear' } as any)
  }],
  ['--resume', $ => $.classic.SessionStart({ ...base, source: 'resume' } as any)],
  ['/sub-human', $ => $.command.run({ command: 'sub-human:sub-human', args: 'help', origin: { kind: 'composer' } } as any)],
]

/** {event: node starts}, session start first. */
async function measure($: any, on: any, seat: any) {
  const seen = world($, on, seat)
  const counts: Record<string, number> = {}
  const n = () => seen.runs.length + seen.spawns
  let before = n()
  await start($)
  await new Promise(r => setTimeout(r, 30)) // the tail child starts after session.start returned
  counts['session start'] = n() - before
  for (const [name, fire] of EVENTS) {
    before = n()
    await fire($)
    counts[name] = n() - before
  }
  before = n()
  await $.session.end({ reason: 'other', sessionId: SID, resume: { id: SID } } as any)
  counts['session end'] = n() - before
  seen.release()
  return counts
}

test('node starts per event: a session with no seat starts none on any event but /sub-human', async ($, on) => {
  const counts = await measure($, on, null)
  expect(counts).toEqual({
    'session start': 0, 'a plain prompt': 0, 'an @room': 0, 'Bash, Read, Write': 0, 'Agent (Explore)': 0, 'Agent (a row)': 0,
    'SubagentStop (Explore)': 0, 'SubagentStop (a row)': 0, AskUserQuestion: 0, EnterPlanMode: 0, ExitPlanMode: 0,
    'a room MCP tool': 0, TaskCreate: 0, TaskCompleted: 0, 'turn end (Stop)': 0, 'Notification idle_prompt': 0, StopFailure: 0,
    '/compact': 0, '/clear': 0, '--resume': 0,
    // the lease (mod-hello: the join refuses a session without one), the join, the hello for what the join did
    '/sub-human': 3,
    'session end': 0,
  })
})

test('node starts per event: a seated member (before its tail child reports the seat)', async ($, on) => {
  const counts = await measure($, on, SEAT)
  expect(counts).toEqual({
    'session start': 2, // mod-hello, the tail child
    'a plain prompt': 2, // prompt.ts (no tail child has reported the seat yet), presence "working" at the turn's start
    'an @room': 1, // prompt.ts: at-room signs the post
    'Bash, Read, Write': 0, 'Agent (Explore)': 0,
    'Agent (a row)': 2, // row-guard, row-map
    'SubagentStop (Explore)': 0,
    'SubagentStop (a row)': 1, // row-hold
    AskUserQuestion: 2, EnterPlanMode: 2, // consent Pre and Post
    ExitPlanMode: 2, // consent Pre and Post; PermissionRequest only while a review may be open (consent said none is)
    'a room MCP tool': 0, // consent only while a review may be open
    TaskCreate: 0, TaskCompleted: 0, // a member's own tasks
    'turn end (Stop)': 0, // consent only while a review may be open
    'Notification idle_prompt': 1, StopFailure: 1, // presence, not awaited
    '/compact': 2, // session-restore, mod-hello
    '/clear': 3, // session-restore, mod-hello, the tail child for the new session id
    '--resume': 3, // session-restore, mod-hello, row-rewake (in the background)
    '/sub-human': 2, // the join, mod-hello (the lease was written at session start)
    'session end': 0,
  })
})
