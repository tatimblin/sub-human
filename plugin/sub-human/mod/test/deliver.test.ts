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
import type { Chunk, ClassicResultOf, EventOf, On } from 'claude-code'
import { test, expect, mock, type Engine } from 'claude-code/testing'
import { SEAT, OUT, must, ran, scriptOf, session, start, stdinOf, type helloOf } from './support.ts'

const SID = 'sid-d'
const line = (x: object) => JSON.stringify(x) + '\n'

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
  hello?: ReturnType<typeof helloOf>, pieces?: string[], gate?: Promise<void>,
  /** How the session takes a prompt the module submits (n counts from 0): entered, dropped by a hook, or failed. */
  submit?: (text: string, n: number) => 'ok' | 'drop' | 'throw',
  /** How the session takes a row the module appends (n counts from 0): stored, refused, or failed. */
  append?: (text: string, n: number) => 'ok' | 'deny' | 'throw',
  /** A child of the test's own in place of the one below (n counts from 0). */
  spawn?: (n: number, e: EventOf['process.spawn']) => AsyncGenerator<Chunk<'process.spawn'>, void>,
  /** What hooks/handlers/prompt.ts answers for a prompt (default: no review open). */
  promptOut?: (prompt: string) => object,
  /** What hooks/handlers/join.ts answers (default: nothing). */
  joinOut?: object,
}

/**
 * The engine beneath: mod-hello answering `hello`; the first tail child streaming `pieces`, then whatever the test
 * feeds it, staying up until the test ends (`release`); later children only wait; the session's notices, prompts
 * (each attempt in `submits`, the ones that entered in `prompts`) and scripts recorded.
 */
