// status.ts: the status line, and `/sub-human news` drawn in a pane by the module, with no model call.
import { expect, mock, test } from 'claude-code/testing'
import { END, START, seedRoom } from '../test/support/seed-room.js'
import { NEWS_PANE } from './status.js'

const news = { text: '/sub-human news', wait: false, origin: { kind: 'composer' }, command: { name: 'sub-human', args: 'news' } } as const
const PANE = { title: 'news', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } as const

test('the status line names who is here, what they work on, and counts updates (R15b)', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob', 'carol', 'dan'], now: clock.now })
  await room.as('bob').focus('cursor paging for listTasks, end to end')
  await room.as('dan').presence('away')
  await $.session.start(START)
  await room.settled(clock)
  expect(room.status.at(-1)).toBe(`${room.code} · bob (working on cursor paging for listT…), carol (working) here`)
  await room.as('carol').presence('idle')
  await room.as('carol').finding('the docs build needs node 24')
  await room.as('bob').finding('listTasks returns {items, next}')
  await room.poll(clock)
  expect(room.status.at(-1)).toBe(`${room.code} · bob (working on cursor paging for listT…), carol here · 2 updates`)
  const n = await room.as('bob').task({ act: 'add', title: 'store paging' })
  await room.as('alice').task({ act: 'claim', n })
  await room.as('bob').task({ act: 'claim', n: await room.as('bob').task({ act: 'add', title: 'handler' }) })
  await room.poll(clock)
  expect(room.status.at(-1)).toMatch(new RegExp(`^${room.code} · .* here · 1 task · \\d+ updates$`)) // mine only (R24)
  await $.session.end(END)
})

test('a room whose host is away says so in place of who is here, whose presence can\'t be known (R34)', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  room.link = { phase: 'host_away', why: 'the host is away' }
  await $.session.start(START)
  await room.settled(clock)
  expect(room.status.at(-1)).toBe(`${room.code} · host away`)
  expect(room.requests.filter(r => r.op === 'link')).toEqual([{ op: 'link', code: room.code }])
  await $.session.end(END)
})

test('news opens a pane of what each colleague changed and found, clears the count, and starts no turn (R15b)', async ($, on) => {
  const clock = mock.clock(on)
  const opened: string[] = []
  on('ui.open', (_, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  const room = await seedRoom(on, { me: 'alice', others: ['bob', 'carol'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await room.as('bob').finding('listTasks returns {items, next}')
  await room.as('bob').activity({ files: ['src/store.js'] })
  await room.as('carol').post('lunch at 1?')
  await room.poll(clock)
  expect(room.status.at(-1)).toMatch(/ · 2 updates$/)

  const r = await $.prompt.submit(news)
  expect(r.drop).toBe('sub-human: news is open; Esc closes it.') // the prompt never entered: no model call
  expect(opened).toEqual([NEWS_PANE])
  expect(room.status.at(-1)).toBe(`${room.code} · bob (working), carol (working) here`)
  const pane = await $.ui.mount({ plugin: 'sub-human', surface: 'terminal', component: 'Pane', requestId: NEWS_PANE, props: PANE })
  const text = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  expect(text).toEqual([
    `News in ${room.code} since you last looked:`, '', 'bob', '  their Claude: listTasks returns {items, next}', '  edited src/store.js',
    '', 'carol', '  lunch at 1?',
  ])

  await pane.unmount()
  await $.prompt.submit(news)
  const again = await $.ui.mount({ plugin: 'sub-human', surface: 'terminal', component: 'Pane', requestId: NEWS_PANE, props: PANE })
  expect((await again.findAll({ type: 'Text' })).map(t => t.text)).toEqual([`Nothing new in ${room.code} since you last looked.`])
  await $.session.end(END)
})

test('where the pane can\'t be placed, news says so in one line and keeps the count (C3)', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface: none is attached' } }))
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await room.as('bob').finding('one')
  await room.poll(clock)
  const r = await $.prompt.submit(news)
  expect(r.drop).toBe('sub-human: news isn\'t shown here (no-surface: none is attached); /sub-human who says what each member is doing.')
  expect(room.status.at(-1)).toMatch(/ · 1 update$/)
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
  expect(room.status.at(-1)).toBe(`${room.code} · bob (working) here`)
  await $.prompt.submit(news)
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
  await $.prompt.submit(news)
  const pane = await $.ui.mount({ plugin: 'sub-human', surface: 'terminal', component: 'Pane', requestId: NEWS_PANE, props: PANE })
  expect((await pane.findAll({ type: 'Text' })).map(t => t.text)).toEqual([
    `News in ${room.code} since you last looked:`, '', 'bob', '  their Claude: still on it from the desktop',
  ])
  await $.session.end(END)
})

test('after news, the next update counts from one again', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await room.as('bob').finding('one')
  await room.as('bob').finding('two')
  await room.poll(clock)
  await $.prompt.submit(news)
  expect(room.status.at(-1)).toBe(`${room.code} · bob (working) here`)
  await room.as('bob').finding('three')
  await room.poll(clock)
  expect(room.status.at(-1)).toBe(`${room.code} · bob (working) here · 1 update`)
  await $.session.end(END)
})
