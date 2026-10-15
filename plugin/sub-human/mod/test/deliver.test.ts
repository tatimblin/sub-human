// Wiring: the room's delivery through the hooks module (mod/deliver.ts). Run with `npm run test:mods`.
// The routing table and the turn ledger are tested in node (test/mod-core.node-test.ts, test/mod-core-deliver.node-test.ts);
// the tail's events in test/tail.node-test.ts. This checks the hooks: session.start spawns `node scripts/sub-human tail
// --ndjson` for a seated session, restarted with backoff and stopped at the session's end, and its events reach
// the session: a chat event is a $.ui.log notice and starts no turn, a wake while idle submits one prompt (and logs
// its visible lines when a hook drops it), a wake mid-turn goes to an append (and logs them) instead, and a failure
// leaves a notice.
// The 2.1.292 test kit had no bottom for a plugin's own $.session.append, so every append failed and these tests
// were written around that. Since 2.1.296 (at the latest) the kit stores the row and a test's on('session.append')
// is reached by the module's call: world() keeps or refuses each append (`append`), so both paths are tested here.
// The test's $ has no state noun, so deliveryErrors shows here only through its notice.
import { test, expect, mock } from 'claude-code/testing'
import { SEAT, OUT, ran, scriptOf, session, start } from './support.ts'

const SID = 'sid-d'
const line = (x: any) => JSON.stringify(x) + '\n'

/** Resolves once cond() holds (the child's loop runs on after the hook returned), or rejects after ms. */
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

const NOTICE = "a room message didn't arrive here. Run /sub-human doctor."
type Opts = {
  hello?: any, pieces?: string[], gate?: Promise<void>,
  /** How the session takes a prompt the module submits (n counts from 0): entered, dropped by a hook, or failed. */
  submit?: (text: string, n: number) => 'ok' | 'drop' | 'throw',
  /** How the session takes a row the module appends (n counts from 0): stored, refused, or failed. */
  append?: (text: string, n: number) => 'ok' | 'deny' | 'throw',
  /** A child of the test's own in place of the one below (n counts from 0). */
  spawn?: (n: number, e: any) => AsyncGenerator<any, any, any>,
}

/**
 * The engine beneath: mod-hello answering `hello`; the first tail child streaming `pieces`, then whatever the test
 * feeds it, staying up until the test ends (`release`); later children only wait; the session's notices, prompts
 * (each attempt in `submits`, the ones that entered in `prompts`) and scripts recorded.
 */
