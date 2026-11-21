// Wiring: the invite's copy question (PLAN-JOIN step 5; 0.6.1: no model turn; mod/deliver.ts command.run, offerCopy).
// Run with `npm run test:mods`. The question's rules are tested in node (test/mod-core-copy.node-test.ts). This checks
// the hooks: a typed /sub-human invite whose reply carries the line opens the module's own dialog ($.ui.ask: an
// AskUserQuestion call, no prompt submitted, no wake), "Copy the invite?", Copy / Skip and no descriptions, which
// consent's hooks pass by (no node consent for it; nothing answered allow); Copy runs a clipboard tool with the line on
// stdin (a stub here: nothing writes a real clipboard), Skip runs none and asks no more, a dismissed dialog copies
// nothing and the next invite asks again, an invite gone before the answer copies nothing and says so, and with no line
// (--no-card) or no person at the prompt there is no question at all. Never the line, its SECRET or the PIN anywhere
// the model or the transcript reads.
import type { EventOf, On } from 'claude-code'
import { test, expect, mock, type Engine } from 'claude-code/testing'
import { debugLines, OUT, ran, scriptOf, session, start, stdinOf } from './support.ts'

const SID = 'sid-copy'
const SECRET = 'K'.repeat(38)
const PIN = '7093'
const lineOf = (ref: string) => `/sub-human join https://box.tail1a2b.ts.net/sub-human/otter-4821#${SECRET}${ref.slice(-1)}`
const QUESTION = 'Copy the invite?'
/** What Copy puts on the clipboard: the install line for someone with no sub-human yet, then the line (0.6.1) */
const INSTALL = 'No sub-human yet? In a terminal: claude plugin marketplace add tatimblin/sub-human && claude plugin install sub-human@sub-human, then restart Claude Code'
const copiedOf = (ref: string) => `${INSTALL}\n${lineOf(ref)}`

/** Resolves once cond() holds (the dialog opens after the command returned), or rejects after ms. */
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

type Seen = {
  prompts: string[]; logs: string[]; appends: string[]; scripts: string[]; beneath: string[]
  clip: { argv: readonly string[]; stdin: string | undefined }[]; cards: EventOf['tool.call'][]; tick: () => Promise<unknown>
  advance: (ms: number) => Promise<unknown>; answers: (string | null)[]; gate: Promise<void> | null
}
/** The engine beneath: mod-hello, join.ts answering an invite (with the line unless noCard) or a cancel, clipboard
 * tools answering `clip` (exit codes in order; then 127), the dialog answered from `answers` in order (null: dismissed;
 * past the end: Copy), held while `gate` is set. */
