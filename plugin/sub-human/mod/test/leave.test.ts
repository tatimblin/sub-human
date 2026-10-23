// Wiring: the card after a leave (docs/next/PLAN-LEAVE-CARD.md; mod/deliver.ts command.run, mod/consent.ts
// AskUserQuestion). Run with `npm run test:mods`. The card's rules are tested in node (test/mod-core-leave.node-test.ts).
// This checks the hooks: a typed /sub-human leave that went through submits one wake naming the room's code; the
// model's "left room CODE" call is shown as the card; Star runs scripts/star.sh, and without gh opens the repo page
// (scripts/open.sh, the URL on stdin), else shows its URL; Write feedback opens the filled-in issue form with nothing of
// the room in it; Close runs nothing. No card for a refused leave, a session nobody types in, a second leave, a
// session seated again before it fires, or SUB_HUMAN_LEAVE_CARD=0.
import type { EventOf, On } from 'claude-code'
import { test, expect, mock, type Engine } from 'claude-code/testing'
import { CODE, OUT, helloOf, ran, scriptOf, session, start, stdinOf } from './support.ts'

const SID = 'sid-leave'
const QUESTION = `You left room ${CODE}. Thanks for trying sub-human!`

/** Resolves once cond() holds (the wake goes out after the command returned), or rejects after ms. */
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

type Seen = {
  prompts: string[]; logs: string[]; runs: { argv: readonly string[]; stdin: string | undefined }[]; ids: string[]
  cards: EventOf['tool.call'][]; tick: () => Promise<unknown>
}
/**
 * The engine beneath: mod-hello (seated until the leave; stillSeated: seated after it too), join.ts answering a leave
 * (refused: as a session with no seat), star.sh exiting star, open.sh exiting the codes in opens (then 127), and env
 * (leaveCard: SUB_HUMAN_LEAVE_CARD).
 */
function world(engine: Engine, on: On, { refused = false, stillSeated = false, star = 0, opens = [0], leaveCard }: { refused?: boolean; stillSeated?: boolean; star?: number; opens?: number[]; leaveCard?: string } = {}) {
  const seen: Seen = { prompts: [], logs: [], runs: [], ids: [], cards: [], tick: async () => {} }
  const clock = mock.clock(on, { now: 1_000_000 })
  seen.tick = () => clock.advance(1000)
  let seated = true
  let opened = 0
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('session.version', () => ({ value: { version: '2.1.296' } }))
  on('fs.read', (_$, e) => { if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"version":"9.9.9"}' }; throw new Error('ENOENT') })
  on('env.get', (_$, e) => ({ value: e.name === 'SUB_HUMAN_LEAVE_CARD' ? leaveCard : undefined }))
  on('ui.log', (_$, e) => { seen.logs.push(e.text); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('command.run', (_$, e) => ({ text: `Session renamed to: ${e.args}` }))
  on('process.run', (_$, e) => {
    const sh = e.argv[0] === 'sh' ? String(e.argv[1]) : ''
    if (sh.endsWith('/scripts/star.sh')) { seen.runs.push({ argv: e.argv, stdin: e.init?.stdin }); return ran('', star) }
    if (sh.endsWith('/scripts/open.sh')) { seen.runs.push({ argv: e.argv, stdin: e.init?.stdin }); return ran('', opens[opened++] ?? 127) }
    const script = scriptOf(e)
    if (script === 'mod-hello.ts') return ran(JSON.stringify(seated ? OUT : helloOf(null)))
    if (script === 'join.ts') {
      const args = String(stdinOf(e).command_args)
      if (args === 'leave') {
        if (refused) return ran(JSON.stringify({ subHuman: { say: 'this session is not in a room; /sub-human joins one.', refused: true, shareable: true } }))
        seated = stillSeated
        return ran(JSON.stringify({ subHuman: { say: `left ${CODE} · /sub-human joins again`, refused: false, shareable: true } }))
      }
    }
    return ran(JSON.stringify({ subHuman: { reviewOpen: false } }))
  })
  on('prompt.submit', async (_$, e) => {
    seen.prompts.push(e.text)
    await engine.classic.UserPromptSubmit({ prompt: e.text, session_id: SID, permission_mode: 'default' })
    return { text: e.text }
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PreToolUse', (_$, e) => { seen.ids.push(String(e.tool_use_id)); return {} })
  on('classic.PostToolUse', () => ({}))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', (_$, e) => { seen.cards.push(e); return { result: 'ok', text: 'ok' } })
  return seen
}
const typed = ($: Engine, args: string) => $.command.run({ command: 'sub-human:sub-human', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 400 } })
/** The model's call for the card: "left room CODE", as the wake asks. */
const ask = ($: Engine, code = CODE) => $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: `left room ${code}`, header: 'Left room', multiSelect: false, options: [{ label: 'Close', description: '' }, { label: 'Star', description: '' }] }] })
/** The card's Post, answered with label on the card the tool showed (the Pre's updatedInput), by the call's id. */
function answer($: Engine, seen: Seen, label: string) {
  const call = seen.cards.at(-1)
  const questions = call && call.tool === 'AskUserQuestion' ? call.questions : []
  return $.classic.PostToolUse({
    session_id: SID, tool_name: 'AskUserQuestion', tool_use_id: seen.ids.at(-1) ?? '', tool_input: { questions },
    tool_response: { questions, answers: { [QUESTION]: label } },
  })
}
/** A leave typed, and the wake it submits. */
async function leave($: Engine, seen: Seen) {
  await start($)
  await typed($, 'leave'); await seen.tick()
  await until(() => seen.prompts.length === 1)
}