function world(engine: any, on: any, { hello = OUT, pieces = [], gate = Promise.resolve(), submit = () => 'ok', append = () => 'ok', spawn }: Opts = {}) {
  const seen = {
    spawns: [] as any[], logs: [] as string[], prompts: [] as string[], submits: [] as string[], contexts: [] as any[],
    appends: [] as string[], appended: [] as string[],
    scripts: [] as string[], classic: [] as any[], ended: [] as number[], release: () => {}, feed: (text: string) => {}, presence: [] as any[],
  }
  let released = false
  const fed: string[] = []
  let poke = () => {}
  const held = new Promise<void>(r => { seen.release = () => { released = true; poke(); r() } })
  seen.feed = text => { fed.push(text); poke() }
  session(on, SID)
  on('process.run', ($: any, e: any) => {
    const script = scriptOf(e)
    seen.scripts.push(script)
    if (script === 'presence.ts') seen.presence.push(JSON.parse(e.init.stdin))
    if (script === 'prompt.ts') return ran(JSON.stringify({ subHuman: { reviewOpen: false } }))
    return ran(script === 'mod-hello.ts' ? JSON.stringify(hello) : '')
  })
  on('process.spawn', async function* ($: any, e: any) {
    const n = seen.spawns.length
    seen.spawns.push(e)
    if (spawn) { yield { stream: 'stderr', text: 'started\n' }; yield* spawn(n, e); return { value: { code: 1, signal: null } } }
    try {
      await gate
      if (n === 0) {
        for (const text of pieces) yield { stream: 'stdout', text }
        while (!released) {
          if (fed.length) yield { stream: 'stdout', text: fed.shift() as string }
          else await new Promise<void>(r => { poke = r })
        }
      }
      await held
      return { value: { code: 0, signal: null } }
    } finally { seen.ended.push(n) }
  })
  on('ui.log', ($: any, e: any) => { seen.logs.push(e.text); return { value: undefined } })
  on('session.append', async ($: any, e: any, next: any) => {
    const text = e.message.content.map((b: any) => b.text).join('')
    const how = append(text, seen.appends.length)
    seen.appends.push(text)
    if (how === 'throw') throw new Error('no session to keep it')
    if (how === 'deny') return { deny: 'not now' }
    const r = await next(e)
    seen.appended.push(text)
    return r
  })
  on('prompt.submit', async ($: any, e: any) => {
    const how = submit(e.text, seen.submits.length)
    seen.submits.push(e.text)
    if (how === 'throw') throw new Error('no session to take it')
    if (how === 'drop') return { drop: 'not now' }
    seen.prompts.push(e.text); seen.contexts.push(e.context)
    seen.classic.push(await engine.classic.UserPromptSubmit({ prompt: e.text, session_id: SID, permission_mode: 'default' }))
    return { text: e.text }
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('session.messages', () => ({ value: [] }))
  return seen
}

test('a seated session starts the tail child: node scripts/sub-human tail --ndjson, by its session id', async ($, on) => {
  const seen = world($, on)
  await start($)
  await until(() => seen.spawns.length === 1)
  const e = seen.spawns[0]
  expect(e.argv[0]).toBe('node')
  expect(e.argv[1]).toMatch(/\/scripts\/sub-human$/)
  expect(e.argv.slice(2)).toEqual(['tail', '--ndjson'])
  expect(e.env.CLAUDE_CODE_SESSION_ID).toBe(SID)
  expect(e.env.CLAUDE_PID).toBe('')
  seen.release()
})

test('a session surely without a seat starts no child', async ($, on) => {
  const seen = world($, on, { hello: { ...OUT, seat: null } })
  await start($)
  await new Promise(r => setTimeout(r, 50))
  expect(seen.spawns.length).toBe(0)
  seen.release()
})

test('chat is a notice and starts no turn; a pull starts none either; a wake while idle submits one prompt', async ($, on) => {
  const pieces = [
    line({ type: 'seat', seat: SEAT }),
    line({ type: 'chat', lines: ['bob: hi', 'carol joined'] }) + line({ type: 'pull', text: 'Room since your last turn (…):\nbob: hi' }).slice(0, 10),
    line({ type: 'pull', text: 'Room since your last turn (…):\nbob: hi' }).slice(10) + line({ type: 'wake', text: "bob's Claude (to you): q?" }),
  ]
  const seen = world($, on, { pieces })
  await start($)
  await until(() => seen.prompts.length === 1 && seen.logs.length === 2 && seen.appended.length === 1).catch(() => { throw new Error(JSON.stringify(seen)) })
  // one notice per line (a newline would show as U+FFFD); the pull is a row the model reads, not a turn
  expect(seen.logs).toEqual(['bob: hi', 'carol joined'])
  expect(seen.appended).toEqual(['Room since your last turn (…):\nbob: hi'])
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toMatch(/^\(for Claude\) sub-human room/)
  expect(seen.prompts[0]).toMatch(/bob's Claude \(to you\): q\?$/)
  seen.release()
})

const DECIDED = /^\(for Claude\) sub-human room[^\n]*\nroom: decided \(room decision\)\n\(for Claude\) room now: …$/

/** A world whose child waits for the turn to be running before it writes a wake; `go` lets it write. */
function midTurn($: any, on: any, opts: Opts = {}) {
  let go = () => {}
  const gate = new Promise<void>(r => { go = r })
  const seen = world($, on, { ...opts, gate, pieces: [line({ type: 'seat', seat: SEAT }) + line({ type: 'wake', text: 'room: decided (room decision)\n(for Claude) room now: …' })] })
  return { seen, go }
}

test('a wake mid-turn goes to an append and logs what the person would see; no prompt is submitted', async ($, on) => {
  const { seen, go } = midTurn($, on)
  await start($)
  await $.turn.start({ text: 'working on it', turnId: 't1' } as any)
  go()
  await until(() => seen.logs.length === 1 && seen.appended.length === 1)
  expect(seen.logs).toEqual(['room: decided (room decision)'])
  expect(seen.appended[0]).toMatch(DECIDED)
  await new Promise(r => setTimeout(r, 50))
  expect(seen.submits).toEqual([])
  seen.release()
})

test('a wake mid-turn whose append is refused falls back to a prompt, whole', async ($, on) => {
  const { seen, go } = midTurn($, on, { append: () => 'deny' })
  await start($)
  await $.turn.start({ text: 'working on it', turnId: 't1' } as any)
  go()
  await until(() => seen.logs.length === 1 && seen.prompts.length === 1)
  expect(seen.logs).toEqual(['room: decided (room decision)'])
  expect(seen.appended).toEqual([])
  expect(seen.prompts[0]).toMatch(DECIDED)
  seen.release()
})

test('rows are held and ride on the person\'s next typed prompt as context, once the child delivers', async ($, on) => {
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT }) + line({ type: 'rows', text: 'SUB-HUMAN ROWS: your room row is not running' })] })
  const contexts = seen.contexts
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  await $.prompt.submit({ text: 'what next?', origin: { kind: 'composer' }, wait: false } as any)
  expect(contexts.at(-1)).toEqual(['SUB-HUMAN ROWS: your room row is not running'])
  seen.release()
})

