// context.ts: the mechanics once per conversation, the session's NAME.CODE title, the overlap heads-up inside a long
// tool loop, and following that survives a /clear.
import type { SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { MECHANICS_MAX } from '../core/mechanics.js'
import { EDIT, EDITED, END, START, seedRoom } from '../test/support/seed-room.js'

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const
const mechanicsOf = (r: { context?: readonly string[] | undefined }) => (r.context ?? []).filter(c => c.startsWith('You are '))

test('the mechanics go with the first prompt alone, within R42, and never with a slash command', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  expect(mechanicsOf(await $.prompt.submit({ ...typed('/compact'), command: { name: 'compact', args: '' } }))).toEqual([])
  const first = mechanicsOf(await $.prompt.submit(typed('hi')))
  expect(first).toHaveLength(1)
  expect(first[0]?.length).toBeLessThanOrEqual(MECHANICS_MAX)
  expect(first[0]).toContain(`NAME.${room.code}`)
  expect(mechanicsOf(await $.prompt.submit(typed('again')))).toEqual([])
  expect(room.logs).toEqual([]) // context, never a drawn line (R42)
  await $.session.end(END)
})

test('a session in no room gets no mechanics and no title', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  room.pointer(null)
  on('classic.UserPromptSubmit', () => ({}))
  await $.session.start(START)
  await room.settled(clock)
  expect((await $.prompt.submit(typed('hi'))).context).toBeUndefined()
  expect((await $.classic.UserPromptSubmit({ prompt: 'hi', prompt_id: 'p1', permission_mode: 'default' })).sessionTitle).toBeUndefined()
  await $.session.end(END)
})

test('every prompt carries the session title its join gave it (R6)', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  on('classic.UserPromptSubmit', () => ({}))
  await $.session.start(START)
  await room.settled(clock)
  const r = await $.classic.UserPromptSubmit({ prompt: 'hi', prompt_id: 'p1', permission_mode: 'default' })
  expect(r.sessionTitle).toBe(`alice.${room.code}`)
  await $.session.end(END)
})

test('an overlap heads-up rides the next tool result of a running loop, once, and not a subagent\'s', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'Edit' }, () => EDIT.result)
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text' }, text: 'ok' }))
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await $.tool.call(EDIT.input)
  await room.as('bob').activity({ files: [EDITED] })
  await room.poll(clock)
  const read = { tool: 'Read', file_path: '/elsewhere/x.md' } as const
  expect((await $.tool.call({ ...read, agentId: 'helper-1' })).context).toBeUndefined()
  const r = await $.tool.call(read)
  expect(r.context?.join('\n')).toContain(`[room ${room.code} · overlap] bob is editing ${EDITED}, which you edited recently.`)
  expect((await $.tool.call(read)).context).toBeUndefined()
  expect((await $.prompt.submit(typed('next'))).context?.join('\n')).not.toContain('overlap')
  await $.session.end(END)
})

test('after /clear the session follows on under its new id, and its new conversation gets the mechanics', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await $.prompt.submit(typed('hi'))
  await $.session.end({ ...END, reason: 'clear' }) // no session.start follows (SessionEndInput)
  room.pointer('session-2') // the SessionStart hook claimed the handoff for the new id
  await room.poll(clock)
  await room.as('bob').finding('the store pages by cursor now')
  await room.poll(clock)
  expect(room.status.at(-1)).toBe(`${room.code} · bob (working) here · 1 update`)
  expect(room.requests.filter(r => r.op === 'ping').at(-1)).toMatchObject({ session: 'session-2' })
  expect(mechanicsOf(await $.prompt.submit(typed('again')))).toHaveLength(1)
  await $.session.end(END)
})

test('after the main conversation is compacted the next prompt carries the mechanics again; a subagent\'s compaction does not', async ($, on) => {
  const clock = mock.clock(on)
  const summary = (): SessionMessage[] => [{ role: 'user', text: 'summary of the conversation so far', toolUses: [] }]
  on('session.compact', () => ({ messages: summary() }))
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await $.prompt.submit(typed('hi'))
  await $.session.compact({ trigger: 'auto', agentId: 'helper-1', messages: summary() })
  expect(mechanicsOf(await $.prompt.submit(typed('on')))).toEqual([])
  await $.session.compact({ trigger: 'auto', messages: summary() })
  expect(mechanicsOf(await $.prompt.submit(typed('again')))).toHaveLength(1)
  await $.session.end(END)
})

test('after a leave the next prompt clears the session title, once', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  on('classic.UserPromptSubmit', () => ({}))
  await $.session.start(START)
  await room.settled(clock)
  const titled = () => $.classic.UserPromptSubmit({ prompt: 'hi', prompt_id: 'p1', permission_mode: 'default' })
  expect((await titled()).sessionTitle).toBe(`alice.${room.code}`)
  room.pointer(null) // the daemon's leave
  await $.prompt.submit({ ...typed('/sub-human leave'), command: { name: 'sub-human', args: 'leave' } })
  await room.poll(clock)
  expect((await titled()).sessionTitle).toBe('')
  expect((await titled()).sessionTitle).toBeUndefined()
  await $.session.end(END)
})
