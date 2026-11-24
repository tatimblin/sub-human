// S-Live (R12–R15b): a colleague's change that bears on my work reaches my next prompt, capped, and the status line
// counts it. docs/TESTING.md §4's example, run for real. Each test waits on a finished poll and ends its session.
import { expect, mock, test } from 'claude-code/testing'
import { tokens } from '../../core/deliver.js'
import { EDIT, EDITED, END, START, seedRoom } from '../support/seed-room.js'

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const
/** The room's updates in a prompt's context: the blocks past the mechanics the first prompt also carries. */
const updates = (r: { context?: readonly string[] | undefined }) => (r.context ?? []).filter(c => c.startsWith('[room '))

test('a relevant colleague change reaches my next prompt, capped (R15, R15a)', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'Edit' }, () => EDIT.result) // the recorded answer
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)

  await $.tool.call(EDIT.input) // I edit a file
  expect(room.store.room.docs.get('activity/alice')).toContain(EDITED) // shared through the daemon
  await room.as('bob').activity({ files: [EDITED], commit: `${EDITED}: change listTasks shape` })
  await room.poll(clock)

  const r = await $.prompt.submit(typed('keep going'))
  const context = updates(r).join('\n')
  expect(context).toMatch(/bob.*listTasks/)
  expect(context).toContain(`bob is editing ${EDITED}, which you edited recently`)
  expect(tokens(context)).toBeLessThan(400)
  expect(await room.line($)).toBe(`Room ● bob`) // updates are news's, not the line's
  expect(room.logs).toContainEqual(expect.stringContaining(`bob is editing ${EDITED}`))

  const again = await $.prompt.submit(typed('and then'))
  expect(again.context).toBeUndefined() // delivered once, and the mechanics went with the first prompt
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})

test('a change that bears on nothing of mine is counted, not handed to my Claude', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob', 'carol'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)

  await room.as('carol').presence('idle')
  await room.as('carol').finding('the docs build needs node 24')
  await room.as('bob').activity({ files: ['README.md'] })
  await room.poll(clock)

  const r = await $.prompt.submit(typed('keep going'))
  expect(updates(r)).toEqual([])
  expect(await room.line($)).toBe(`Room ● bob ○ carol`)
  expect(room.spawned).toEqual([])
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})

test('history from before my session is no news', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await room.as('bob').finding(`alice, ${EDITED} now pages by cursor`)
  await $.session.start(START)
  await room.settled(clock)
  await room.poll(clock)

  const r = await $.prompt.submit(typed('hi'))
  expect(updates(r)).toEqual([])
  expect(await room.line($)).toBe(`Room ● bob`)
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})