function world(on: On, { ref, noCard = false, clip = [0], answers = [] }: { ref: string; noCard?: boolean; clip?: number[]; answers?: (string | null)[] }) {
  const seen: Seen = { prompts: [], logs: [], appends: [], scripts: [], beneath: [], clip: [], cards: [], tick: async () => {}, advance: async () => {}, answers, gate: null }
  const clock = mock.clock(on, { now: 1_000_000 })
  seen.tick = () => clock.advance(1000)
  seen.advance = (ms: number) => clock.advance(ms)
  const line = lineOf(ref)
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('env.get', () => ({ value: undefined })) // no SUB_HUMAN_ROOM, no display: pbcopy is the only clipboard tool tried
  on('ui.log', (_$, e) => { if (e.to === 'debug') debugLines.push(e.text); else seen.logs.push(e.text); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'sh' && String(e.argv[1]).endsWith('/scripts/clip.sh')) {
      seen.clip.push({ argv: e.argv, stdin: e.init?.stdin })
      return ran('', clip[seen.clip.length - 1] ?? 127)
    }
    const script = scriptOf(e)
    seen.scripts.push(script)
    if (script === 'mod-hello.ts') return ran(JSON.stringify(OUT))
    if (script === 'join.ts') {
      const args = String(stdinOf(e).command_args)
      if (args.startsWith('invite --cancel')) return ran(JSON.stringify({ subHuman: { say: `cancelled the invite (${ref})`, refused: false, shareable: true } }))
      const pinned = { status: `PIN ${PIN} · ${line}`, ms: 900000, ref, ...(noCard ? {} : { line }) }
      return ran(JSON.stringify({ subHuman: { say: 'invite to room otter-4821 for one machine … pinned under the prompt', refused: false, shareable: false, pinned } }))
    }
    return ran(JSON.stringify({ subHuman: { reviewOpen: false } }))
  })
  on('prompt.submit', (_$, e) => { seen.prompts.push(e.text); return { text: e.text } })
  on('session.append', async (_$, e, next) => { seen.appends.push(e.message.content.map(b => b.text).join('')); return next(e) })
  on('classic.UserPromptSubmit', () => ({}))
  // beneath the module: what reached the hooks under it (a pass-by goes on to them; an answer of the module's would not)
  on('classic.PreToolUse', (_$, e) => { seen.beneath.push(`pre:${e.tool}`); return {} })
  on('classic.PostToolUse', (_$, e) => { seen.beneath.push(`post:${e.tool_name}`); return {} })
  on('tool.check', () => ({ decision: 'allow' }))
  // the dialog: the person's answer, as AskUserQuestion's result carries it; a dismissal is a deny
  on('tool.call', async (_$, e) => {
    seen.cards.push(e)
    if (seen.gate) await seen.gate
    const answer = seen.answers.length ? seen.answers.shift() ?? null : 'Copy (join + install line)'
    if (answer === null) return { deny: 'The user doesn\'t want to proceed with this tool use.' }
    const q = e.tool === 'AskUserQuestion' ? String(e.questions[0]?.question) : ''
    return { result: { questions: e.tool === 'AskUserQuestion' ? e.questions : [], answers: { [q]: answer } }, text: `"${q}"="${answer}"` }
  })
  return seen
}
const typed = ($: Engine, args: string) => $.command.run({ command: 'sub-human:sub-human', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 400 } })
const shown = (seen: Seen) => { const c = seen.cards.at(-1); return c && c.tool === 'AskUserQuestion' ? c.questions[0] : undefined }
const everything = (seen: Seen) => JSON.stringify([seen.prompts, seen.appends, seen.logs])

test('an invite with its line: the module asks itself (no model turn), Copy / Skip; Copy puts the line, never the PIN, on the clipboard; then later lines with no question', async ($, on) => {
  const ref = 'c0ffee000001'
  const seen = world(on, { ref, clip: [0, 0], answers: ['Copy (join + install line)'] })
  await start($)
  await typed($, 'invite'); await seen.tick()
  await until(() => seen.clip.length === 1)
  const q = shown(seen)
  expect(q?.question).toBe(QUESTION)
  expect(q?.header).toBe('Invite')
  expect(q?.options.map(o => o.label)).toEqual(['Copy (join + install line)', 'Skip'])
  expect(q?.options.every(o => !o.description)).toBe(true)
  expect(seen.prompts).toEqual([]) // no wake, no model turn
  expect(seen.appends).toEqual([])
  expect(seen.scripts).not.toContain('consent.ts') // consent's hooks passed the module's own dialog by
  expect(seen.beneath).toEqual(['pre:AskUserQuestion']) // passed on to the hooks beneath, never answered by the module
  expect(seen.clip[0]?.stdin).toBe(copiedOf(ref))
  expect(seen.clip[0]?.stdin).not.toContain(PIN)
  expect(JSON.stringify(seen.clip[0]?.argv)).not.toContain(SECRET)
  expect(seen.clip[0]?.argv.slice(2)).toEqual(['pbcopy'])
  expect(JSON.stringify(seen.cards)).not.toContain(SECRET)
  // a copy that worked is no news: the debug log's
  await until(() => debugLines.includes('copy: copied'))
  expect(seen.logs).not.toContain('copied')
  expect(everything(seen)).not.toContain(SECRET)
  expect(everything(seen)).not.toContain(PIN)
  // Copy once: the session's next invite is copied with no question
  await typed($, 'invite'); await seen.tick()
  await until(() => seen.clip.length === 2)
  expect(seen.cards.length).toBe(1)
  expect(seen.clip[1]?.stdin).toBe(copiedOf(ref))
  await until(() => debugLines.includes('copy: line copied'))
  expect(seen.logs).not.toContain('line copied')
})

