// Wiring: the invite's copy card (PLAN-JOIN step 5; mod/deliver.ts command.run, mod/consent.ts AskUserQuestion). Run
// with `npm run test:mods`. The card's rules are tested in node (test/mod-core-copy.node-test.ts). This checks the hooks:
// a typed /sub-human invite whose reply carries the line submits one wake that names the invite's ref only (never the
// line, its SECRET or the PIN); the model's "copy invite REF" call is shown as the card; Copy runs a clipboard tool with
// the line on stdin (a stub here: nothing writes a real clipboard), Skip runs none, an invite gone says so, and with no
// line (--no-card) or no person at the prompt there is no card at all.
import type { EventOf, On } from 'claude-code'
import { test, expect, mock, type Engine } from 'claude-code/testing'
import { OUT, ran, scriptOf, session, start, stdinOf } from './support.ts'

const SID = 'sid-copy'
const SECRET = 'K'.repeat(38)
const PIN = '7093'
const lineOf = (ref: string) => `/sub-human join https://box.tail1a2b.ts.net/sub-human/otter-4821#${SECRET}${ref.slice(-1)}`
const QUESTION = 'Copy the invite line to your clipboard? (the PIN is not copied)'

/** Resolves once cond() holds (the wake goes out after the command returned), or rejects after ms. */
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

type Seen = {
  prompts: string[]; contexts: string[]; logs: string[]; appends: string[]
  clip: { argv: readonly string[]; stdin: string | undefined }[]; ids: string[]; cards: EventOf['tool.call'][]; tick: () => Promise<unknown>
  advance: (ms: number) => Promise<unknown>
}
/** The engine beneath: mod-hello, join.ts answering an invite (with the line unless noCard) or a cancel, clipboard
 * tools answering `clip` (exit codes in order; then 127), the prompts the module submits, and the card calls. */
function world(engine: Engine, on: On, { ref, noCard = false, clip = [0] }: { ref: string; noCard?: boolean; clip?: number[] }) {
  const seen: Seen = { prompts: [], contexts: [], logs: [], appends: [], clip: [], ids: [], cards: [], tick: async () => {}, advance: async () => {} }
  const clock = mock.clock(on, { now: 1_000_000 })
  seen.tick = () => clock.advance(1000)
  seen.advance = (ms: number) => clock.advance(ms)
  const line = lineOf(ref)
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('env.get', () => ({ value: undefined })) // no SUB_HUMAN_ROOM, no display: pbcopy is the only clipboard tool tried
  on('ui.log', (_$, e) => { seen.logs.push(e.text); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'sh' && String(e.argv[1]).endsWith('/scripts/clip.sh')) {
      seen.clip.push({ argv: e.argv, stdin: e.init?.stdin })
      return ran('', clip[seen.clip.length - 1] ?? 127)
    }
    const script = scriptOf(e)
    if (script === 'mod-hello.ts') return ran(JSON.stringify(OUT))
    if (script === 'join.ts') {
      const args = String(stdinOf(e).command_args)
      if (args.startsWith('invite --cancel')) return ran(JSON.stringify({ subHuman: { say: `cancelled the invite (${ref})`, refused: false, shareable: true } }))
      const pinned = { status: `PIN ${PIN} · ${line}`, ms: 900000, ref, ...(noCard ? {} : { line }) }
      return ran(JSON.stringify({ subHuman: { say: 'invite to room otter-4821 for one machine … pinned under the prompt', refused: false, shareable: false, pinned } }))
    }
    return ran(JSON.stringify({ subHuman: { reviewOpen: false } }))
  })
  on('prompt.submit', async (_$, e) => {
    seen.prompts.push(e.text)
    const r = await engine.classic.UserPromptSubmit({ prompt: e.text, session_id: SID, permission_mode: 'default' })
    seen.contexts.push(...(e.context ?? []), ...(r.additionalContext ?? []))
    return { text: e.text }
  })
  on('session.append', async (_$, e, next) => { seen.appends.push(e.message.content.map(b => b.text).join('')); return next(e) })
  on('classic.UserPromptSubmit', () => ({}))
  // beneath the module: the call's id as the engine gave it, and the card as the tool got it (after the Pre's updatedInput)
  on('classic.PreToolUse', (_$, e) => { seen.ids.push(String(e.tool_use_id)); return {} })
  on('classic.PostToolUse', () => ({}))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', (_$, e) => { seen.cards.push(e); return { result: 'ok', text: 'ok' } })
  return seen
}
const typed = ($: Engine, args: string) => $.command.run({ command: 'sub-human:sub-human', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 400 } })
/** The model's call for the card: "copy invite REF", as the wake asks. */
const ask = ($: Engine, ref: string) => $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: `copy invite ${ref}`, header: 'Invite', multiSelect: false, options: [{ label: 'Copy', description: '' }, { label: 'Skip', description: '' }] }] })
/** The card's Post, answered with label on the card the tool showed (the Pre's updatedInput), by the call's id. */
function answer($: Engine, seen: Seen, label: string) {
  const call = seen.cards.at(-1)
  const questions = call && call.tool === 'AskUserQuestion' ? call.questions : []
  return $.classic.PostToolUse({
    session_id: SID, tool_name: 'AskUserQuestion', tool_use_id: seen.ids.at(-1) ?? '', tool_input: { questions },
    tool_response: { questions, answers: { [QUESTION]: label } },
  })
}
const everything = (seen: Seen) => JSON.stringify([seen.prompts, seen.contexts, seen.appends, seen.logs])

