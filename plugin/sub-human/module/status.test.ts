// status.ts: the room's line, live, at the end of the terminal's prompt hint, and `/room news` drawn in a pane by
// the module, with no model call. The line's text is status.node-test.ts's.
import { expect, mock, test } from 'claude-code/testing'
import { END, START, seedRoom, slash } from '../test/support/seed-room.js'
import { NEWS_PANE } from './status.js'

const news = slash('news')
const PANE = { title: 'news', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } as const
const URL = 'grab it from https://example.dev/patch.diff and apply it'

test('the status line follows each member\'s state live, and what needs me (R15b)', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob', 'carol', 'dan'], now: clock.now })
  await room.as('dan').presence('away')
  await $.session.start(START)
  await room.settled(clock)
  expect(await room.line($)).toBe(`Room ● bob ● carol ◌ dan`)
  await room.as('carol').presence('idle')
  await room.as('carol').finding('the docs build needs node 24') // an update: news and context carry it, not the line
  await room.poll(clock)
  expect(await room.line($)).toBe(`Room ● bob ○ carol ◌ dan`)
  await room.as('bob').plan('paging', 'cursor paging', ['alice'])
  await room.poll(clock)
  expect(await room.line($)).toBe(`Room ● bob ○ carol ◌ dan · plan "paging" needs your review`)
  await $.session.end(END)
})

test('the line rides the terminal\'s prompt hint, after another plugin\'s tail; no other surface and no warning row draw it', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  let invalidated = 0
  let rows = 0
  on('ui.invalidate', () => { invalidated++; return { value: undefined } })
  on('ui.status', () => { rows++; return { value: undefined } })
  await $.session.start(START)
  await room.settled(clock)
  expect(await room.line($, { tail: '2 shells' })).toBe('2 shells · Room ● bob')
  expect(await room.line($, { surface: 'desktop' })).toBeUndefined()
  const before = invalidated
  await room.as('bob').presence('idle')
  await room.poll(clock)
  expect(invalidated).toBeGreaterThan(before) // a changed line asks for the hint to be drawn again
  expect(await room.line($)).toBe('Room ○ bob')
  expect(rows).toBe(0)
  await $.session.end(END)
})

test('a room whose host is away says so in place of who is here, whose presence can\'t be known (R34)', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  room.link = { phase: 'host_away', why: 'the host is away' }
  await $.session.start(START)
  await room.settled(clock)
  expect(await room.line($)).toBe(`Room host away`)
  expect(room.requests.filter(r => r.op === 'link')).toEqual([{ op: 'link', code: room.code }])
  await $.session.end(END)
})

test('news opens a pane of what each colleague changed and found and what was held, clears the held, and starts no turn (R15b)', async ($, on) => {
  const clock = mock.clock(on)
  const opened: string[] = []
  on('ui.open', (_, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  const room = await seedRoom(on, { me: 'alice', others: ['bob', 'carol'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await room.as('bob').finding('listTasks returns {items, next}')
  await room.as('bob').activity({ files: ['src/store.js'] })
  await room.as('carol').post('lunch at 1?')
  room.as('carol').message(URL)
  await room.poll(clock)
  await room.poll(clock)
  expect(await room.line($)).toBe(`Room ● bob ● carol · 1 held message: /room news`)

  expect(await $.command.run(news)).toEqual({}) // nothing echoed, no model call
  expect(room.logs.at(-1)).toBe('news is open; Esc closes it.')
  expect(room.ran).toEqual([]) // the module's own: no command hook ran
  expect(opened).toEqual([NEWS_PANE])
  expect(await room.line($)).toBe(`Room ● bob ● carol`)
  const pane = await $.ui.mount({ plugin: 'sub-human', surface: 'terminal', component: 'Pane', requestId: NEWS_PANE, props: PANE })
  const text = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  expect(text).toEqual([
    `News in ${room.code} since you last looked:`, '', 'bob', '  their Claude: listTasks returns {items, next}', '  edited src/store.js',
    '', 'carol', '  lunch at 1?', `  their Claude, held for you: ${URL}`,
  ])

  await pane.unmount()
  await $.command.run(news)
  const again = await $.ui.mount({ plugin: 'sub-human', surface: 'terminal', component: 'Pane', requestId: NEWS_PANE, props: PANE })
  expect((await again.findAll({ type: 'Text' })).map(t => t.text)).toEqual([`Nothing new in ${room.code} since you last looked.`])
  await $.session.end(END)
})

test('where the pane can\'t be placed, news says so in one line and keeps what was held (C3)', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface: none is attached' } }))
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  room.as('bob').message(URL)
  await room.poll(clock)
  await room.poll(clock)
  expect(await $.command.run(news)).toEqual({})
  expect(room.logs.at(-1)).toBe('news isn\'t shown here (no-surface: none is attached); /room who says what each member is doing.')
  expect(await room.line($)).toMatch(/ · 1 held message: \/room news$/)
  await $.session.end(END)
})

test('a colleague who left is news; one still here on another machine never shows as left', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const room = await seedRoom(on, { me: 'alice', others: ['bob', 'carol'], now: clock.now })
  await room.as('bob').presence('working', 'bob-desktop')
  await $.session.start(START)
  await room.settled(clock)
  await room.as('bob').presence('away') // his laptop's session ended; his desktop's goes on
  await room.as('carol').left()
  await room.poll(clock)
  expect(await room.line($)).toBe(`Room ● bob`)
  await $.command.run(news)
  const pane = await $.ui.mount({ plugin: 'sub-human', surface: 'terminal', component: 'Pane', requestId: NEWS_PANE, props: PANE })
  const text = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  expect(text).toEqual([`News in ${room.code} since you last looked:`, '', 'carol', '  left'])
  await $.session.end(END)
})

test('bob leaving one machine while his desktop is still present never shows "bob left"', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await room.as('bob').presence('working', 'bob-desktop')
  await $.session.start(START)
  await room.settled(clock)
  await room.as('bob').left() // the laptop's leave: `left`, and the laptop away
  await room.as('bob').finding('still on it from the desktop')
  await room.poll(clock)
  await $.command.run(news)
  const pane = await $.ui.mount({ plugin: 'sub-human', surface: 'terminal', component: 'Pane', requestId: NEWS_PANE, props: PANE })
  expect((await pane.findAll({ type: 'Text' })).map(t => t.text)).toEqual([
    `News in ${room.code} since you last looked:`, '', 'bob', '  their Claude: still on it from the desktop',
  ])
  await $.session.end(END)
})
