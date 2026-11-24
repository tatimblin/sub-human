// S-Relevant (R15a, R15c): my Claude gets what bears on my work, not everything. A colleague's change to a file or an
// interface I'm using, or to a plan I'm part of, reaches me first and in full; the rest is one dim line or a count.
import { expect, mock, test } from 'claude-code/testing'
import { tokens } from '../../core/deliver.js'
import { CWD, EDIT, EDITED, END, START, seedRoom } from '../support/seed-room.js'

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const
const updates = (r: { context?: readonly string[] | undefined }) => (r.context ?? []).filter(c => c.startsWith('[room ')).join('\n')

test('an interface named in a plan I\'m on reaches my Claude in full; an unrelated update is only counted (R15c)', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob', 'carol'], now: clock.now })
  await room.as('bob').plan('paging', 'The store\'s `listTasks(cursor)` returns `{items, next}`; the handler passes `next` on.', ['alice'])
  await $.session.start(START)
  await room.settled(clock)
  await room.as('carol').finding('listTasks now takes an options object instead of a cursor string')
  await room.as('carol').finding('the docs site moved to a new host')
  await room.poll(clock)
  const context = updates(await $.prompt.submit(typed('go on')))
  expect(context).toBe(`[room ${room.code} · carol's Claude] listTasks now takes an options object instead of a cursor string`)
  expect(room.status.at(-1)).toBe(`${room.code}  ● bob  ● carol · plan "paging" needs your review`)
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})

test('a line naming me, or a file I edited, reaches my Claude and is drawn; a colleague\'s unrelated line is only counted (R15b, R15c)', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'Edit' }, () => EDIT.result)
  const room = await seedRoom(on, { me: 'alice', others: ['bob', 'carol'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await $.tool.call(EDIT.input)
  await room.as('carol').post('anyone up for lunch at 1')
  await room.as('bob').finding(`alice's ${EDITED} has a stale header`)
  await room.as('carol').finding(`${EDITED} is generated now; edit the template instead`)
  await room.poll(clock)
  const context = updates(await $.prompt.submit(typed('go on')))
  expect(context.split('\n')).toEqual([
    `[room ${room.code} · bob's Claude] alice's ${EDITED} has a stale header`,
    `[room ${room.code} · carol's Claude] ${EDITED} is generated now; edit the template instead`,
  ])
  expect(room.logs).toEqual([
    `bob's Claude: alice's ${EDITED} has a stale header`, `carol's Claude: ${EDITED} is generated now; edit the template instead`,
  ])
  expect(context).not.toContain('lunch')
  expect(room.status.at(-1)).toBe(`${room.code}  ● bob  ● carol`) // the lunch line is news's
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})

test('a person\'s line about a file I read is drawn and reaches my Claude; one about nothing of mine is not', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/src/schema.sql` }) // read, not edited
  await room.as('bob').post('src/schema.sql gets a tasks.cursor column today')
  await room.as('bob').post('standup moved to 10')
  await room.poll(clock)
  expect(updates(await $.prompt.submit(typed('go on')))).toBe(`[room ${room.code} · bob] src/schema.sql gets a tasks.cursor column today`)
  expect(room.logs).toEqual(['bob: src/schema.sql gets a tasks.cursor column today'])
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})

test('past the cap, what bears on me most survives: an overlap and lines about me before mere relevance', { timeoutMs: 15_000 }, async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'Edit' }, () => EDIT.result)
  const room = await seedRoom(on, { me: 'alice', others: ['bob', 'carol'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await $.tool.call(EDIT.input)
  for (let i = 0; i < 20; i++) {
    await room.as('carol').finding(`${EDITED} detail ${i}: ${'y'.repeat(100)}`)
    await clock.advance(10) // each a little later than the one before, well inside one poll
  }
  await room.as('bob').post('can you look at the header?', { to: 'alice', by: 'claude' })
  await room.as('bob').activity({ files: [EDITED] })
  await room.poll(clock)
  const context = updates(await $.prompt.submit(typed('go on')))
  expect(tokens(context)).toBeLessThan(400)
  expect(context).toContain(`bob is editing ${EDITED}, which you edited recently.`)
  expect(context).toContain('can you look at the header?')
  expect(context).not.toContain('detail 0:') // the oldest of the merely relevant went first
  expect(room.logs.slice(0, 2)).toEqual([ // drawn as the context is kept: the overlap first, then what is about me
    `bob is editing ${EDITED}, which you edited recently.`, `bob's Claude: can you look at the header?`,
  ])
  expect(room.logs.at(-1)).toMatch(/^sub-human: and \d+ more: \/sub-human news$/)
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})
