// Wiring: the card after a leave (docs/next/quiet/COPY.md §6; mod/deliver.ts command.run, offerLeave). Run with
// `npm run test:mods`. The card's rules are tested in node (test/mod-core-leave.node-test.ts). This checks the hooks:
// a typed /sub-human leave that went through opens the card itself ($.ui.ask: an AskUserQuestion call, no model turn)
// with "Left CODE.", Done / ★ Star sub-human and no descriptions, in place of the "Left CODE" notice; Star runs
// scripts/star.sh, and without gh opens the repo page (scripts/open.sh, the URL on stdin), else shows its URL; text
// typed opens the filled-in issue form, with sub-human's own lines of the session masked and nothing of the room; Done
// runs nothing. At most two cards per install ($.store), never once starred or once gh says it is starred already. No
// card (the notice instead) for a refused leave, a session nobody types in, a second leave, a session seated again
// before it fires, or SUB_HUMAN_LEAVE_CARD=0. No /rename: the title changes at the next prompt (sessionTitle).
import type { EventOf, On } from 'claude-code'
import { test, expect, mock, type Engine } from 'claude-code/testing'
import { debugLines, CODE, OUT, helloOf, ran, scriptOf, session, start, stdinOf } from './support.ts'

const SID = 'sid-leave'
const QUESTION = `Left ${CODE}.`

/** Resolves once cond() holds, or rejects after ms. */
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

type Seen = { prompts: string[]; logs: string[]; runs: { argv: readonly string[]; stdin: string | undefined }[]; checks: number; commands: string[]; store: Map<string, unknown>; cards: EventOf['tool.call'][]; tick: () => Promise<unknown> }
/**
 * The engine beneath: mod-hello (seated until the leave; stillSeated: seated after it too), join.ts answering a leave
 * (refused: as a session with no seat) and `who`, star.sh exiting star, open.sh exiting the codes in opens (then 127),
 * env (leaveCard: SUB_HUMAN_LEAVE_CARD), and the dialog answered with answer.
 */