test('the held rows text rides once per change: the same text on the next prompt is not added again; a changed text is', async ($, on) => {
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT }) + line({ type: 'rows', text: 'proposal a1 still awaits alice' })] })
  const typed = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as any)
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  await typed('first')
  expect(seen.contexts.at(-1)).toEqual(['proposal a1 still awaits alice'])
  await typed('second')
  expect(seen.contexts.at(-1) ?? []).toEqual([])
  seen.feed(line({ type: 'rows', text: 'proposal b2 still awaits alice' }))
  await new Promise(r => setTimeout(r, 50))
  await typed('third')
  expect(seen.contexts.at(-1)).toEqual(['proposal b2 still awaits alice'])
  await typed('fourth')
  expect(seen.contexts.at(-1) ?? []).toEqual([])
  seen.release()
})

test('while the child delivers, a member\'s plain prompt starts no node once consent said no review is open; the mod titles the session', async ($, on) => {
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT })] })
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  const typed = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as any)
  await typed('first')  // reviewMaybeOpen is unsure after session.start: prompt.ts runs and reports no review
  expect(seen.scripts.filter(x => x === 'prompt.ts').length).toBe(1)
  expect(seen.classic[0].sessionTitle).toBe('alice.otter-4821')
  await typed('second')
  await typed('third')
  expect(seen.scripts.filter(x => x === 'prompt.ts').length).toBe(1)
  expect(seen.classic[1].sessionTitle).toBe(undefined)
  expect(seen.scripts.filter(x => x === 'presence.ts').length).toBe(1)
  await typed('@room ship it') // a post is signed in node
  expect(seen.scripts.filter(x => x === 'prompt.ts').length).toBe(2)
  seen.release()
})

const WAKE = (text: string) => line({ type: 'wake', text })
const typed = ($: any, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as any)

test('a wake whose prompt a hook drops shows its room lines, and is appended instead', async ($, on) => {
  const wake = WAKE("bob's Claude (to you): q?\n  │ which file?\n(for Claude) room now: …")
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT }) + wake], submit: () => 'drop' })
  await start($)
  await until(() => seen.submits.length === 1 && seen.logs.length === 2 && seen.appended.length === 1)
  expect(seen.prompts).toEqual([])
  expect(seen.logs).toEqual(["bob's Claude (to you): q?", '  │ which file?'])
  expect(seen.appended[0]).toMatch(/^\(for Claude\) sub-human room[^\n]*\nbob's Claude \(to you\): q\?\n/)
  await $.turn.start({ text: 'next', turnId: 't1' } as any)
  await new Promise(r => setTimeout(r, 50))
  expect(seen.submits.length).toBe(1) // the model has it: not held for the next turn
  seen.release()
})