type Seen = {
  spawns: EventOf['process.spawn'][]; logs: string[]; prompts: string[]; submits: string[]; contexts: EventOf['prompt.submit']['context'][]
  appends: string[]; appended: string[]
  scripts: string[]; classic: ClassicResultOf['classic.UserPromptSubmit'][]; ended: number[]; release: () => void; feed: (text: string) => void; presence: Record<string, unknown>[]
}
function world(engine: Engine, on: On, { hello = OUT, pieces = [], gate = Promise.resolve(), submit = () => 'ok', append = () => 'ok', spawn, promptOut, joinOut }: Opts = {}) {
  const seen: Seen = {
    spawns: [], logs: [], prompts: [], submits: [], contexts: [], appends: [], appended: [],
    scripts: [], classic: [], ended: [], release: () => {}, feed: () => {}, presence: [],
  }
  let released = false
  const fed: string[] = []
  let poke = () => {}
  const held = new Promise<void>(r => { seen.release = () => { released = true; poke(); r() } })
  seen.feed = text => { fed.push(text); poke() }
  session(on, SID)
  on('process.run', (_$, e) => {
    const script = scriptOf(e)
    seen.scripts.push(script)
    if (script === 'presence.ts') seen.presence.push(stdinOf(e))
    if (script === 'prompt.ts') return ran(JSON.stringify(promptOut ? promptOut(String(stdinOf(e).prompt)) : { subHuman: { reviewOpen: false } }))
    if (script === 'join.ts' && joinOut) return ran(JSON.stringify(joinOut))
    return ran(script === 'mod-hello.ts' ? JSON.stringify(hello) : '')
  })
  on('process.spawn', async function* (_$, e) {
    const n = seen.spawns.length
    seen.spawns.push(e)
    if (spawn) { yield { stream: 'stderr', text: 'started\n' }; yield* spawn(n, e); return { value: { code: 1, signal: null } } }
    try {
      await gate
      if (n === 0) {
        for (const text of pieces) yield { stream: 'stdout', text }
        while (!released) {
          if (fed.length) yield { stream: 'stdout', text: must(fed.shift(), 'a fed line') }
          else await new Promise<void>(r => { poke = r })
        }
      }
      await held
      return { value: { code: 0, signal: null } }
    } finally { seen.ended.push(n) }
  })
  on('ui.log', (_$, e) => { seen.logs.push(e.text); return { value: undefined } })
  on('session.append', async (_$, e, next) => {
    if (e.message.type === 'system') return next(e) // the hidden home notice (stage 8f item 1), no delivery
    const text = e.message.content.map(b => b.text).join('')
    const how = append(text, seen.appends.length)
    seen.appends.push(text)
    if (how === 'throw') throw new Error('no session to keep it')
    if (how === 'deny') return { deny: 'not now' }
    const r = await next(e)
    seen.appended.push(text)
    return r
  })
  on('prompt.submit', async (_$, e) => {
    const how = submit(e.text, seen.submits.length)
    seen.submits.push(e.text)
    if (how === 'throw') throw new Error('no session to take it')
    if (how === 'drop') return { drop: 'not now' }
    seen.prompts.push(e.text); seen.contexts.push(e.context)
    seen.classic.push(await engine.classic.UserPromptSubmit({ prompt: e.text, session_id: SID, permission_mode: 'default' }))
    return { text: e.text }
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.messages', () => ({ value: [] }))
  return seen
}

test('a seated session starts the tail child: node scripts/sub-human tail --ndjson, by its session id', async ($, on) => {
  const seen = world($, on)
  await start($)
  await until(() => seen.spawns.length === 1)
  const e = must(seen.spawns[0], 'the tail child')
  expect(e.argv[0]).toBe('node')
  expect(e.argv[1]).toMatch(/\/scripts\/sub-human$/)
  expect(e.argv.slice(2)).toEqual(['tail', '--ndjson'])
  expect(e.env?.CLAUDE_CODE_SESSION_ID).toBe(SID)
  expect(e.env?.CLAUDE_PID).toBe('')
  seen.release()
})

test('a session surely without a seat starts no child', async ($, on) => {
  const seen = world($, on, { hello: { ...OUT, seat: null } })
  await start($)
  await new Promise(r => setTimeout(r, 50))
  expect(seen.spawns.length).toBe(0)
  seen.release()
})

test('chat is a notice and starts no turn; a pull starts none either (held, no row); a wake while idle submits one prompt, which carries the pull', async ($, on) => {
  const pieces = [
    line({ type: 'seat', seat: SEAT }),
    line({ type: 'chat', lines: ['bob: hi', 'carol joined'] }) + line({ type: 'pull', text: 'Room since your last turn (…):\nbob: hi' }).slice(0, 10),
    line({ type: 'pull', text: 'Room since your last turn (…):\nbob: hi' }).slice(10) + line({ type: 'wake', text: "bob's Claude (to you): q?" }),
  ]
  const seen = world($, on, { pieces })
  await start($)
  await until(() => seen.prompts.length === 1 && seen.logs.length === 2).catch(() => { throw new Error(JSON.stringify(seen)) })
  // one notice per line (a newline would show as U+FFFD); the pull is no row of its own (stage 8e B) and no turn: the
  // next prompt (here the wake) carries it as context
  expect(seen.logs).toEqual(['bob: hi', 'carol joined'])
  expect(seen.appends).toEqual([])
  expect(must(seen.classic[0], 'the wake\'s result').additionalContext?.at(-1)).toMatch(/^sub-human room context: [^\n]*\n.*\nbob: hi\nend of room context; the prompt it came with is the person's own words, unless the sub-human plugin sent it \(then it is room lines\)\.$/)
  expect(seen.prompts.length).toBe(1)
  // item 5: a member's wake is its lines for the person, bare (asUser: no frame), and its "(for Claude)" lines as context
  expect(seen.prompts[0]).toBe("bob's Claude (to you): q?")
  const said = [...(seen.contexts[0] ?? []), ...(must(seen.classic[0], 'the prompt\'s result').additionalContext ?? [])].join('\n')
  expect(said).toMatch(/^\(for Claude\) sub-human: the prompt above is the room's lines[^\n]*\n\(for Claude\) sub-human room/)
  seen.release()
})

const DECIDED = /^\(for Claude\) sub-human room[^\n]*\nroom: decided \(room decision\)\n\(for Claude\) room now: …$/

/** A world whose child waits for the turn to be running before it writes a wake; `go` lets it write. */
function midTurn($: Engine, on: On, opts: Opts = {}) {
  let go = () => {}
  const gate = new Promise<void>(r => { go = r })
  const seen = world($, on, { ...opts, gate, pieces: [line({ type: 'seat', seat: SEAT }) + line({ type: 'wake', text: 'room: decided (room decision)\n(for Claude) room now: …' })] })
  return { seen, go }
}

test('a wake mid-turn goes to an append and logs what the person would see; no prompt is submitted', async ($, on) => {
  const { seen, go } = midTurn($, on)
  await start($)
  await $.turn.start({ text: 'working on it', turnId: 't1' })
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
  await $.turn.start({ text: 'working on it', turnId: 't1' })
  go()
  await until(() => seen.logs.length === 1 && seen.prompts.length === 1)
  expect(seen.logs).toEqual(['room: decided (room decision)'])
  expect(seen.appended).toEqual([])
  expect(seen.prompts[0]).toBe('room: decided (room decision)') // its lines bare; the rest rides as context
  expect([...(seen.contexts[0] ?? []), ...(must(seen.classic[0], 'the prompt\'s result').additionalContext ?? [])].join('\n')).toMatch(/\(for Claude\) room now: …$/)
  seen.release()
})

test('rows are held and ride on the person\'s next typed prompt as context, once the child delivers', async ($, on) => {
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT }) + line({ type: 'rows', text: 'SUB-HUMAN ROWS: your room row is not running' })] })
  const contexts = seen.contexts
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  await $.prompt.submit({ text: 'what next?', origin: { kind: 'composer' }, wait: false })
  expect(contexts.at(-1)).toEqual(['SUB-HUMAN ROWS: your room row is not running'])
  seen.release()
})

