// Messages, sender side (R6): a SendMessage to NAME.CODE of my room is caught by session.send, answered delivered
// without next, and carried by the daemon stamped with my name, never the log. Risk 1 (docs/internals/v2-risks.md)
// folded in: the kit has no engine core, so the test's own session.send is the bottom of the chain, standing in for
// native delivery; reaching it means the send went native. The real-session check is scripts/risk-send.ts.
import type { On, SessionSendOrigin } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { END, START, seedRoom, slash } from '../test/support/seed-room.js'

const origin: SessionSendOrigin = { kind: 'model' } // the engine stamps it in a session; the kit passes the input whole

async function setup(on: On) {
  const clock = mock.clock(on)
  const reached: string[] = []
  on('session.send', (_, e) => { reached.push(e.to); return { isDelivered: false, reason: 'native' } })
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  return { clock, reached, room, messages: () => room.requests.filter(r => r.op === 'message') }
}

test('a message to a colleague\'s Claude is answered delivered, carried stamped with me, and never logged (R6)', async ($, on) => {
  const { clock, reached, room, messages } = await setup(on)
  await $.session.start(START)
  await room.settled(clock)
  const lines = room.store.room.lines.length
  const r = await $.session.send({ to: `bob.${room.code}`, text: 'listTasks now returns {items, next}; update your side', origin })
  expect(r).toEqual({ isDelivered: true })
  expect(reached).toEqual([]) // no next: nothing native
  expect(messages()).toEqual([{ op: 'message', code: room.code, to: 'bob', from: 'alice', text: 'listTasks now returns {items, next}; update your side' }])
  expect(room.store.room.lines.length).toBe(lines)
  expect(room.store.room.lines.join('\n')).not.toContain('listTasks')
  expect(room.logs).toEqual([]) // quiet: a send that worked draws nothing
  await $.session.end(END)
})

test('a second session\'s title reaches its member; my own name and a secret are refused, never sent', async ($, on) => {
  const { clock, reached, room, messages } = await setup(on)
  await $.session.start(START)
  await room.settled(clock)
  expect(await $.session.send({ to: `bob-2.${room.code}`, text: 'hi', origin })).toEqual({ isDelivered: true })
  expect(messages().at(-1)).toMatchObject({ to: 'bob' })
  const self = await $.session.send({ to: `alice.${room.code}`, text: 'hi', origin })
  expect(self).toMatchObject({ isDelivered: false, reason: expect.stringContaining('own name') })
  const secret = await $.session.send({ to: `bob.${room.code}`, text: 'use AKIAIOSFOD\u200bNN7EXAMPLE', origin })
  expect(secret).toMatchObject({ isDelivered: false, reason: expect.stringContaining('holds a secret') })
  expect(messages()).toHaveLength(1)
  expect(reached).toEqual([])
  await $.session.end(END)
})

test('any other address goes on with next: a teammate, another room, or my room after a leave', async ($, on) => {
  const { clock, reached, room, messages } = await setup(on)
  await $.session.start(START)
  await room.settled(clock)
  expect(await $.session.send({ to: 'team-lead', text: 'hello', origin })).toEqual({ isDelivered: false, reason: 'native' })
  expect(await $.session.send({ to: 'bob.heron-1111', text: 'hello', origin })).toEqual({ isDelivered: false, reason: 'native' })
  room.pointer(null) // a leave: the next poll reads the pointer gone
  await $.command.run(slash('leave'))
  await room.poll(clock)
  expect(await $.session.send({ to: `bob.${room.code}`, text: 'hello', origin })).toEqual({ isDelivered: false, reason: 'native' })
  expect(reached).toEqual(['team-lead', 'bob.heron-1111', `bob.${room.code}`])
  expect(messages()).toEqual([])
  await $.session.end(END)
})

test('a send the daemon refuses, or whose socket is refused, is answered undelivered and never goes native', async ($, on) => {
  const { clock, reached, room } = await setup(on)
  await $.session.start(START)
  await room.settled(clock)
  room.broken.daemon = true
  const refused = await $.session.send({ to: `bob.${room.code}`, text: 'hi', origin })
  expect(refused).toMatchObject({ isDelivered: false, reason: expect.stringContaining('broken for this test') })
  room.broken.socket = true
  const thrown = await $.session.send({ to: `bob.${room.code}`, text: 'hi', origin })
  expect(thrown).toMatchObject({ isDelivered: false, reason: expect.stringContaining('socket refused by policy') })
  expect(reached).toEqual([])
  await $.session.end(END)
})

// Why the hook must never throw: a hook that throws is skipped, and the send goes on beneath it, to native delivery.
test('a throwing session.send hook falls through to what is beneath', {
  plugins: [{ name: 'risk-thrower', register(on: On) { on('session.send', () => { throw new Error('boom') }) } }],
}, async ($, on) => {
  const reached: string[] = []
  on('session.send', (_, e) => { reached.push(e.to); return { isDelivered: false, reason: 'native' } })
  expect(await $.session.send({ to: 'bob.TESTROOM', text: 'hello', origin })).toEqual({ isDelivered: false, reason: 'native' })
  expect(reached).toEqual(['bob.TESTROOM'])
})

// A kit limit, kept so a kit that starts routing it is noticed; the real engine's SendMessage is risk-send.ts's.
test('the kit does not route a SendMessage tool call to session.send', async ($, on) => {
  const { reached } = await setup(on)
  await expect($.tool.call({ tool: 'SendMessage', to: 'bob.TESTROOM', message: 'hello' })).rejects.toThrow(/no implementation for tool\.call/)
  expect(reached).toEqual([])
})

// The engine types `to` a string; a hook that threw on anything else would let the send go native, so it never throws.
test('a send whose to is no string goes on with next, and the hook never throws', async ($, on) => {
  const { clock, reached, room, messages } = await setup(on)
  await $.session.start(START)
  await room.settled(clock)
  // @ts-expect-error -- not a string, as a malformed send could carry
  expect(await $.session.send({ to: undefined, text: 'hi', origin })).toEqual({ isDelivered: false, reason: 'native' })
  // @ts-expect-error -- not a string
  expect(await $.session.send({ to: null, text: 'hi', origin })).toEqual({ isDelivered: false, reason: 'native' })
  // @ts-expect-error -- not a string
  expect(await $.session.send({ to: 42, text: 'hi', origin })).toEqual({ isDelivered: false, reason: 'native' })
  // @ts-expect-error -- not a string
  expect(await $.session.send({ to: { name: `bob.${room.code}` }, text: 'hi', origin })).toEqual({ isDelivered: false, reason: 'native' })
  expect(reached).toHaveLength(4)
  expect(messages()).toEqual([])
  await $.session.end(END)
})