test('a wake whose prompt a hook drops and whose append is refused shows its room lines, and is delivered at the next turn.start', async ($, on) => {
  const wake = WAKE("bob's Claude (to you): q?\n  │ which file?\n(for Claude) room now: …")
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT }) + wake], submit: (_, n) => (n === 0 ? 'drop' : 'ok'), append: () => 'deny' })
  await start($)
  await until(() => seen.submits.length === 1 && seen.logs.length === 3)
  expect(seen.prompts).toEqual([])
  // no prompt row shows a dropped wake: its visible lines are notices, one per line, without "(for Claude)" lines;
  // then its append is refused, so the person is told it is not delivered yet
  expect(seen.logs).toEqual(["bob's Claude (to you): q?", '  │ which file?', NOTICE])
  await $.turn.start({ text: 'next', turnId: 't1' } as any)
  await until(() => seen.prompts.length === 1)
  expect(seen.prompts[0]).toMatch(/^\(for Claude\) sub-human room[^\n]*\nbob's Claude \(to you\): q\?\n/)
  expect(seen.logs.length).toBe(3) // delivered later without showing the lines again
  seen.release()
})

test('a mid-turn wake that can be neither appended nor submitted waits for the next turn, then is delivered', async ($, on) => {
  let go = () => {}
  const gate = new Promise<void>(r => { go = r })
  const seen = world($, on, { gate, pieces: [line({ type: 'seat', seat: SEAT }) + WAKE('room: decided')], submit: (_, n) => (n === 0 ? 'throw' : 'ok'), append: () => 'deny' })
  await start($)
  await $.turn.start({ text: 'working on it', turnId: 't1' } as any)
  go()
  await until(() => seen.submits.length === 1 && seen.logs.length === 2)
  expect(seen.logs).toEqual(['room: decided', NOTICE])
  await $.turn.complete({ turnId: 't1', answer: 'done' } as any).catch(() => {})
  expect(seen.prompts).toEqual([])
  await $.turn.start({ text: 'next', turnId: 't2' } as any)
  await until(() => seen.prompts.length === 1)
  expect(seen.prompts[0]).toMatch(/\nroom: decided$/)
  seen.release()
})

test('delivery errors are told once per window, however many there are', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT })], append: () => 'deny' })
  const pull = line({ type: 'pull', text: 'Room since your last turn (…):\nbob: hi' })
  await start($)
  await until(() => seen.spawns.length === 1)
  seen.feed(pull)
  await until(() => seen.logs.length === 1)
  expect(seen.logs).toEqual([NOTICE])
  seen.feed(pull + line({ type: 'chat', lines: ['carol: hey'] }))
  await until(() => seen.logs.length === 2)
  expect(seen.logs).toEqual([NOTICE, 'carol: hey'])
  await clock.advance(300_000)
  seen.feed(pull)
  await until(() => seen.logs.length === 3)
  expect(seen.logs).toEqual([NOTICE, 'carol: hey', NOTICE])
  seen.release()
})

test('a child that exits is started again after 1 s, doubling; one that ran over a minute starts the backoff over', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const seen = world($, on, {
    spawn: async function* (n) {
      if (n === 2) await clock.sleep(61_000) // the third runs a while before it exits
    },
  })
  const spawned = async (n: number) => { await clock.settle(); await until(() => seen.spawns.length >= n); expect(seen.spawns.length).toBe(n) }
  await start($)
  await spawned(1)
  await clock.advance(999); await spawned(1)
  await clock.advance(1); await spawned(2)
  await clock.advance(1999); await spawned(2)
  await clock.advance(1); await spawned(3)
  await clock.advance(61_000); await spawned(3) // it exited after 61 s: the backoff starts over at 1 s
  await clock.advance(999); await spawned(3)
  await clock.advance(1); await spawned(4)
  expect(seen.logs).toEqual([]) // a restart resumes from the child's cursor: nothing lost yet
  await clock.advance(1000); await spawned(5)
  await clock.advance(2000); await spawned(6)
  expect(seen.logs).toEqual([NOTICE]) // the third failure in a row: the room is going unheard
  for (const e of seen.spawns) expect(e.env.CLAUDE_CODE_SESSION_ID).toBe(SID)
})