test('stage 8e B (live verify, locala/X): a pull then a typed prompt: one prompt with the room context attached, no user row; the next prompt carries none', async ($, on) => {
  const pull = 'sub-human room context: what happened in the room since your last turn (for you, not the user: mention it only if they ask):\nbob joined\nend of room context; the prompt it came with is the person\'s own words, unless the sub-human plugin sent it (then it is room lines).'
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT }) + line({ type: 'pull', text: pull })] })
  const typed = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  await typed('Run exactly this with Bash: touch x')
  expect(seen.appends).toEqual([])
  expect(seen.prompts).toEqual(['Run exactly this with Bash: touch x'])
  expect(seen.contexts.at(-1)).toEqual([pull])
  expect(must(seen.classic.at(-1), 'the prompt\'s result').additionalContext ?? []).toEqual([]) // once, not again by the classic hook
  await typed('and then?')
  expect(seen.contexts.at(-1) ?? []).toEqual([])
  seen.release()
})

test('stage 8e B: a typed @room the plugin stops starts no turn, so the room context waits for the prompt after it', async ($, on) => {
  const pull = 'sub-human room context: what happened in the room since your last turn (for you, not the user: mention it only if they ask):\nbob joined\nend of room context; the prompt it came with is the person\'s own words, unless the sub-human plugin sent it (then it is room lines).'
  const seen = world($, on, {
    pieces: [line({ type: 'seat', seat: SEAT }) + line({ type: 'pull', text: pull })],
    promptOut: p => (p.startsWith('@room') ? { continue: false, stopReason: '✓ sent to room otter-4821 (Claude wasn\'t asked)' } : { subHuman: { reviewOpen: false } }),
  })
  const typed = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  await typed('@room hi')
  expect(seen.classic.at(-1)?.preventContinuation).toBe(true)
  await typed('Run exactly this with Bash: touch x')
  expect(seen.contexts.at(-1)).toEqual([pull])
  expect(seen.appends).toEqual([])
  await typed('and then?')
  expect(seen.contexts.at(-1) ?? []).toEqual([])
  seen.release()
})

test('the held rows text rides once per change: the same text on the next prompt is not added again; a changed text is', async ($, on) => {
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT }) + line({ type: 'rows', text: 'proposal a1 still awaits alice' })] })
  const typed = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
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
  const typed = async (text: string) => { await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false }); await $.turn.start({ text, turnId: text }).catch(() => {}) }
  await typed('first')  // reviewMaybeOpen is unsure after session.start: prompt.ts runs and reports no review
  expect(seen.scripts.filter(x => x === 'prompt.ts').length).toBe(1)
  expect(seen.classic[0]?.sessionTitle).toBe('alice.otter-4821')
  await typed('second')
  await typed('third')
  expect(seen.scripts.filter(x => x === 'prompt.ts').length).toBe(1)
  expect(must(seen.classic[1], 'the second result').sessionTitle).toBe(undefined)
  expect(seen.scripts.filter(x => x === 'presence.ts').length).toBe(1)
  await typed('@room ship it') // a post is signed in node
  expect(seen.scripts.filter(x => x === 'prompt.ts').length).toBe(2)
  seen.release()
})