test('Skip copies nothing and asks no more this session', async ($, on) => {
  const ref = 'c0ffee000004'
  const seen = world(on, { ref, answers: ['Skip'] })
  await start($)
  await typed($, 'invite'); await seen.tick()
  await until(() => seen.cards.length === 1)
  await until(() => debugLines.includes('copy: not copied'))
  await typed($, 'invite'); await seen.tick(); await seen.tick()
  await new Promise(r => setTimeout(r, 200))
  expect(seen.cards.length).toBe(1)
  expect(seen.clip).toEqual([])
})

test('dismissed (Esc): nothing copied, no line; the next invite asks again', async ($, on) => {
  const ref = 'c0ffee000006'
  const seen = world(on, { ref, answers: [null, 'Copy (join + install line)'] })
  await start($)
  await typed($, 'invite'); await seen.tick()
  await until(() => seen.cards.length === 1)
  await new Promise(r => setTimeout(r, 100))
  expect(seen.clip).toEqual([])
  expect(seen.logs.filter(l => /cop/i.test(l))).toEqual([])
  await typed($, 'invite'); await seen.tick()
  await until(() => seen.clip.length === 1)
  expect(seen.cards.length).toBe(2)
})

test('no clipboard tool: the person is told, in one line', async ($, on) => {
  const seen = world(on, { ref: 'c0ffee000002', clip: [] })
  await start($)
  await typed($, 'invite'); await seen.tick()
  await until(() => seen.logs.includes('No clipboard tool found; the line is pinned on your status line.'))
  expect(seen.clip.length).toBe(1)
})

test('an invite cancelled before the answer copies nothing and says it is gone', async ($, on) => {
  const ref = 'c0ffee000003'
  const seen = world(on, { ref })
  let open = () => {}
  seen.gate = new Promise<void>(r => { open = r })
  await start($)
  await typed($, 'invite'); await seen.tick()
  await until(() => seen.cards.length === 1)
  await typed($, `invite --cancel ${ref}`)
  open()
  await until(() => seen.logs.includes('that invite is gone, run /sub-human invite again'))
  expect(seen.clip).toEqual([])
})

test('no question with --no-card (no line handed over)', async ($, on) => {
  const seen = world(on, { ref: 'c0ffee000004', noCard: true })
  await start($)
  await typed($, 'invite --no-card'); await seen.tick()
  await new Promise(r => setTimeout(r, 400))
  expect(seen.cards).toEqual([])
  expect(seen.prompts).toEqual([])
})

test('no question in a session nobody types in (-p, the SDK)', async ($, on) => {
  const seen = world(on, { ref: 'c0ffee000005' })
  await start($, false)
  await typed($, 'invite'); await seen.tick()
  await new Promise(r => setTimeout(r, 400))
  expect(seen.cards).toEqual([])
  expect(seen.prompts).toEqual([])
})

test('noise pass H: an invite that lapses unused tells its maker in one line', async ($, on) => {
  const ref = 'c0ffee000005'
  const seen = world(on, { ref, noCard: true })
  await start($)
  await typed($, 'invite')
  await seen.advance(900_000)
  await until(() => seen.logs.includes('invite expired; /sub-human invite for a new one'))
  expect(seen.logs.filter(l => l.startsWith('invite expired')).length).toBe(1)
})