test('an invite with its line: one wake naming the ref only; the card on "copy invite REF"; Copy puts the line, never the PIN, on the clipboard', async ($, on) => {
  const ref = 'c0ffee000001'
  const seen = world($, on, { ref, clip: [0, 0] })
  await start($)
  await typed($, 'invite'); await seen.tick()
  await until(() => seen.prompts.length === 1)
  // noise pass D: one framed line for the model, no line drawn as the person's, no room-lines context
  expect(seen.prompts[0]).toBe(`(for Claude) sub-human: the person made invite ${ref}. Call AskUserQuestion with the question "copy invite ${ref}" (the hooks show their Copy / Skip card and copy; you never see the line or its PIN), then reply with nothing.`)
  expect(seen.contexts.join('\n')).not.toContain("room's lines")
  expect(everything(seen)).not.toContain(SECRET)
  expect(everything(seen)).not.toContain(PIN)
  await ask($, ref)
  expect(JSON.stringify(seen.cards.at(-1))).toContain(QUESTION) // the card, in place of the model's call
  const post = await answer($, seen, 'Copy')
  expect(seen.clip.length).toBe(1)
  expect(seen.clip[0]?.stdin).toBe(lineOf(ref))
  expect(seen.clip[0]?.stdin).not.toContain(PIN)
  expect(JSON.stringify(seen.clip[0]?.argv)).not.toContain(SECRET)
  expect(seen.clip[0]?.argv.slice(2)).toEqual(['pbcopy'])
  expect(seen.logs).toContain('copied')
  expect((post.additionalContext ?? []).join('\n')).toContain('Reply with nothing.')
  expect(JSON.stringify(post)).not.toContain(SECRET)
  expect(seen.prompts.length).toBe(1)
  // Copy once: the session's next invite is copied with no card and no turn
  await typed($, 'invite'); await seen.tick()
  await until(() => seen.clip.length === 2)
  expect(seen.clip[1]?.stdin).toBe(lineOf(ref))
  await until(() => seen.logs.includes('line copied'))
  expect(seen.prompts.length).toBe(1)
})

test('Skip once: the session\'s next invite offers no card', async ($, on) => {
  const ref = 'c0ffee000004'
  const seen = world($, on, { ref })
  await start($)
  await typed($, 'invite'); await seen.tick()
  await until(() => seen.prompts.length === 1)
  await ask($, ref)
  await answer($, seen, 'Skip')
  await typed($, 'invite'); await seen.tick(); await seen.tick()
  await new Promise(r => setTimeout(r, 200))
  expect(seen.prompts.length).toBe(1)
  expect(seen.clip).toEqual([])
})

test('Skip copies nothing; with no clipboard tool the card says so', async ($, on) => {
  const ref = 'c0ffee000002'
  const seen = world($, on, { ref, clip: [] })
  await start($)
  await typed($, 'invite'); await seen.tick()
  await until(() => seen.prompts.length === 1)
  await ask($, ref)
  await answer($, seen, 'Skip')
  expect(seen.clip).toEqual([])
  expect(seen.logs).toContain('not copied')
  await ask($, ref)
  await answer($, seen, 'Copy')
  expect(seen.clip.length).toBeGreaterThan(0)
  expect(seen.logs).toContain('No clipboard tool found; the line is pinned on your status line.')
})

test('an invite cancelled before the answer: a card already shown copies nothing, and a new one is refused', async ($, on) => {
  const ref = 'c0ffee000003'
  const seen = world($, on, { ref })
  await start($)
  await typed($, 'invite'); await seen.tick()
  await until(() => seen.prompts.length === 1)
  await ask($, ref)
  await typed($, `invite --cancel ${ref}`)
  await answer($, seen, 'Copy')
  expect(seen.clip).toEqual([])
  expect(seen.logs).toContain('that invite is gone, run /sub-human invite again')
  const calls = seen.cards.length
  const r = await ask($, ref)
  expect(JSON.stringify(r)).toContain('that invite is gone, run /sub-human invite again')
  expect(seen.cards.length).toBe(calls) // denied: no card shown
})

test('no card with --no-card (no line handed over)', async ($, on) => {
  const seen = world($, on, { ref: 'c0ffee000004', noCard: true })
  await start($)
  await typed($, 'invite --no-card'); await seen.tick()
  await new Promise(r => setTimeout(r, 400))
  expect(seen.prompts).toEqual([])
  const r = await ask($, 'c0ffee000004')
  expect(JSON.stringify(r)).toContain('that invite is gone')
})

test('no card in a session nobody types in (-p, the SDK)', async ($, on) => {
  const seen = world($, on, { ref: 'c0ffee000005' })
  await start($, false)
  await typed($, 'invite'); await seen.tick()
  await new Promise(r => setTimeout(r, 400))
  expect(seen.prompts).toEqual([])
})

test('noise pass H: an invite that lapses unused tells its maker in one line', async ($, on) => {
  const ref = 'c0ffee000005'
  const seen = world($, on, { ref, noCard: true })
  await start($)
  await typed($, 'invite')
  await seen.advance(900_000)
  await until(() => seen.logs.includes('invite expired; /sub-human invite for a new one'))
  expect(seen.logs.filter(l => l.startsWith('invite expired')).length).toBe(1)
})
