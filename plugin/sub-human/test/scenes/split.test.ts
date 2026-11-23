// S-Split, from a plan (R20, R22a): a shared plan says who does what, and once it is agreed its owned parts are the
// room's tasks, linked to the agreed version. Owners who agreed have theirs claimed; a part for someone never asked
// stays open with their name in it. My Claude gets my part and who owns the rest, once. At most 6 lines (R41).
import { expect, mock, test } from 'claude-code/testing'
import * as v from '../../vendor/valibot.mjs'
import { TURN, planWorld, typed } from '../support/plan-cards.js'
import { END, START, seedRoom } from '../support/seed-room.js'

const PLAN = '# Paging\n\n- @bob the store: `listTasks(cursor)`\n- @alice the handler: `GET /tasks?cursor=`\n- @carol the docs page\n'
const Task = v.looseObject({ kind: v.literal('task'), task: v.looseObject({ n: v.number(), title: v.string(), status: v.string(), owner: v.optional(v.string()) }) })

test('an agreed plan splits into tasks by owner, and my Claude knows its part and who owns the rest', async ($, on) => {
  const clock = mock.clock(on)
  const w = planWorld(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob', 'carol'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await room.as('bob').plan('paging', PLAN, ['alice'])
  await room.poll(clock)

  w.answer('Agree')
  await $.turn.complete(TURN)
  const tasks = room.store.room.lines.flatMap(l => { const t = v.safeParse(Task, JSON.parse(l)); return t.success ? [t.output.task] : [] })
  expect(tasks).toMatchObject([
    { n: 1, title: 'the store: listTasks(cursor)', status: 'claimed', owner: 'bob' },
    { n: 2, title: 'the handler: GET /tasks?cursor=', status: 'claimed', owner: 'alice' },
    { n: 3, title: '@carol the docs page', status: 'open' },
  ])
  await room.poll(clock)
  const r = await $.prompt.submit(typed('what is mine?'))
  const mine = r.context?.find(c => c.includes('Your part'))
  expect(mine).toContain(`[room ${room.code} · plan paging v1]\nYour part: the handler: GET /tasks?cursor=. The rest: bob: the store: listTasks(cursor); carol: the docs page.`)
  expect((await $.prompt.submit(typed('and?'))).context?.some(c => c.includes('Your part'))).toBeFalsy()
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})
