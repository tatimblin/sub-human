// S-Ask (R6, R10, R11): my Claude needs a fact bob's Claude has and asks it directly; his answer wakes mine at the end
// of my current turn, and I see one line. Likewise, when my session changes something bob's side depends on, my Claude
// tells his directly, and his tells mine back. Nobody's turn is interrupted, and nothing of it reaches the room's log.
import type { SessionSendOrigin } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { END, START, seedRoom, turnEnd, turnStart, turns } from '../support/seed-room.js'

const origin: SessionSendOrigin = { kind: 'model' }

test('my Claude asks bob\'s for a fact; his answer wakes mine after my turn, with one line for me', async ($, on) => {
  const clock = mock.clock(on)
  const native: string[] = []
  on('session.send', (_, e) => { native.push(e.to); return { isDelivered: false, reason: 'native' } })
  turns(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  const logged = room.store.room.lines.length

  await $.turn.start(turnStart('t1'))
  const asked = await $.session.send({ to: `bob.${room.code}`, text: 'which port does src/server.js listen on?', origin })
  expect(asked).toEqual({ isDelivered: true })
  room.as('bob').message('3000, from PORT in src/server.js') // his Claude answers while mine is still working
  for (let i = 0; i < 3; i++) await room.poll(clock)
  expect(room.submitted).toEqual([]) // my turn runs on, uninterrupted
  await $.turn.complete(turnEnd('t1'))
  for (let i = 0; i < 2; i++) await room.poll(clock)
  expect(room.submitted.map(s => s.text.split('\n')[0])).toEqual([`[room ${room.code} · bob's Claude, to you] 3000, from PORT in src/server.js`])
  expect(room.logs).toEqual(["bob's Claude messaged your Claude."])

  // the woken turn changes my store's shape; my Claude tells bob's, whose Claude says his side is updated
  await $.turn.start(turnStart('w1'))
  expect(await $.session.send({ to: `bob.${room.code}`, text: 'listTasks now returns {items, next}; update your side', origin })).toEqual({ isDelivered: true })
  await $.turn.complete(turnEnd('w1'))
  await clock.advance(61_000)
  room.as('bob').message('updated the handler for {items, next}; its tests pass')
  for (let i = 0; i < 2; i++) await room.poll(clock)

  expect(room.submitted).toHaveLength(2)
  expect(room.requests.filter(r => r.op === 'message').map(r => r.op === 'message' && `${r.from}→${r.to}`)).toEqual(['alice→bob', 'alice→bob'])
  expect(native).toEqual([])
  expect(room.store.room.lines.length).toBe(logged) // private between the two Claudes (Q4)
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})
