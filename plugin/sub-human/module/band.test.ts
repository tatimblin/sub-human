// band.ts: the row above the prompt while I am the only one here in a room hosted here (R30): its buttons make an
// invite through the same daemon op as `/room invite`, the line is copied and never logged or put in context,
// cancel takes it back, and it goes when anyone else is here, on a leave, in -p, under a survey, while the host is
// away, in a room hosted elsewhere, and when SUB_HUMAN_CC_OFF names it.
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { LinkStatus } from '../core/api.js'
import type { Room } from '../test/support/seed-room.js'
import { END, START, expandReply, seedRoom, slash } from '../test/support/seed-room.js'
import { typed } from '../test/support/plan-cards.js'
import { clockTime } from './band.js'

const BAND = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 9 }, view: {} } as const
const WORD = '0123456789abcdefghjkmnpqrstvwxyz0123456789abcdefghjkmnpqrstvwxyz0123456789abcd'
const LINE = `https://devbox.tail1234.ts.net/otter-4821#${WORD}`
const ALONE = 'Room otter-4821. Invite:'
const CREATED = 'Room otter-4821 created. Invite:'
const MIN = 60_000

interface Alone {
  readonly others?: readonly string[]; readonly kicked?: readonly string[]; readonly interactive?: boolean;
  readonly link?: LinkStatus; readonly env?: Readonly<Record<string, string>>; readonly survey?: boolean;
  /** bob in the room, in this state. */
  readonly here?: 'idle' | 'away';
}
/** Me in otter-4821 (`others` here before and gone, `kicked` removed), the name card answered `carol`, the band mounted. */
async function alone($: Engine, on: On, o: Alone = {}) {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: [...o.others ?? [], ...(o.here ? ['bob'] : [])], now: clock.now, ...(o.env && { env: o.env }) })
  if (o.here) await room.as('bob').presence(o.here)
  for (const name of o.others ?? []) await room.as(name).left()
  for (const name of o.kicked ?? []) await room.as(name).kicked()
  if (o.link) room.link = o.link
  const asked: { question: string; options: string[] }[] = []
  const copied: { text: string; surface?: string }[] = []
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { isError: true, result: null, text: 'no' }
    const q = e.questions[0]
    if (!q) return { isError: true, result: null, text: 'no question' }
    asked.push({ question: q.question, options: q.options.map(x => x.label) })
    return { result: { answers: { [q.question]: 'carol' } }, text: 'answered carol' }
  })
  let invalidated = 0
  on('ui.invalidate', (_, e, next) => { invalidated++; return next(e) }) // counted; the kit still redraws
  on('ui.copy', (_, e) => { copied.push({ text: e.text, ...(e.surface && { surface: e.surface }) }); return { value: { isCopied: true } } })
  await $.session.start({ ...START, isInteractive: o.interactive ?? true })
  await room.settled(clock)
  await clock.advance(1000)
  const band = await $.ui.mount({ plugin: 'sub-human', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: { ...BAND, hasSurvey: o.survey ?? false } })
  // the row's text, each part's style aside (the colours are their own test)
  const shown = async () => ({
    text: (await band.findAll({ type: 'Text' })).slice(0, 1).map(t => t.text),
    buttons: (await band.findAll({ type: 'Button' })).map(b => b.key),
  })
  return { clock, room, band, asked, copied, shown, redraws: () => invalidated }
}
async function polls(room: Room, clock: MockClock, n = 2): Promise<void> { for (let i = 0; i < n; i++) await room.poll(clock) }
const ready = (room: Room, clock: MockClock) => { room.invite = { line: LINE, id: 'inv1', expires: clock.now() + 2 * MIN } }

test('alone in my room: one row of the ways in; gone once someone else is here, back when they go, gone on my leave', async ($, on) => {
  const { clock, room, shown, redraws } = await alone($, on)
  expect(await shown()).toEqual({ text: [ALONE], buttons: ['public', 'tailnet', 'ssh'] })
  room.answer = expandReply('You opened room otter-4821 as alice. Others on this machine type /room to join.')
  await $.command.run(slash(''))
  await polls(room, clock)
  expect((await shown()).text).toEqual([CREATED]) // only right after this session made it
  const before = redraws()
  await room.as('bob').joined() // nothing else happens: the join alone redraws the mounted row away
  await room.poll(clock)
  expect(redraws()).toBeGreaterThan(before)
  expect(await shown()).toEqual({ text: [], buttons: [] })
  await room.as('bob').left()
  await polls(room, clock)
  expect((await shown()).text).toEqual([CREATED])
  room.pointer(null)
  await $.command.run(slash('leave'))
  await polls(room, clock)
  expect(await shown()).toEqual({ text: [], buttons: [] })
  await $.session.end(END)
})