/** The turn's end as the engine raises it: an answer. */
const done = ($: Engine, turnId: string) => $.turn.complete({ turnId, answer: 'done', durationMs: 0, isAborted: false, reason: 'answer' })
const WAKE = (text: string) => line({ type: 'wake', text })
const typed = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })

test('a wake whose prompt a hook drops shows its room lines, and is appended instead', async ($, on) => {
  const wake = WAKE("bob's Claude (to you): q?\n  │ which file?\n(for Claude) room now: …")
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT }) + wake], submit: () => 'drop' })
  await start($)
  await until(() => seen.submits.length === 1 && seen.logs.length === 2 && seen.appended.length === 1)
  expect(seen.prompts).toEqual([])
  expect(seen.logs).toEqual(["bob's Claude (to you): q?", '  │ which file?'])
  expect(seen.appended[0]).toMatch(/^\(for Claude\) sub-human room[^\n]*\nbob's Claude \(to you\): q\?\n/)
  await $.turn.start({ text: 'next', turnId: 't1' })
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
  await $.turn.start({ text: 'next', turnId: 't1' })
  await until(() => seen.prompts.length === 1)
  expect(seen.prompts[0]).toBe("bob's Claude (to you): q?\n  │ which file?")
  expect(seen.logs.length).toBe(3) // delivered later without showing the lines again
  seen.release()
})

test('a mid-turn wake that can be neither appended nor submitted waits for the next turn, then is delivered', async ($, on) => {
  let go = () => {}
  const gate = new Promise<void>(r => { go = r })
  const seen = world($, on, { gate, pieces: [line({ type: 'seat', seat: SEAT }) + WAKE('room: decided')], submit: (_, n) => (n === 0 ? 'throw' : 'ok'), append: () => 'deny' })
  await start($)
  await $.turn.start({ text: 'working on it', turnId: 't1' })
  go()
  await until(() => seen.submits.length === 1 && seen.logs.length === 2)
  expect(seen.logs).toEqual(['room: decided', NOTICE])
  await done($, 't1').catch(() => {})
  expect(seen.prompts).toEqual([])
  await $.turn.start({ text: 'next', turnId: 't2' })
  await until(() => seen.prompts.length === 1)
  expect(seen.prompts[0]).toBe('room: decided')
  seen.release()
})

test('delivery errors are told once per window, however many there are', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT })], append: () => 'deny' })
  // a health line is a notice and a row the model reads: that row refused, the line is lost to the model
  const H = 'room log check: x'
  const health = line({ type: 'health', text: H })
  await start($)
  await until(() => seen.spawns.length === 1)
  seen.feed(health)
  await until(() => seen.logs.length === 2)
  expect(seen.logs).toEqual([H, NOTICE])
  seen.feed(health + line({ type: 'chat', lines: ['carol: hey'] }))
  await until(() => seen.logs.length === 4)
  expect(seen.logs).toEqual([H, NOTICE, H, 'carol: hey'])
  await clock.advance(300_000)
  seen.feed(health)
  await until(() => seen.logs.length === 6)
  expect(seen.logs).toEqual([H, NOTICE, H, 'carol: hey', H, NOTICE])
  seen.release()
})

test('a child that exits is started again after 1 s, doubling; one that ran over a minute starts the backoff over', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const seen = world($, on, {
    spawn: async function* (n) {
      yield* []
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
  for (const e of seen.spawns) expect(e.env?.CLAUDE_CODE_SESSION_ID).toBe(SID)
})

test('session.end stops the child: nothing restarts it, and the session no longer counts as delivered', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT })] })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  await typed($, 'first')
  const before = seen.scripts.filter(x => x === 'prompt.ts').length
  await typed($, 'second')
  expect(seen.scripts.filter(x => x === 'prompt.ts').length).toBe(before) // delivered: no node
  await $.session.end({ reason: 'other', sessionId: SID, resume: { id: SID } })
  await typed($, 'third')
  expect(seen.scripts.filter(x => x === 'prompt.ts').length).toBe(before + 1) // no child: node runs again
  seen.release()
  await clock.advance(120_000)
  expect(seen.spawns.length).toBe(1)
  expect(seen.logs).toEqual([]) // a child stopped on purpose is no delivery error
})