test('a leave: one framed wake naming the code; the card on "left room CODE"; Close runs nothing', async ($, on) => {
  const seen = world($, on)
  await leave($, seen)
  expect(seen.prompts[0]).toBe(`(for Claude) sub-human: the person left room ${CODE}. Call AskUserQuestion with the question "left room ${CODE}" (the hooks show their card and act on the answer), then reply with nothing.`)
  await ask($)
  const shown = JSON.stringify(seen.cards.at(-1))
  expect(shown).toContain(QUESTION)
  for (const label of ['Close', 'Star on GitHub', 'Write feedback']) expect(shown).toContain(label)
  const post = await answer($, seen, 'Close')
  expect(seen.runs).toEqual([])
  expect((post.additionalContext ?? []).join('\n')).toContain('Reply with nothing.')
  // answered: the card is not shown again
  const r = await ask($)
  expect(JSON.stringify(r)).toContain('no room was just left here')
})

test('Star with gh logged in: star.sh alone, "starred"', async ($, on) => {
  const seen = world($, on, { star: 0 })
  await leave($, seen)
  await ask($)
  await answer($, seen, 'Star on GitHub')
  expect(seen.runs.map(r => r.argv.slice(1).join(' '))).toEqual([expect.stringMatching(/\/scripts\/star\.sh$/)])
  expect(seen.logs).toContain('★ starred tatimblin/sub-human, thank you')
})

test('Star without gh: the repo page opened, the URL on stdin; with no opener, the URL shown', async ($, on) => {
  const seen = world($, on, { star: 127, opens: [0] })
  await leave($, seen)
  await ask($)
  await answer($, seen, 'Star on GitHub')
  expect(seen.runs[1]?.argv.slice(2)).toEqual(['open'])
  expect(seen.runs[1]?.stdin).toBe('https://github.com/tatimblin/sub-human')
  expect(seen.logs).toContain('opened https://github.com/tatimblin/sub-human: the Star button is at the top right')
})

test('Star on a headless box: no gh, no opener: the URL in a notice', async ($, on) => {
  const seen = world($, on, { star: 127, opens: [] })
  await leave($, seen)
  await ask($)
  await answer($, seen, 'Star on GitHub')
  expect(seen.logs).toContain('star sub-human at https://github.com/tatimblin/sub-human')
})

test('Write feedback, or text typed on the card: the issue form filled in with the text and versions, never the room', async ($, on) => {
  const seen = world($, on, { opens: [127] })
  await leave($, seen)
  await ask($)
  await answer($, seen, 'the rows flicker')
  const url = new URL(String(seen.runs[0]?.stdin))
  expect(url.pathname).toBe('/tatimblin/sub-human/issues/new')
  expect(url.searchParams.get('feedback')).toBe('the rows flicker')
  expect(url.searchParams.get('versions')).toBe('sub-human 9.9.9 · Claude Code 2.1.296')
  expect(String(seen.runs[0]?.stdin)).not.toContain(CODE)
  expect(String(seen.runs[0]?.stdin)).not.toContain('alice')
  // open.sh found no opener: the notice carries the URL, and says nothing is sent
  expect(seen.logs.some(l => l.startsWith('write your feedback here (nothing is sent until you press Submit): https://github.com/tatimblin/sub-human/issues/new?'))).toBe(true)
})

test('no card for a refused leave',async ($, on) => {
  const a = world($, on, { refused: true })
  await start($)
  await typed($, 'leave'); await a.tick(); await a.tick()
  await new Promise(r => setTimeout(r, 300))
  expect(a.prompts).toEqual([])
})

test('no card in a session nobody types in (-p, the SDK)', async ($, on) => {
  const seen = world($, on)
  await start($, false)
  await typed($, 'leave'); await seen.tick(); await seen.tick()
  await new Promise(r => setTimeout(r, 300))
  expect(seen.prompts).toEqual([])
})

test('no card with SUB_HUMAN_LEAVE_CARD=0', async ($, on) => {
  const seen = world($, on, { leaveCard: '0' })
  await start($)
  await typed($, 'leave'); await seen.tick(); await seen.tick()
  await new Promise(r => setTimeout(r, 300))
  expect(seen.prompts).toEqual([])
})

test('no card when the session is seated again before it fires', async ($, on) => {
  const seen = world($, on, { stillSeated: true })
  await start($)
  await typed($, 'leave'); await seen.tick(); await seen.tick()
  await new Promise(r => setTimeout(r, 300))
  expect(seen.prompts).toEqual([])
})

test('another card whose answer mentions "left room CODE" goes on to consent as before; the leave keeps its card', async ($, on) => {
  const seen = world($, on)
  await leave($, seen)
  const questions = [{ question: 'Agree to plan v2?', header: 'Plan', multiSelect: false, options: [{ label: 'Yes', description: '' }] }]
  const post = await $.classic.PostToolUse({
    session_id: SID, tool_name: 'AskUserQuestion', tool_use_id: 'other', tool_input: { questions },
    tool_response: { questions, answers: { 'Agree to plan v2?': `carol left room ${CODE}, wait for her` } },
  })
  expect(JSON.stringify(post)).not.toContain('leave card')
  expect(seen.runs).toEqual([])
  await ask($)
  expect(JSON.stringify(seen.cards.at(-1))).toContain(QUESTION)
})

test('once per session: a second leave makes no second card', async ($, on) => {
  const seen = world($, on)
  await leave($, seen)
  await ask($)
  await answer($, seen, 'Close')
  await typed($, 'leave'); await seen.tick(); await seen.tick()
  await new Promise(r => setTimeout(r, 300))
  expect(seen.prompts.length).toBe(1)
})
