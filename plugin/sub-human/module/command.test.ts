// command.ts: `/sub-human …` typed at my prompt is answered by the module as one plain line: the verbs run in the
// command hook beneath (node), the answer is a `$.ui.log` line, and the hook answers `{}`, which runs no expansion (no
// "blocked by hook" frame), echoes nothing and starts no turn. Elsewhere the classic hook answers (C1).
import { expect, mock, test } from 'claude-code/testing'
import { CWD, END, HOME, START, SESSION, expandReply, seedRoom, slash } from '../test/support/seed-room.js'

const HOME_KNOB = ['SUB', 'HUMAN', 'HOME'].join('_')

const OPENED = 'You opened room heron-2988 as alice. Others on this machine type /sub-human to join; /sub-human invite NAME brings someone from another machine.'
const LINE = 'ssh://devbox/heron-2988#7Q2M9K4R1T6V8X3Z5B0C2D4F6G'

test('a typed /sub-human runs its verb in the command hook beneath and draws the answer as one plain line, nothing else', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: [], now: clock.now, env: { SUB_HUMAN_NAME: 'alice' } })
  room.pointer(null)
  await $.session.start(START)
  await room.settled(clock)
  room.answer = expandReply(OPENED)
  expect(await $.command.run(slash(''))).toEqual({}) // no row, no echo, no model turn
  expect(room.logs).toEqual([OPENED]) // Claude Code puts "sub-human: " before it
  expect(room.submitted).toEqual([])
  const [run] = room.ran
  expect(run?.argv.slice(0, 1)).toEqual(['sh'])
  expect(run?.argv.slice(1)).toEqual([expect.stringMatching(/\/hooks\/node\.sh$/), 'expand'])
  expect(JSON.parse(run?.stdin ?? '')).toEqual({ session_id: SESSION, cwd: CWD, command_args: '' })
  // the home the module uses, and the session's knobs, handed over explicitly: the run never falls back to another home
  expect(run?.env).toEqual({ SUB_HUMAN_FROM_MODULE: '1', [HOME_KNOB]: HOME, SUB_HUMAN_NAME: 'alice', HOME: '/home/me' })
  await $.session.end(END)
})

test('a join line and its PIN go to the command hook alone: never drawn, echoed or handed to Claude', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'bob', others: ['alice'], now: clock.now })
  room.pointer(null)
  await $.session.start(START)
  await room.settled(clock)
  room.answer = expandReply('Asked the host to let you in.')
  expect(await $.command.run(slash(`join ${LINE} 4821`))).toEqual({})
  expect(room.logs).toEqual(['Asked the host to let you in.'])
  expect(JSON.stringify([room.logs, room.debug, room.submitted, room.status])).not.toContain('7Q2M9K4R')
  expect(JSON.parse(room.ran[0]?.stdin ?? '')).toMatchObject({ command_args: `join ${LINE} 4821` })
  await $.session.end(END)
})

test('a /sub-human that is not the person\'s own goes on to the classic hook beneath', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  on('command.run', () => ({ text: 'the classic hook' }))
  await $.session.start(START)
  await room.settled(clock)
  expect(await $.command.run({ ...slash('who'), origin: { kind: 'sdk' } })).toEqual({ text: 'the classic hook' })
  expect(room.ran).toEqual([])
  await $.session.end(END)
})

test('a command hook that answers nothing readable is one line; one policy refuses goes to the classic hook', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  on('command.run', () => ({ text: 'the classic hook' }))
  await $.session.start(START)
  await room.settled(clock)
  room.answer = ''
  expect(await $.command.run(slash('who'))).toEqual({})
  expect(room.logs).toEqual(["/sub-human didn't answer."])
  room.answer = ''
  expect(room.logs).toHaveLength(1)
  room.broken.run = true // policy refuses the run: the classic hook beneath answers, as with the module off
  expect(await $.command.run(slash('who'))).toEqual({ text: 'the classic hook' })
  expect(room.logs).toHaveLength(1)
  expect(room.submitted).toEqual([])
  await $.session.end(END)
})
