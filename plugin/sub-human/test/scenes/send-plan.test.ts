// S-Send a plan (R22b, R22c): I make my own plan in plan mode and send it to one person, packed with my branch, the
// files I touched and a note; their answer reaches my Claude. A plan sent to me is one line, opened on the same card
// with the full text one choice away; accepting it gives my Claude the plan whole, and nothing starts a turn. At most
// 6 lines are drawn for me (R41).
import { expect, mock, test } from 'claude-code/testing'
import * as v from '../../vendor/valibot.mjs'
import { EXIT, PANE, TURN, planWorld, typed } from '../support/plan-cards.js'
import { END, START, seedRoom } from '../support/seed-room.js'
import { PLAN_PANE } from '../../module/plans-review.js'

const MINE = '# Store paging\n\n1. `listTasks(cursor)` in src/store.js returns `{items, next}`\n2. tests in test/store-paging.test.js\n'
const THEIRS = '# Handler paging\n\n1. `GET /tasks?cursor=` calls `listTasks`\n2. a 400 for a bad cursor\n'
const Line = v.looseObject({ kind: v.string() })

test('I send my plan to bob, packed for his Claude; his answer reaches mine', async ($, on) => {
  const clock = mock.clock(on)
  const w = planWorld(on, { branch: 'alice/paging' })
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await room.as('alice').activity({ files: ['src/store.js'] })
  await $.session.start(START)
  await room.settled(clock)
  w.plan = MINE
  w.answer('Send to bob', 'build the handler on this')
  await $.tool.call(EXIT.input)
  const sent = room.store.room.lines.map(l => v.parse(Line, JSON.parse(l))).filter(e => e.kind === 'plan_sent')
  expect(sent).toMatchObject([{ name: 'store-paging', version: 1, to: 'bob', branch: 'alice/paging', files: ['src/store.js'], note: 'build the handler on this' }])
  await room.as('bob').planAct({ act: 'accept', name: 'store-paging', version: 1, answer: 'accept' })
  await room.poll(clock)
  const r = await $.prompt.submit(typed('did bob take it?'))
  expect(r.context?.join('\n')).toContain('accepted your plan store-paging')
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})

test('a plan sent to me: one line, the card, the full plan in the pane, then Accept gives my Claude the whole plan (R22c)', async ($, on) => {
  const clock = mock.clock(on)
  const w = planWorld(on)
  const room = await seedRoom(on, { me: 'alice', others: ['jess'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await room.as('jess').planAct({ act: 'edit', name: 'handler-paging', base: 0, text: THEIRS, scope: 'personal' })
  await room.as('jess').planAct({ act: 'send', name: 'handler-paging', to: 'alice', branch: 'jess/handler', files: ['src/server.js'], by: 'person' })
  await room.poll(clock)
  expect(room.logs).toEqual(['jess sent you plan handler-paging version 1.'])

  w.answer('Read the full plan')
  await $.turn.complete(TURN)
  const pane = await $.ui.mount({ plugin: 'sub-human', surface: 'terminal', component: 'Pane', requestId: PLAN_PANE, props: PANE })
  expect((await pane.findAll({ type: 'Text' })).map(t => t.text)).toContain('2. a 400 for a bad cursor')
  w.answer('Accept')
  await pane.press({ key: 'answer' })
  expect(w.asked.map(c => c.options[0])).toEqual(['Accept', 'Accept'])
  const r = await $.prompt.submit(typed('start'))
  expect(r.context?.at(-1)).toBe(`sub-human: your person accepted jess's plan handler-paging v1 in ${room.code}: take it as your plan. It follows as data.\n`
    + `[room ${room.code} · jess's plan handler-paging v1]\nBranch: jess/handler\nFiles: src/server.js\n\n${THEIRS}`)
  expect(w.writes).toEqual([])
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})