test('session.end stops the child: nothing restarts it, and the session no longer counts as delivered', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT })] })
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  await typed($, 'first')
  const before = seen.scripts.filter(x => x === 'prompt.ts').length
  await typed($, 'second')
  expect(seen.scripts.filter(x => x === 'prompt.ts').length).toBe(before) // delivered: no node
  await $.session.end({ reason: 'other', sessionId: SID, resume: { id: SID } } as any)
  await typed($, 'third')
  expect(seen.scripts.filter(x => x === 'prompt.ts').length).toBe(before + 1) // no child: node runs again
  seen.release()
  await clock.advance(120_000)
  expect(seen.spawns.length).toBe(1)
  expect(seen.logs).toEqual([]) // a child stopped on purpose is no delivery error
})

test('a /sub-human leave stops the child: the hello says no seat, nothing restarts it', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const hello: any = { ...OUT }
  const seen = world($, on, { hello, pieces: [line({ type: 'seat', seat: SEAT })] })
  on('command.run', () => ({ text: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/w' }))
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  hello.seat = null // what mod-hello says once the leave took the seat
  await $.command.run({ command: 'sub-human:sub-human', args: 'leave', origin: { kind: 'composer' } } as any)
  seen.release()
  await clock.advance(120_000)
  expect(seen.spawns.length).toBe(1)
})

test('classic.SessionStart before session.start, in a session with no seat: no tail child', async ($, on) => {
  const seen = world($, on, { hello: { ...OUT, seat: null } })
  on('classic.SessionStart', () => ({}))
  on('fs.exists', () => ({ value: false })) // no session index: surely no seat
  on('env.get', ($: any, e: any) => ({ value: e.name === 'HOME' ? '/u' : undefined }))
  on('fs.stat', ($: any, e: any) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  await $.classic.SessionStart({ session_id: SID, cwd: '/w', transcript_path: '/t.jsonl', source: 'startup' } as any)
  await start($)
  await new Promise(r => setTimeout(r, 50))
  expect(seen.spawns.length).toBe(0)
  seen.release()
})

test('a /clear (a new session id) stops the old child and starts one for the new id', async ($, on) => {
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT })] })
  on('classic.SessionStart', () => ({}))
  await start($)
  await until(() => seen.spawns.length === 1)
  await $.classic.SessionStart({ source: 'clear', session_id: 'sid-2' } as any)
  await until(() => seen.spawns.length === 2)
  expect(seen.spawns.map(e => e.env.CLAUDE_CODE_SESSION_ID)).toEqual([SID, 'sid-2'])
  seen.release()
  await until(() => seen.ended.length === 2)
  expect(seen.spawns.length).toBe(2) // the old one ended for good: not restarted
})

test('turn.start, a mid-turn wake, a tool call, turn.complete: the wake is delivered once, never twice', async ($, on) => {
  // appended mid-turn, and a tool call finished after it: the request that followed carried it, so the turn's end
  // submits nothing (the ledger's rules are checked in node, test/mod-core-deliver.node-test.ts)
  const clock = mock.clock(on, { now: 1_000 })
  const { seen, go } = midTurn($, on)
  on('classic.PostToolUse', () => ({}))
  await start($)
  await $.turn.start({ text: 'working on it', turnId: 't1' } as any)
  go()
  await until(() => seen.appended.length === 1)
  await new Promise(r => setTimeout(r, 50))
  await clock.advance(10)
  await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 'u1' } as any)
  await $.turn.complete({ turnId: 't1', answer: 'done' } as any).catch(() => {})
  await $.turn.start({ text: 'next', turnId: 't2' } as any)
  await new Promise(r => setTimeout(r, 50))
  expect(seen.appended.length).toBe(1)
  expect(seen.submits).toEqual([])
  seen.release()
})

test('a wake appended mid-turn that no later request carried is submitted at the turn\'s end, once', async ($, on) => {
  const { seen, go } = midTurn($, on)
  await start($)
  await $.turn.start({ text: 'working on it', turnId: 't1' } as any)
  go()
  await until(() => seen.appended.length === 1)
  await $.turn.complete({ turnId: 't1', answer: 'done' } as any).catch(() => {})
  await until(() => seen.prompts.length === 1)
  expect(seen.prompts[0]).toMatch(DECIDED)
  await $.turn.start({ text: 'next', turnId: 't2' } as any)
  await new Promise(r => setTimeout(r, 50))
  expect(seen.prompts.length).toBe(1)
  seen.release()
})