test('presence: a typed prompt writes "working", the end of its turn "idle" (an idle_prompt may never come); a wake\'s turn writes neither', async ($, on) => {
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT })] })
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  await typed($, 'first')
  await new Promise(r => setTimeout(r, 20))
  expect(seen.presence.length).toBe(0) // pending: written when its turn starts (a stopped prompt starts none)
  await $.turn.start({ text: '', turnId: 't1' }).catch(() => {})
  await until(() => seen.presence.length === 1)
  expect(seen.presence[0]?.hook_event_name).toBe('Working')
  await done($, 't1').catch(() => {})
  await until(() => seen.presence.length === 2)
  expect(seen.presence[1]?.hook_event_name).toBe('TurnEnd')
  await $.turn.start({ text: '', turnId: 't2' }).catch(() => {})
  await done($, 't2').catch(() => {})
  await new Promise(r => setTimeout(r, 30))
  expect(seen.presence.length).toBe(2)
  seen.release()
})

test('a /sub-human leave stops the child: the hello says no seat, nothing restarts it', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const hello = { ...OUT }
  const seen = world($, on, { hello, pieces: [line({ type: 'seat', seat: SEAT })] })
  on('command.run', () => ({}))
  on('env.get', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/w' }))
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  hello.seat = null // what mod-hello says once the leave took the seat
  // @ts-expect-error -- deliberate: no presentation, as these tests have always raised /sub-human
  await $.command.run({ command: 'sub-human:sub-human', args: 'leave', origin: { kind: 'composer' } })
  seen.release()
  await clock.advance(120_000)
  expect(seen.spawns.length).toBe(1)
})

test('stage 8e I.11 (live verify, remote/16b): a leave stops the child though the hello still names the seat (a room hosted elsewhere lists it a moment longer); nothing restarts it', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT })], joinOut: { subHuman: { say: 'left otter-4821 · /sub-human joins again', refused: false, shareable: true } } })
  on('command.run', () => ({}))
  on('env.get', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/w' }))
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  // @ts-expect-error -- deliberate: no presentation, as these tests have always raised /sub-human
  await $.command.run({ command: 'sub-human:sub-human', args: 'leave', origin: { kind: 'composer' } })
  // the stopped child's stream: a chat line after the leave reaches nobody
  seen.feed(line({ type: 'chat', lines: ['carol left'] }))
  await new Promise(r => setTimeout(r, 50))
  expect(seen.logs.filter(l => l === 'carol left')).toEqual([])
  seen.release()
  await clock.advance(120_000)
  expect(seen.spawns.length).toBe(1)
})

test('classic.SessionStart before session.start, in a session with no seat: no tail child', async ($, on) => {
  const seen = world($, on, { hello: { ...OUT, seat: null } })
  on('classic.SessionStart', () => ({}))
  on('fs.exists', () => ({ value: false })) // no session index: surely no seat
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/u' : undefined }))
  on('fs.stat', (_$, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  await $.classic.SessionStart({ session_id: SID, cwd: '/w', transcript_path: '/t.jsonl', source: 'startup' })
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
  await $.classic.SessionStart({ source: 'clear', session_id: 'sid-2' })
  await until(() => seen.spawns.length === 2)
  expect(seen.spawns.map(e => e.env?.CLAUDE_CODE_SESSION_ID)).toEqual([SID, 'sid-2'])
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
  await $.turn.start({ text: 'working on it', turnId: 't1' })
  go()
  await until(() => seen.appended.length === 1)
  await new Promise(r => setTimeout(r, 50))
  await clock.advance(10)
  await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 'u1' })
  await done($, 't1').catch(() => {})
  await $.turn.start({ text: 'next', turnId: 't2' })
  await new Promise(r => setTimeout(r, 50))
  expect(seen.appended.length).toBe(1)
  expect(seen.submits).toEqual([])
  seen.release()
})

