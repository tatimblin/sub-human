// S-Plan together (R17–R22a): we write one shared plan in plan mode as we normally would, and it says who does what.
// I make my approved plan a room plan and ask bob, and my Claude waits for him (R21a); his "ask for changes" note wakes
// my Claude word for word; my revision is the next version, asked of him again with no question; once he agrees, the
// decision is recorded for that exact version and my Claude is woken to build its own part. At most 6 lines are drawn
// for me (R41).
import { expect, mock, test } from 'claude-code/testing'
import * as v from '../../vendor/valibot.mjs'
import { EXIT, TURN, planWorld, typed } from '../support/plan-cards.js'
import { END, START, seedRoom } from '../support/seed-room.js'

const V1 = '# Cursor paging\n\n## Store @alice\n- `listTasks(cursor)` returns `{items, next}`\n\n## Handler @bob\n- passes `next` on\n'
const V2 = V1.replace('`{items, next}`', '`{items, next}`, `next` an opaque string')
const NOTE = 'say what `next` is when the page is the last one:\n- null, not an empty string\n- and document it'
const Line = v.looseObject({ kind: v.string(), version: v.optional(v.number()) })

test('one shared plan, asked, changed, agreed for its exact version; then my Claude knows its part (R21, R22, R22a)', async ($, on) => {
  const clock = mock.clock(on)
  const w = planWorld(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  const log = () => room.store.room.lines.map(l => v.parse(Line, JSON.parse(l)))
  await $.session.start(START)
  await room.settled(clock)

  w.plan = V1
  w.answer('Get agreement', 'bob')
  await $.tool.call(EXIT.input)
  expect(log().filter(e => e.kind === 'plan_ask')).toMatchObject([{ version: 1, people: ['bob'] }])

  await room.as('bob').planAct({ act: 'answer', name: 'cursor-paging', version: 1, answer: 'changes', note: NOTE })
  await room.poll(clock)
  await room.poll(clock) // wake.ts submits on a tick once the session is idle
  // the wiring: the note's wake submitted, its line drawn (core/deliver.node-test.ts pins their words)
  expect(room.submitted).toHaveLength(1)
  expect(room.submitted[0]?.text).toContain(NOTE)
  expect(room.logs.filter(l => l.includes('asked for changes'))).toHaveLength(1)

  w.plan = V2 // my Claude revises it in plan mode; I approve
  const revised = await $.tool.call(EXIT.input)
  expect(w.asked).toHaveLength(2) // no third question: a revision of a room plan
  expect(room.logs).toContain('sub-human: shared as "cursor-paging" v2; asked bob again')
  expect(log().filter(e => e.kind === 'plan' || e.kind === 'plan_ask').slice(-2)).toMatchObject([{ kind: 'plan', version: 2, base: 1 }, { kind: 'plan_ask', version: 2, people: ['bob'] }])
  expect(revised.context?.at(-1)).toContain('v2 is out for agreement with bob.') // the revision waits again

  await $.turn.complete(TURN) // the woken turn ends
  await room.as('bob').planAct({ act: 'answer', name: 'cursor-paging', version: 2, answer: 'agree' })
  await room.poll(clock)
  await room.poll(clock)
  expect(log().filter(e => e.kind === 'decision')).toMatchObject([{ version: 1, changes: ['bob'] }, { version: 2, agreed: ['bob'], changes: [] }])
  expect(room.submitted).toHaveLength(2) // the agreement's wake, the revision having waited again
  expect(room.submitted[1]?.text).toContain(`[room ${room.code}#1]`)
  const go = await $.prompt.submit(typed('go'))
  expect(go.context?.join('\n')).toContain(`[room ${room.code} · plan cursor-paging v2]\nYour part: Store. The rest: bob: Handler.\n\n${V2}`)
  expect(w.writes).toEqual([])
  expect(w.configs).toEqual([])
  expect(room.logs.length).toBeLessThanOrEqual(6) // R41
  await $.session.end(END)
})