test('a permission prompt, an idle prompt or a failed turn writes its presence and resets it: the next typed prompt writes "working"', async ($, on) => {
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT })] })
  on('classic.Notification', () => ({}))
  on('classic.StopFailure', () => ({}))
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  // each presence run, by what it writes: the module is presence's one writer (node hooks/run.ts presence)
  const writes = () => seen.presence.map((p: any) => p.notification_type || (p.error ? 'error' : p.hook_event_name))
  await typed($, 'one'); await typed($, 'two')
  expect(writes()).toEqual(['Working'])
  await $.classic.Notification({ session_id: SID, notification_type: 'permission_prompt', message: 'ok?' } as any)
  await typed($, 'three')
  expect(writes()).toEqual(['Working', 'permission_prompt', 'Working'])
  await $.classic.Notification({ session_id: SID, notification_type: 'idle_prompt', message: 'waiting' } as any)
  await typed($, 'four')
  expect(writes()).toEqual(['Working', 'permission_prompt', 'Working', 'idle_prompt', 'Working'])
  await $.classic.StopFailure({ session_id: SID, error: 'rate_limit' } as any)
  await typed($, 'five'); await typed($, 'six')
  expect(writes()).toEqual(['Working', 'permission_prompt', 'Working', 'idle_prompt', 'Working', 'error', 'Working'])
  seen.release()
})

test('typed through Remote Control, chat is relayed as a prompt of only its lines (the model\'s part is context); typed here again, a notice', async ($, on) => {
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT })] })
  const clock = mock.clock(on, { now: 0 })
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  await $.prompt.submit({ text: 'from the phone', origin: { kind: 'bridge' }, wait: false } as any)
  const before = seen.prompts.length
  const nodes = seen.scripts.filter(x => x === 'prompt.ts').length
  seen.feed(line({ type: 'chat', lines: ['bob: hi', 'room: "Rate limiting" agreed (bob)'] }))
  await new Promise(r => setTimeout(r, 50))
  expect(seen.prompts.length).toBe(before) // not from inside the event's handling
  await clock.advance(250)
  await until(() => seen.prompts.length === before + 1)
  const i = seen.prompts.length - 1
  expect(seen.prompts[i]).toBe('bob: hi\nroom: "Rate limiting" agreed (bob)') // a "room:" line is no post
  expect(seen.prompts[i]).not.toContain('for Claude')
  const said = [...(seen.contexts[i] ?? []), ...(seen.classic[i].additionalContext ?? [])]
  expect(said).toEqual([expect.stringMatching(/^\(for Claude\) sub-human: the prompt above is room lines.*It needs no reply/)]) // once
  expect(seen.scripts.filter(x => x === 'prompt.ts').length).toBe(nodes) // no node: a relay is not the person's prompt
  expect(seen.logs).toEqual([])
  await typed($, 'back at the terminal')
  seen.feed(line({ type: 'chat', lines: ['bob: bye'] }))
  await until(() => seen.logs.length === 1)
  expect(seen.logs).toEqual(['bob: bye'])
  expect(seen.prompts.filter(p => p.startsWith('bob:')).length).toBe(1)
  seen.release()
})

test('relays are batched: chat that comes within RELAY_GAP_MS of a relay goes as one more, not one each', async ($, on) => {
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT })] })
  const clock = mock.clock(on, { now: 0 })
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  await $.prompt.submit({ text: 'from the phone', origin: { kind: 'bridge' }, wait: false } as any)
  const relays = () => seen.prompts.filter(p => /^(alice|bob|carol|dave):/.test(p))
  const fed = async (who: string) => { seen.feed(line({ type: 'chat', lines: [who] })); await new Promise(r => setTimeout(r, 30)) }
  await fed('alice: one')
  await clock.advance(250)
  await until(() => relays().length === 1)
  await fed('bob: two')
  await fed('carol: three')
  await clock.advance(1000)
  await fed('dave: four')
  await clock.advance(1000)
  await new Promise(r => setTimeout(r, 50))
  expect(relays().length).toBe(1) // still inside the gap
  await clock.advance(1000)
  await until(() => relays().length === 2)
  expect(relays()).toEqual(['alice: one', 'bob: two\ncarol: three\ndave: four'])
  seen.release()
})
