// The scenes "join" and "remote join", the host's side (R30): the Let in / Refuse card, shown once per joiner, naming
// them, their machine, a name mismatch and the check string, and its answer posted to the daemon.
import type { On } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'
import * as v from '../vendor/valibot.mjs'
import { END, START as IN_ROOM, seedRoom } from '../test/support/seed-room.js'

const START = { cwd: '/work/api', surface: 'terminal', isInteractive: true } as const
const INVITE = { text: '/sub-human invite bob', wait: false, origin: { kind: 'composer' }, command: { name: 'sub-human', args: 'invite bob' } } as const
const ASK = { id: 'a1', code: 'otter-4821', kind: 'admit', name: 'bob', expected: 'bob', machine: 'bob-laptop', check: '1f2e-3d4c', member: false }

/** The daemon beneath: answers asks once with `asks`, records every request, and answers the card with `pick`. */
function world(on: On, asks: readonly object[], pick: string | null, text?: string) {
  mock.env(on, { HOME: '/u', SUB_HUMAN_HOME: '/u/sh' })
  const clock = mock.clock(on)
  const sent: { op: string; [k: string]: unknown }[] = []
  const asked: string[] = []
  const logged: string[] = []
  let left = [...asks]
  on('http.fetch', (_, e) => {
    const body = v.parse(v.looseObject({ op: v.string() }), JSON.parse(String(e.init?.body ?? '{}')))
    sent.push({ ...body, socketPath: e.init?.socketPath })
    const value = body.op === 'asks' ? { asks: left } : null
    if (body.op === 'asks') left = []
    return { value: { status: 200, ok: true, headers: {}, text: text ?? JSON.stringify({ ok: true, value }) } }
  })
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { isError: true, result: null, text: 'no' }
    const q = /"question":"((?:[^"\\]|\\.)*)"/.exec(JSON.stringify(e))?.[1]?.replace(/\\(.)/g, '$1') ?? ''
    asked.push(q)
    if (pick === null) throw new Error('dismissed')
    return { result: { answers: { [q]: pick } }, text: `answered ${pick}` }
  })
  on('ui.log', (_, e) => { if (e.to !== 'debug') logged.push(e.text); return { value: undefined } })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  return { clock, sent, asked, logged }
}

test('a joiner waiting: the card names them, their machine and the check; Let in is posted for this session (R30)', async ($, on) => {
  const w = world(on, [ASK], 'Let in')
  await $.session.start(START)
  await $.prompt.submit(INVITE)
  await w.clock.advance(3000)
  await w.clock.advance(3000)
  expect(w.asked).toEqual(['Let bob on bob-laptop into otter-4821? Check 1f2e-3d4c matches theirs.'])
  expect(w.sent.filter(s => s.op === 'admit')).toEqual([{ op: 'admit', session: 'sess-1', code: 'otter-4821', id: 'a1', answer: 'let_in', socketPath: '/u/sh/daemon.sock' }])
})

test('a name that is not the invite\'s is on the card; a dismissed card is a Refuse', async ($, on) => {
  const w = world(on, [{ ...ASK, name: 'mallory' }], null)
  await $.session.start(START)
  await $.prompt.submit(INVITE)
  await w.clock.advance(3000)
  expect(w.asked[0]).toContain('mallory (the invite was for bob)')
  expect(w.sent.filter(s => s.op === 'admit').map(s => s.answer)).toEqual(['refuse'])
})

test('a line dialled twice is one line; one that let someone in offers their removal', async ($, on) => {
  const w = world(on, [{ ...ASK, kind: 'again' }, { ...ASK, id: 'a2', kind: 'leaked' }], 'Remove bob')
  await $.session.start(START)
  await $.prompt.submit(INVITE)
  await w.clock.advance(3000)
  expect(w.logged).toEqual(['sub-human: someone else also used the invite for bob; nobody got in with it'])
  expect(w.sent.filter(s => s.op === 'admit').map(s => [s.id, s.answer])).toEqual([['a2', 'kick']])
})

test('a joiner whose name is already a member: the card says so', async ($, on) => {
  const w = world(on, [{ ...ASK, member: true }], 'Refuse')
  await $.session.start(START)
  await $.prompt.submit(INVITE)
  await w.clock.advance(3000)
  expect(w.asked[0]).toContain('bob is already a member there.')
})

test('an answer the module can\'t read is one line, not repeated on the next polls', async ($, on) => {
  const w = world(on, [], null, '{"ok":true,"value":{"asks":"nope"}}')
  await $.session.start(START)
  await $.prompt.submit(INVITE)
  await w.clock.advance(3000)
  await w.clock.advance(3000)
  expect(w.logged.length).toBe(1)
  expect(w.logged[0]).toMatch(/^sub-human: no joiner can be let in: /)
})

test('a session in no room that has not invited asks nothing', async ($, on) => {
  const w = world(on, [], null)
  await $.session.start(START)
  await w.clock.advance(9000)
  expect(w.sent.filter(s => s.op === 'asks')).toEqual([])
})

test('a host session in its room asks who waits without typing /sub-human invite', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: [], now: clock.now })
  await $.session.start(IN_ROOM)
  await room.settled(clock)
  await clock.advance(3000)
  expect(room.requests.filter(r => r.op === 'asks').length).toBeGreaterThan(0)
  await $.session.end(END)
})