test('a wake appended mid-turn that no later request carried is submitted at the turn\'s end, once', async ($, on) => {
  const { seen, go } = midTurn($, on)
  await start($)
  await $.turn.start({ text: 'working on it', turnId: 't1' })
  go()
  await until(() => seen.appended.length === 1)
  await done($, 't1').catch(() => {})
  await until(() => seen.prompts.length === 1)
  expect(seen.prompts[0]).toBe('room: decided (room decision)')
  await $.turn.start({ text: 'next', turnId: 't2' })
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
  const writes = () => seen.presence.map(p => p.notification_type || (p.error ? 'error' : p.hook_event_name))
  let n = 0
  const turn = async (text: string) => { await typed($, text); await $.turn.start({ text, turnId: `p${++n}` }).catch(() => {}); await new Promise(r => setTimeout(r, 20)) }
  await turn('one'); await turn('two')
  expect(writes()).toEqual(['Working'])
  await $.classic.Notification({ session_id: SID, notification_type: 'permission_prompt', message: 'ok?' })
  await turn('three')
  expect(writes()).toEqual(['Working', 'permission_prompt', 'Working'])
  await $.classic.Notification({ session_id: SID, notification_type: 'idle_prompt', message: 'waiting' })
  await turn('four')
  expect(writes()).toEqual(['Working', 'permission_prompt', 'Working', 'idle_prompt', 'Working'])
  await $.classic.StopFailure({ session_id: SID, error: 'rate_limit' })
  await turn('five'); await turn('six')
  expect(writes()).toEqual(['Working', 'permission_prompt', 'Working', 'idle_prompt', 'Working', 'error', 'Working'])
  seen.release()
})

test('O (live verify): "permission" does not stick: the tool call the person answered writes "working", the turn\'s end "idle"', async ($, on) => {
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT })] })
  on('classic.Notification', () => ({}))
  on('classic.PostToolUse', () => ({}))
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  const writes = () => seen.presence.map(p => p.notification_type || p.hook_event_name)
  await typed($, 'propose it')
  await $.turn.start({ text: '', turnId: 'q1' }).catch(() => {})
  await $.classic.Notification({ session_id: SID, notification_type: 'permission_prompt', message: 'plan' })
  await $.classic.PostToolUse({ session_id: SID, tool_name: 'ExitPlanMode', tool_input: {}, tool_response: {}, tool_use_id: 'x' })
  await until(() => writes().length === 3)
  expect(writes()).toEqual(['Working', 'permission_prompt', 'Working'])
  await $.classic.Notification({ session_id: SID, notification_type: 'permission_prompt', message: 'again' })
  await done($, 'q1').catch(() => {})
  await until(() => writes().length === 5)
  expect(writes()).toEqual(['Working', 'permission_prompt', 'Working', 'permission_prompt', 'TurnEnd'])
  seen.release()
})

test('typed through Remote Control, chat is relayed as a prompt of only its lines (the model\'s part is context); typed here again, a notice', async ($, on) => {
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT })] })
  const clock = mock.clock(on, { now: 0 })
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  await $.prompt.submit({ text: 'from the phone', origin: { kind: 'bridge' }, wait: false })
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
  const said = [...(seen.contexts[i] ?? []), ...(must(seen.classic[i], 'the relay\'s result').additionalContext ?? [])]
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
  await $.prompt.submit({ text: 'from the phone', origin: { kind: 'bridge' }, wait: false })
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

test('stage 8e G (live verify, remote/99x): the host\'s let-in wake is drawn as the person\'s line alone (asUser, no frame); its (for Claude) line rides as context', async ($, on) => {
  const shown = 'room: bob (check 59e9-554c) on mac typed your invite and its PIN and wants to join; your Claude shows you a card (or: /sub-human admit a6a8c73830ec)'
  const forClaude = '(for Claude) bob (check 59e9-554c) on mac typed alice\'s invite line and its PIN on another machine and asks to join room otter-4821. Only alice can let them in: call AskUserQuestion with the question "admit a6a8c73830ec"; the hooks show the card.'
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT }) + line({ type: 'wake', text: `${shown}\n${forClaude}` })] })
  await start($)
  await until(() => seen.prompts.length === 1)
  expect(seen.prompts).toEqual([shown])
  const said = [...(seen.contexts[0] ?? []), ...(must(seen.classic[0], 'the prompt\'s result').additionalContext ?? [])].join('\n')
  expect(said).toContain(forClaude)
  expect(said).not.toMatch(/The sub-human plugin sent a message|This is how Claude Code surfaces/)
  seen.release()
})
