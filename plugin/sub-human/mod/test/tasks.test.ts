// Wiring: the room task mirror and gate (mod/tasks.ts). Run with `npm run test:mods`.
// hooks/handlers/tasks.ts runs only for the room's Claude (or an unknown seat); its exit 2 blocks the completion; a member's own
// native tasks start no node. A failed gate blocks wherever tasksNeeded holds.
import { test, expect } from 'claude-code/testing'
import { seatOf, helloOf, ran, scriptOf, session, start as startOf } from './support.ts'

const MEMBER = seatOf('bob')
const ROOM_CLAUDE = seatOf('claude', 'claude')
const SID = 'sid-t'

function world(on: any, { seat = ROOM_CLAUDE as any, exitCode = 0, stderr = '', room = undefined as string | undefined, fail = false, envFail = false } = {}) {
  const seen = { tasks: [] as any[], beneath: [] as string[] }
  session(on, SID)
  on('env.get', ($: any, e: any) => {
    if (envFail) throw new Error('env unavailable')
    return { value: e.name === 'SUB_HUMAN_ROOM' ? room : undefined }
  })
  on('process.run', ($: any, e: any) => {
    if (scriptOf(e) === 'mod-hello.ts') return ran(JSON.stringify(helloOf(seat)))
    if (fail) return { deny: 'no processes here' }
    seen.tasks.push(JSON.parse(e.init.stdin))
    return ran('', exitCode, stderr)
  })
  on('classic.PostToolUse', ($: any, e: any) => { seen.beneath.push(`post ${e.tool_name}`); return {} })
  on('classic.TaskCompleted', () => { seen.beneath.push('completed'); return {} })
  return seen
}
const start = ($: any) => startOf($, false)
const created = ($: any) => $.classic.PostToolUse({ session_id: SID, tool_name: 'TaskCreate', tool_input: { subject: 'x' }, tool_response: { task: { id: '2', subject: 'x' } }, tool_use_id: 't1' } as any)
const completed = ($: any) => $.classic.TaskCompleted({ session_id: SID, task_id: '2', task_subject: 'x' } as any)

test('the room\'s Claude: the mirror and the gate run hooks/handlers/tasks.ts; exit 2 blocks the completion with its reason', async ($, on) => {
  const seen = world(on, { exitCode: 2, stderr: 'only bob may complete #2; ask them\nNothing in that TaskUpdate was saved.' })
  await start($)
  await created($)
  const r: any = await completed($)
  expect(seen.tasks.map((t: any) => t.hook_event_name)).toEqual(['PostToolUse', 'TaskCompleted'])
  expect(r.block).toMatch(/only bob may complete #2/)
  expect(seen.beneath).toEqual(['post TaskCreate'])
})

test('the room\'s Claude: a completion the gate passes goes on', async ($, on) => {
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

test('no seat: no node, unless SUB_HUMAN_ROOM says a room Claude is starting', async ($, on) => {
  const seen = world(on, { seat: null })
  await start($)
  await created($)
  expect(seen.tasks).toEqual([])
})

test('no seat but SUB_HUMAN_ROOM set (a room Claude before its join): tasks.ts runs', async ($, on) => {
  const seen = world(on, { seat: null, room: 'otter-4821' })
  await start($)
  await completed($)
  expect(seen.tasks.length).toBe(1)
})

test('the gate fails closed in the room\'s Claude\'s session', async ($, on) => {
  world(on, { fail: true })
  await start($)
  const r: any = await completed($)
  expect(r.block).toMatch(/failed closed/)
})

test('no seat but SUB_HUMAN_ROOM set: a failed gate fails closed (tasks.ts would have run)', async ($, on) => {
  const seen = world(on, { seat: null, room: 'otter-4821', fail: true })
  await start($)
  const r: any = await completed($)
  expect(r.block).toMatch(/task gate failed closed/)
  expect(seen.beneath).toEqual([])
})

test('a failure in a session surely not the room\'s Claude lets the completion go on', async ($, on) => {
  const seen = world(on, { seat: MEMBER, envFail: true })
  await start($)
  const r: any = await completed($)
  expect(r.block).toBe(undefined)
  expect(seen.beneath).toEqual(['completed'])
})
