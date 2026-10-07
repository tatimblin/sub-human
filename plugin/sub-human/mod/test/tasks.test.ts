// Wiring: the room task mirror and gate (mod/tasks.mjs). Run with `npm run test:mods`.
// hooks/tasks.js runs only for the orch (or an unknown seat); its exit 2 blocks the completion; a member's own
// native tasks start no node.
import { test, expect } from 'claude-code/testing'

const MEMBER = { name: 'bob', code: 'otter-4821', role: 'member', addr: 'bob.otter-4821' }
const ORCH = { name: 'orch', code: 'otter-4821', role: 'orch', addr: 'orch.otter-4821' }
const hello = (seat: any) => ({ home: '/u/.sub-human', realHome: '/u/.sub-human', userHome: '/u', pluginRoot: '/p/sub-human', seat })
const ran = (exitCode: number, stderr = '') => ({ value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const SID = 'sid-t'

function world(on: any, { seat = ORCH as any, exitCode = 0, stderr = '', room = undefined as string | undefined, fail = false } = {}) {
  const seen = { tasks: [] as any[], beneath: [] as string[] }
  on('session.id', () => ({ value: SID }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'SUB_HUMAN_ROOM' ? room : undefined }))
  on('process.run', ($: any, e: any) => {
    const script = String(e.argv[1]).replace(/^.*\/hooks\//, '')
    if (script === 'mod-hello.js') return { value: { exitCode: 0, stdout: JSON.stringify(hello(seat)), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (fail) return { deny: 'no processes here' }
    seen.tasks.push(JSON.parse(e.init.stdin))
    return ran(exitCode, stderr)
  })
  on('classic.PostToolUse', ($: any, e: any) => { seen.beneath.push(`post ${e.tool_name}`); return {} })
  on('classic.TaskCompleted', () => { seen.beneath.push('completed'); return {} })
  return seen
}
const start = ($: any) => $.session.start({ cwd: '/w', surface: null, isInteractive: false })
const created = ($: any) => $.classic.PostToolUse({ session_id: SID, tool_name: 'TaskCreate', tool_input: { subject: 'x' }, tool_response: { task: { id: '2', subject: 'x' } }, tool_use_id: 't1' } as any)
const completed = ($: any) => $.classic.TaskCompleted({ session_id: SID, task_id: '2', task_subject: 'x' } as any)

test('the orch: the mirror and the gate run hooks/tasks.js; exit 2 blocks the completion with its reason', async ($, on) => {
  const seen = world(on, { exitCode: 2, stderr: 'only bob may complete #2; ask them\nNothing in that TaskUpdate was saved.' })
  await start($)
  await created($)
  const r: any = await completed($)
  expect(seen.tasks.map((t: any) => t.hook_event_name)).toEqual(['PostToolUse', 'TaskCompleted'])
  expect(r.block).toMatch(/only bob may complete #2/)
  expect(seen.beneath).toEqual(['post TaskCreate'])
})

test('the orch: a completion the gate passes goes on', async ($, on) => {
  const seen = world(on)
  await start($)
  const r: any = await completed($)
  expect(r.block).toBe(undefined)
  expect(seen.beneath).toEqual(['completed'])
})

test('a member\'s own native tasks start no node', async ($, on) => {
  const seen = world(on, { seat: MEMBER })
  await start($)
  await created($)
  await completed($)
  expect(seen.tasks).toEqual([])
  expect(seen.beneath).toEqual(['post TaskCreate', 'completed'])
})

test('no seat: no node, unless SUB_HUMAN_ROOM says an orch is starting', async ($, on) => {
  const seen = world(on, { seat: null })
  await start($)
  await created($)
  expect(seen.tasks).toEqual([])
})

test('no seat but SUB_HUMAN_ROOM set (an orch before its join): tasks.js runs', async ($, on) => {
  const seen = world(on, { seat: null, room: 'otter-4821' })
  await start($)
  await completed($)
  expect(seen.tasks.length).toBe(1)
})

test('the gate fails closed in the orch\'s session only', async ($, on) => {
  world(on, { fail: true })
  await start($)
  const r: any = await completed($)
  expect(r.block).toMatch(/failed closed/)
})

test('a failed gate in a member\'s session lets the completion go on', async ($, on) => {
  const seen = world(on, { seat: null, room: 'otter-4821', fail: true })
  await start($)
  const r: any = await completed($)
  expect(r.block).toBe(undefined)
  expect(seen.beneath).toEqual(['completed'])
})