const HIDDEN: readonly (readonly [string, Alone])[] = [
  ['a survey holds the band', { survey: true }],
  ['bob is here, idle, as the hint names him', { here: 'idle' }],
  ['bob is away but still in the room', { here: 'away' }],
  ['the host is away', { link: { phase: 'host_away', why: 'the host is away' } }],
  ['the room is hosted elsewhere', { link: { phase: 'online', why: null } }],
  ['SUB_HUMAN_CC_OFF names it', { env: { SUB_HUMAN_CC_OFF: 'invite-band' } }],
  ['the session is -p', { interactive: false }],
]
for (const [why, o] of HIDDEN) {
  test(`alone, but ${why}: no row`, async ($, on) => {
    const { shown } = await alone($, on, o)
    expect(await shown()).toEqual({ text: [], buttons: [] })
    await $.session.end(END)
  })
}

test('the row\'s text is dim; each button is one run in Claude\'s colour, brackets and all, so its highlight is one block', async ($, on) => {
  const { clock, room, band } = await alone($, on)
  const styled = async () => [
    ...(await band.findAll({ type: 'Text' })).map(t => [t.text, t.props.dimColor ?? t.props.color]),
    ...(await band.findAll({ type: 'Button' })).map(b => [b.key, b.props.plain]),
  ]
  const buttons = (keys: readonly string[]) => [...keys.map(k => [`[ ${k} ]`, 'claude']), ...keys.map(k => [k, true])]
  expect(await styled()).toEqual([[ALONE, true], ...buttons(['public', 'tailnet', 'ssh'])])
  ready(room, clock)
  await band.press({ key: 'public' })
  expect(await styled()).toEqual([[`Invite for carol until ${clockTime(clock.now() + 2 * MIN)} · /room join ${LINE}`, true], ...buttons(['copy', 'cancel'])])
  await $.session.end(END)
})

test('a way pressed asks whom for, then invites as /room invite does: a refusal is one line, a line is shown until it expires', async ($, on) => {
  const { clock, room, band, asked, shown } = await alone($, on, { others: ['bob', 'dan'], kicked: ['dan'] })
  await band.press({ key: 'public' })
  expect(asked).toEqual([{ question: 'Who is the invite for? Type their name under Other.', options: ['bob', 'Cancel'] }])
  expect(room.logs.at(-1)).toBe('No invite was made: Tailscale isn\'t running here')
  expect((await shown()).text).toEqual([ALONE])
  ready(room, clock)
  await band.press({ key: 'tailnet' })
  expect(room.requests.filter(r => r.op === 'invite')).toEqual([
    { op: 'invite', code: room.code, from: 'alice', name: 'carol', via: 'public' },
    { op: 'invite', code: room.code, from: 'alice', name: 'carol', via: 'tailnet' },
  ])
  expect(await shown()).toEqual({ text: [`Invite for carol until ${clockTime(clock.now() + 2 * MIN)} · /room join ${LINE}`], buttons: ['copy', 'cancel'] })
  await clock.advance(2 * MIN)
  await polls(room, clock)
  expect((await shown()).text).toEqual([ALONE])
  await $.session.end(END)
})

test('copy puts the line to type on the clipboard of the surface pressed; no log line or context carries its secret', async ($, on) => {
  const { clock, room, band, copied } = await alone($, on)
  ready(room, clock)
  await band.press({ key: 'ssh' })
  await band.press({ key: 'copy' })
  expect(copied).toEqual([{ text: `/room join ${LINE}`, surface: 'terminal' }])
  const sent = await $.prompt.submit(typed('who is here?'))
  await polls(room, clock)
  expect(JSON.stringify([room.logs, room.debug, sent, room.submitted])).not.toContain(WORD)
  await $.session.end(END)
})

test('cancel takes the invite back at the daemon and the row offers the ways in again', async ($, on) => {
  const { clock, room, band, shown } = await alone($, on)
  ready(room, clock)
  await band.press({ key: 'public' })
  await band.press({ key: 'cancel' })
  expect(room.requests.filter(r => r.op === 'uninvite')).toEqual([{ op: 'uninvite', code: room.code, from: 'alice', id: 'inv1' }])
  expect((await shown()).text).toEqual([ALONE])
  await $.session.end(END)
})