function world(on: On,{ refused = false, stillSeated = false, star = 0, starredAlready = false, stored, opens = [0], leaveCard, answer = 'Done' }: { refused?: boolean; stillSeated?: boolean; star?: number; starredAlready?: boolean; stored?: unknown; opens?: number[]; leaveCard?: string; answer?: string } = {}) {
  const seen: Seen = { prompts: [], logs: [], runs: [], checks: 0, commands: [], store: new Map(stored === undefined ? [] : [['leaveCard', stored]]), cards: [], tick: async () => {} }
  // the plugin's store (per install), as the engine keeps it: what was set reads back
  on('store.get', (_$, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', (_$, e) => { seen.store.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } })
  const clock = mock.clock(on, { now: 1_000_000 })
  seen.tick = () => clock.advance(1000)
  let seated = true
  let opened = 0
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('session.version', () => ({ value: { version: '2.1.296' } }))
  on('fs.read', (_$, e) => { if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"version":"9.9.9"}' }; throw new Error('ENOENT') })
  on('env.get', (_$, e) => ({ value: e.name === 'SUB_HUMAN_LEAVE_CARD' ? leaveCard : undefined }))
  on('ui.log', (_$, e) => { if (e.to === 'debug') debugLines.push(e.text); else seen.logs.push(e.text); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('command.run', (_$, e) => { seen.commands.push(e.command); return { text: `Session renamed to: ${e.args}` } })
  on('process.run', (_$, e) => {
    const sh = e.argv[0] === 'sh' ? String(e.argv[1]) : ''
    // gh's "starred already?" before the card: counted apart
    if (sh.endsWith('/scripts/star.sh') && e.argv[2] === 'check') { seen.checks++; return ran('', starredAlready ? 0 : 1) }
    if (sh.endsWith('/scripts/star.sh')) { seen.runs.push({ argv: e.argv, stdin: e.init?.stdin }); return ran('', star) }
    if (sh.endsWith('/scripts/open.sh')) { seen.runs.push({ argv: e.argv, stdin: e.init?.stdin }); return ran('', opens[opened++] ?? 127) }
    const script = scriptOf(e)
    if (script === 'mod-hello.ts') return ran(JSON.stringify(seated ? OUT : helloOf(null)))
    if (script === 'join.ts') {
      const args = String(stdinOf(e).command_args)
      if (args === 'who') return ran(JSON.stringify({ subHuman: { say: `alice is in room ${CODE}`, refused: false, shareable: true } }))
      if (args === 'kick bob') return ran(JSON.stringify({ subHuman: { say: `alice: room ${CODE}: link 4821 down, secret ${'K'.repeat(39)}`, refused: true, shareable: true } }))
      if (args === 'leave') {
        if (refused) return ran(JSON.stringify({ subHuman: { say: 'this session is not in a room; /sub-human joins one.', refused: true, shareable: true } }))
        seated = stillSeated
        return ran(JSON.stringify({ subHuman: { say: `Left ${CODE}`, refused: false, shareable: true } }))
      }
    }
    return ran(JSON.stringify({ subHuman: { reviewOpen: false } }))
  })
  on('prompt.submit', (_$, e) => { seen.prompts.push(e.text); return { text: e.text } })
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('tool.check', () => ({ decision: 'allow' }))
  // the dialog: the person's answer, as AskUserQuestion's result carries it
  on('tool.call', (_$, e) => {
    seen.cards.push(e)
    const q = e.tool === 'AskUserQuestion' ? String(e.questions[0]?.question) : ''
    return { result: { questions: e.tool === 'AskUserQuestion' ? e.questions : [], answers: { [q]: answer } }, text: `"${q}"="${answer}"` }
  })
  return seen
}
const typed = ($: Engine, args: string) => $.command.run({ command: 'sub-human:sub-human', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 400 } })
/** A leave typed, and the card it opens. */
async function leave($: Engine, seen: Seen) {
  await start($)
  await typed($, 'leave'); await seen.tick()
  await until(() => seen.cards.length === 1)
}
const shownQuestion = (seen: Seen) => { const c = seen.cards.at(-1); return c && c.tool === 'AskUserQuestion' ? c.questions[0] : undefined }

test('a leave opens the card itself in place of the "Left CODE" notice: no model turn, Done / ★ Star sub-human, labels alone; Done runs nothing', async ($, on) => {
  const seen = world(on, { answer: 'Done' })
  await leave($, seen)
  const q = shownQuestion(seen)
  expect(q?.question).toBe(QUESTION)
  expect(q?.header).toBe('sub-human')
  expect(q?.options.map(o => o.label)).toEqual(['Done', '★ Star sub-human'])
  expect(q?.options.every(o => !o.description)).toBe(true)
  await new Promise(r => setTimeout(r, 100))
  expect(seen.prompts).toEqual([])
  expect(seen.runs).toEqual([])
  expect(seen.logs).not.toContain(`Left ${CODE}`) // one event, one surface: the card is the leave's line
  expect(seen.store.get('leaveCard')).toEqual({ shown: 1, starred: false })
  expect(seen.commands).not.toContain('rename') // the title changes at the next prompt (sessionTitle), silently
})

test('Star with gh logged in: star.sh alone, "Starred sub-human. Thanks!"; never again', async ($, on) => {
  const seen = world(on, { answer: '★ Star sub-human', star: 0 })
  await leave($, seen)
  await until(() => seen.logs.includes('Starred sub-human. Thanks!'))
  expect(seen.runs.map(r => r.argv.slice(1).join(' '))).toEqual([expect.stringMatching(/\/scripts\/star\.sh$/)])
  expect(seen.store.get('leaveCard')).toEqual({ shown: 1, starred: true })
})

test('Star without gh: the repo page opened, the URL on stdin (counted as starred)', async ($, on) => {
  const seen = world(on, { answer: '★ Star sub-human', star: 127, opens: [0] })
  await leave($, seen)
  await until(() => seen.logs.includes('Opened sub-human on GitHub'))
  expect(seen.runs[1]?.argv.slice(2)).toEqual(['open'])
  expect(seen.runs[1]?.stdin).toBe('https://github.com/tatimblin/sub-human')
  expect(seen.store.get('leaveCard')).toEqual({ shown: 1, starred: true })
})

test('Star on a headless box: no gh, no opener: the URL in a notice', async ($, on) => {
  const seen = world(on, { answer: '★ Star sub-human', star: 127, opens: [] })
  await leave($, seen)
  await until(() => seen.logs.includes('Star sub-human at github.com/tatimblin/sub-human'))
})

test('two cards per install: with two shown already, no card, the "Left CODE" notice instead', async ($, on) => {
  const seen = world(on, { stored: { shown: 2, starred: false } })
  await start($)
  await typed($, 'leave'); await seen.tick(); await seen.tick()
  await new Promise(r => setTimeout(r, 300))
  expect(seen.cards).toEqual([])
  expect(seen.logs).toContain(`Left ${CODE}`)
})

test('starred already (gh says so): no card, the notice, and never asked again', async ($, on) => {
  const seen = world(on, { starredAlready: true })
  await start($)
  await typed($, 'leave'); await seen.tick(); await seen.tick()
  await until(() => seen.logs.includes(`Left ${CODE}`))
  expect(seen.cards).toEqual([])
  expect(seen.checks).toBe(1)
  expect(seen.store.get('leaveCard')).toEqual({ shown: 0, starred: true })
})

test('text typed: the issue form with the text, the versions; no session snippet when nothing went wrong', async ($, on) => {
  const seen = world(on, { answer: 'the rows flicker', opens: [127] })
  await start($)
  await typed($, 'who')
  await typed($, 'leave'); await seen.tick()
  await until(() => seen.runs.length === 1)
  const url = new URL(String(seen.runs[0]?.stdin))
  expect(url.pathname).toBe('/tatimblin/sub-human/issues/new')
  expect(url.searchParams.get('feedback')).toBe('the rows flicker')
  expect(url.searchParams.get('versions')).toBe('sub-human 9.9.9 · Claude Code 2.1.296')
  expect(url.searchParams.get('session')).toBe(null)
})

test('after a refusal: the snippet has the commands and the refusal, masked (name, room, secret, number); no reply that worked', async ($, on) => {
  const seen = world(on, { answer: 'kick broke', opens: [127] })
  await start($)
  await typed($, 'who')
  await typed($, 'kick bob')
  await typed($, 'leave'); await seen.tick()
  await until(() => seen.runs.length === 1)
  const sent = String(seen.runs[0]?.stdin)
  const snippet = String(new URL(sent).searchParams.get('session'))
  expect(snippet).toBe('> /sub-human who\n> /sub-human kick\n✗ NAME: room ROOM: link NNNN down, secret SECRET\n> /sub-human leave')
  for (const leak of [CODE, 'K'.repeat(39), '4821', 'alice', 'bob']) expect(sent).not.toContain(leak)
  await until(() => seen.logs.some(l => l.startsWith('Your feedback, ready to send: https://github.com/tatimblin/sub-human/issues/new?')))
})

test('no card for a refused leave', async ($, on) => {
  const seen = world(on, { refused: true })
  await start($)
  await typed($, 'leave'); await seen.tick(); await seen.tick()
  await new Promise(r => setTimeout(r, 300))
  expect(seen.cards).toEqual([])
})

test('no card in a session nobody types in (-p, the SDK)', async ($, on) => {
  const seen = world(on)
  await start($, false)
  await typed($, 'leave'); await seen.tick(); await seen.tick()
  await new Promise(r => setTimeout(r, 300))
  expect(seen.cards).toEqual([])
})

test('no card with SUB_HUMAN_LEAVE_CARD=0: the "Left CODE" notice is the whole leave', async ($, on) => {
  const seen = world(on, { leaveCard: '0' })
  await start($)
  await typed($, 'leave'); await seen.tick(); await seen.tick()
  await new Promise(r => setTimeout(r, 300))
  expect(seen.cards).toEqual([])
  expect(seen.logs).toContain(`Left ${CODE}`)
})

test('no card when the session is seated again before it fires (the notice instead)', async ($, on) => {
  const seen = world(on, { stillSeated: true })
  await start($)
  await typed($, 'leave'); await seen.tick(); await seen.tick()
  await new Promise(r => setTimeout(r, 300))
  expect(seen.cards).toEqual([])
  expect(seen.logs).toContain(`Left ${CODE}`)
})

test('once per session: a second leave opens no second card', async ($, on) => {
  const seen = world(on)
  await leave($, seen)
  await typed($, 'leave'); await seen.tick(); await seen.tick()
  await new Promise(r => setTimeout(r, 300))
  expect(seen.cards.length).toBe(1)
})
