// at-room.ts (R8): `@room …` typed at my prompt posts my exact words as mine, never reaching my Claude, with one line;
// a leading member's name addresses them, the secret filter applies, and any other prompt passes untouched.
import { expect, mock, test } from 'claude-code/testing'
import * as v from '../vendor/valibot.mjs'
import { END, START, seedRoom } from '../test/support/seed-room.js'

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const
const Post = v.looseObject({ kind: v.literal('post'), from: v.string(), by: v.string(), text: v.string(), to: v.optional(v.string()) })

test('@room posts my exact words to the room as mine, addressed when a member\'s name leads, and my Claude never sees it (R8, R10)', async ($, on) => {
  const clock = mock.clock(on)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  const cases: [string, string][] = [
    ['@room everyone, rebase on main\n  then push', `sub-human: sent to ${room.code}.`],
    ['@room bob, which port does the server use?', `sub-human: sent to ${room.code}, to bob.`],
    ['@room ', 'sub-human: nothing was sent: type your words after @room.'],
    [`@room the token is ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`, 'sub-human: nothing was sent: it looks like it holds a secret (github-token). Type it without the secret.'],
  ]
  for (const [text, line] of cases) expect(await $.prompt.submit(typed(text))).toEqual({ drop: line })
  const posts = room.store.room.lines.flatMap(l => { const p = v.safeParse(Post, JSON.parse(l)); return p.success ? [p.output] : [] })
  expect(posts).toMatchObject([
    { from: 'alice', by: 'person', text: 'everyone, rebase on main\n  then push' },
    { from: 'alice', by: 'person', text: 'bob, which port does the server use?', to: 'bob' },
  ])
  expect(posts[0]?.to).toBeUndefined()
  expect((await $.prompt.submit(typed('@roomy is not a room line'))).text).toBe('@roomy is not a room line')
  await $.session.end(END)
})
