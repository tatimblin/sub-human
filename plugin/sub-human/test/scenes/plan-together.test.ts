// S-Plan together (R17–R22a): we write one shared plan in plan mode as we normally would, and it says who does what.
// I make my approved plan a room plan and ask bob; his "ask for changes" note reaches my Claude word for word; my
// revision is the next version, asked of him again with no question; once he agrees, the decision is recorded for
// that exact version and my Claude knows its own part. At most 6 lines are drawn for me (R41).
import { expect, mock, test } from 'claude-code/testing'
import * as v from '../../vendor/valibot.mjs'
import { EXIT, planWorld, typed } from '../support/plan-cards.js'
import { END, START, seedRoom } from '../support/seed-room.js'

const V1 = '# Cursor paging\n\n## Store @alice\n- `listTasks(cursor)` returns `{items, next}`\n\n## Handler @bob\n- passes `next` on\n'
const V2 = V1.replace('`{items, next}`', '`{items, next}`, `next` an opaque string')
const Line = v.looseObject({ kind: v.string(), version: v.optional(v.number()) })

test('one shared plan, asked, changed, agreed for its exact version; then my Claude knows its part (R21, R22, R22a)', async ($, on) => {
  const clock = mock.clock(on)
  const w = planWorld(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  const log = () => room.store.room.lines.map(l => v.parse(Line, JSON.parse(l)))
  await $.session.start(START)
  await room.settled(clock)

  w.plan = V1
  w.answer('Room plan', 'bob')
  await $.tool.call(EXIT.input)
  expect(log().filter(e => e.kind === 'plan_ask')).toMatchObject([{ version: 1, people: ['bob'] }])

  await room.as('bob').planAct({ act: 'answer', name: 'cursor-paging', version: 1, answer: 'changes', note: 'say what `next` is when the page is the last one' })
  await room.poll(clock)
  const asked = await $.prompt.submit(typed('what did bob say?'))
  expect(asked.context?.join('\n')).toContain('asked for changes on plan cursor-paging version 1: say what `next` is when the page is the last one')

  w.plan = V2 // my Claude revises it in plan mode; I approve
  const revised = await $.tool.call(EXIT.input)
  expect(w.asked).toHaveLength(2) // no third question: a revision of a room plan
  expect(revised.context?.at(-1)).toBe(`sub-human: this approved plan is room plan cursor-paging v2 in ${room.code}; asked bob to agree again.`)
  expect(room.logs).toContain('sub-human: shared as cursor-paging v2; asked bob again')

  await room.as('bob').planAct({ act: 'answer', name: 'cursor-paging', version: 2, answer: 'agree' })
  await room.poll(clock)
  expect(log().filter(e => e.kind === 'decision')).toMatchObject([{ version: 1, changes: ['bob'] }, { version: 2, agreed: ['bob'], changes: [] }])
  const go = await $.prompt.submit(typed('go'))
  expect(go.context?.join('\n')).toContain(`[room ${room.code} · plan cursor-paging v2]\nYour part: Store. The rest: bob: Handler.\n\n${V2}`)
  expect(w.writes).toEqual([])
  expect(w.configs).toEqual([])
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})
