// S-Leave (R3): I leave and my session keeps going, out of the room; a colleague who leaves is gone from my status line.
// `/sub-human leave` is the command hook's (the daemon removes my pointer); the module sees the pointer go.
import { expect, mock, test } from 'claude-code/testing'
import { EDIT, EDITED, END, START, expandReply, seedRoom, slash } from '../support/seed-room.js'

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const

test('after I leave, the room reaches neither my Claude nor my status line, and my work is no longer shared', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'Edit' }, () => EDIT.result)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await $.tool.call(EDIT.input)
  await $.prompt.submit(typed('hi'))
  const writes = room.requests.filter(q => q.op === 'put_doc').length

  room.pointer(null) // the daemon's leave
  room.answer = expandReply(`You left ${room.code}.`)
  await $.command.run(slash('leave'))
  await room.poll(clock)
  expect(room.status.at(-1)).toBeUndefined() // the status line is gone
  await room.as('bob').finding(`alice, ${EDITED} pages by cursor now`)
  await room.as('bob').activity({ files: [EDITED] })
  await room.poll(clock)
  await $.tool.call(EDIT.input)
  const r = await $.prompt.submit(typed('keep going')) // the session goes on
  expect(r.text).toBe('keep going')
  expect(r.context).toBeUndefined()
  expect(room.status.at(-1)).toBeUndefined()
  expect(room.requests.filter(q => q.op === 'put_doc')).toHaveLength(writes)
  expect(room.logs).toEqual([`You left ${room.code}.`]) // the leave's own answer, and nothing of the room after it
  const pings = room.requests.length
  for (let i = 0; i < 20; i++) await room.poll(clock)
  // no room: the pings name none, so nothing keeps alice live in it (the daemon still hears the module runs, C1)
  expect(room.requests.slice(pings).filter(q => q.op === 'ping' && 'code' in q)).toEqual([])
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})

test('a colleague who leaves goes from my status line, in one change, with no line drawn', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob', 'carol'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  expect(room.status.at(-1)).toBe(`${room.code} ● bob ● carol`)
  await room.as('carol').left()
  await room.poll(clock)
  expect(room.status.at(-1)).toBe(`${room.code} ● bob`)
  expect(room.logs).toEqual([])
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})

test('a session that ends is away, not gone: no left is written for it', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
  expect(room.requests.filter(r => r.op === 'append')).toEqual([])
  expect(room.store.room.lines.join('\n')).not.toContain('"kind":"left"')
})
