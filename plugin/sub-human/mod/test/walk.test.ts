// Wiring: the question after a bare /sub-human opened a room (PLAN-SMOOTH 0.6.1 item 1; mod/deliver.ts command.run,
// armWalk, offerWalk, walkInvite). Run with `npm run test:mods`. The rules are tested in node
// (test/mod-core-walk.node-test.ts). This checks the hooks: a join whose reply says the room was opened runs node walk
// in the background and, once the join's own turn is over (or no turn came), opens the module's own dialog ($.ui.ask:
// no prompt submitted, no wake), "Bring someone into CODE?", the labels with the likely one marked, which consent's hooks
// pass by; dismissed does nothing; This machine is one line; SSH and Tailscale (and an address typed) run the typed
// command's own invite through the join shim, whose line and PIN go only to the status line and the copy question,
// never a notice, a prompt or an append. No question for a join of an open room, with SUB_HUMAN_WALK=0, or with no
// person at the prompt.
import type { EventOf, On } from 'claude-code'
import { test, expect, mock, type Engine } from 'claude-code/testing'
import { CODE, OUT, debugLines, ran, scriptOf, session, start, stdinOf } from './support.ts'
import { INSTALL_LINE } from '../core/copy.ts'

const SID = 'sid-walk'
const SECRET = 'K'.repeat(39)
const PIN = '7093'
const REF = 'c0ffee00aa01'
const LINE = `/sub-human join ssh://alice@box/${CODE}#${SECRET}`
const QUESTION = `Bring someone into ${CODE}?`
const BLOCK = 'SUB-HUMAN: you are alice\'s Claude in room otter-4821…'

/** Resolves once cond() holds, or rejects after ms. */
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

type Seen = {
  prompts: string[]; logs: string[]; appends: string[]; statuses: (string | undefined)[]; scripts: string[]; invites: string[]
  cards: EventOf['tool.call'][]; clip: (string | undefined)[]; answers: (string | null)[]; tick: (ms?: number) => Promise<unknown>
}
/**
 * The engine beneath: mod-hello (alice seated in CODE), join.ts answering the bare /sub-human with a seat in a room it
 * opened (opened false: one it joined) and an invite with its line and PIN, node walk answering `facts`, the clipboard
 * stub, env (walk: SUB_HUMAN_WALK), and the dialogs answered from `answers` in order (null: dismissed; past the end:
 * dismissed).
 */
function world(engine: Engine, on: On, { opened = true, facts = { tailnet: 'up', ssh: 'on', sshAddr: false }, answers = [], walk }: { opened?: boolean; facts?: object; answers?: (string | null)[]; walk?: string } = {}) {
  const seen: Seen = { prompts: [], logs: [], appends: [], statuses: [], scripts: [], invites: [], cards: [], clip: [], answers, tick: async () => {} }
  const clock = mock.clock(on, { now: 1_000_000 })
  seen.tick = (ms = 1000) => clock.advance(ms)
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('env.get', (_$, e) => ({ value: e.name === 'SUB_HUMAN_WALK' ? walk : undefined }))
  on('ui.log', (_$, e) => { if (e.to === 'debug') debugLines.push(e.text); else seen.logs.push(e.text); return { value: undefined } })
  on('ui.status', (_$, e) => { seen.statuses.push(e.text); return { value: undefined } })
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'sh' && String(e.argv[1]).endsWith('/scripts/clip.sh')) { seen.clip.push(e.init?.stdin); return ran('', 0) }
    const script = scriptOf(e)
    seen.scripts.push(script)
    if (script === 'mod-hello.ts') return ran(JSON.stringify(OUT))
    if (script === 'walk.ts') return ran(JSON.stringify({ subHuman: { walk: facts } }))
    if (script === 'join.ts') {
      const args = String(stdinOf(e).command_args)
      if (args.startsWith('invite')) {
        seen.invites.push(args)
        const pinned = { status: `PIN ${PIN} · ${LINE}`, ms: 900000, ref: REF, line: LINE }
        return ran(JSON.stringify({ subHuman: { say: 'invite to room otter-4821 for one machine, pinned under the prompt', refused: false, shareable: false, pinned } }))
      }
      return ran(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: BLOCK }, subHuman: { say: opened ? `Opened ${CODE}` : `Joined ${CODE} with bob`, joined: true, shareable: true, ...(opened ? { opened: true } : {}) } }))
    }
    return ran(JSON.stringify({ subHuman: { reviewOpen: false } }))
  })
  on('prompt.submit', (_$, e) => { seen.prompts.push(e.text); return { text: e.text } })
  on('session.append', async (_$, e, next) => { seen.appends.push(e.message.content.map(b => b.text).join('')); return next(e) })
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.UserPromptExpansion', () => ({ additionalContext: ['from the classic join hook'] }))
  on('command.run', async (_$, e) => {
    const r = await engine.classic.UserPromptExpansion({ expansion_type: 'slash_command', command_name: 'sub-human:sub-human', command_args: e.args, prompt: `/sub-human ${e.args}`.trim(), session_id: SID })
    return r.additionalContext ? { context: r.additionalContext } : {}
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.PreToolUse', () => ({}))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', (_$, e) => {
    seen.cards.push(e)
    const answer = seen.answers.shift() ?? null
    if (answer === null) return { deny: 'The user doesn\'t want to proceed with this tool use.' }
    const q = e.tool === 'AskUserQuestion' ? String(e.questions[0]?.question) : ''
    return { result: { questions: e.tool === 'AskUserQuestion' ? e.questions : [], answers: { [q]: answer } }, text: `"${q}"="${answer}"` }
  })
  return seen
}
const typed = ($: Engine, args: string) => $.command.run({ command: 'sub-human:sub-human', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 400 } })
/** The bare /sub-human, then the join's own turn, start to end. */
async function open($: Engine, seen: Seen) {
  await start($)
  await typed($, '')
  await $.turn.start({ text: '/sub-human', turnId: 't-join' })
  await seen.tick()
  expect(seen.cards).toEqual([]) // never while the join's turn runs
  await $.turn.complete({ turnId: 't-join', answer: '', durationMs: 0, isAborted: false, reason: 'answer' })
  await seen.tick()
}
const shown = (seen: Seen, i = 0) => { const c = seen.cards[i]; return c && c.tool === 'AskUserQuestion' ? c.questions[0] : undefined }
/** What the model or the transcript could read: prompts, appends, notices. */
const readable = (seen: Seen) => JSON.stringify([seen.prompts, seen.appends, seen.logs])

test('a room opened: once the join\'s turn is over, the module asks itself (no model turn): the question, the labels, the likely one marked; consent passes it by', async ($, on) => {
  const seen = world($, on, { answers: [null] })
  await open($, seen)
  await until(() => seen.cards.length === 1)
  const q = shown(seen)
  expect(q?.question).toBe(QUESTION)
  expect(q?.header).toBe('Invite')
  expect(q?.options.map(o => o.label)).toEqual(['This machine', 'SSH', 'Tailscale (detected)'])
  expect(q?.options.every(o => !o.description)).toBe(true)
  expect(seen.scripts).toContain('walk.ts')
  expect(seen.scripts).not.toContain('consent.ts')
  expect(seen.prompts).toEqual([])
  // dismissed (Esc): not now; nothing runs, no line
  await new Promise(r => setTimeout(r, 100))
  expect(seen.invites).toEqual([])
  expect(seen.logs).toEqual([`Opened ${CODE}`])
})

test('no tailscale CLI: Tailscale is not offered; Remote Login on marks SSH', async ($, on) => {
  const seen = world($, on, { facts: { tailnet: 'none', ssh: 'on', sshAddr: false } })
  await open($, seen)
  await until(() => seen.cards.length === 1)
  expect(shown(seen)?.options.map(o => o.label)).toEqual(['This machine', 'SSH (detected)'])
})

test('This machine: one line, nothing run', async ($, on) => {
  const seen = world($, on, { answers: ['This machine'] })
  await open($, seen)
  await until(() => seen.logs.includes('In another session here, type /sub-human'))
  expect(seen.invites).toEqual([])
  expect(seen.prompts).toEqual([])
})

test('SSH: the typed command\'s invite through the join shim; its line and PIN only on the status line, then the copy question; never a notice, prompt or append', async ($, on) => {
  const seen = world($, on, { answers: ['SSH', 'Copy (join + install line)'] })
  await open($, seen)
  await until(() => seen.invites.length === 1)
  expect(seen.invites).toEqual(['invite --ssh'])
  await until(() => seen.statuses.includes(`PIN ${PIN} · ${LINE}`))
  await seen.tick()
  await until(() => seen.cards.length === 2)
  expect(shown(seen, 1)?.question).toBe('Copy the invite?')
  await until(() => seen.clip.length === 1)
  expect(seen.clip[0]).toBe(`${INSTALL_LINE}\n${LINE}`)
  expect(seen.logs).toContain('invite to room otter-4821 for one machine, pinned under the prompt')
  expect(readable(seen)).not.toContain(SECRET)
  expect(readable(seen)).not.toContain(PIN)
  expect(seen.prompts).toEqual([])
})

test('Tailscale: invite --web', async ($, on) => {
  const seen = world($, on, { answers: ['Tailscale (detected)', null] })
  await open($, seen)
  await until(() => seen.invites.length === 1)
  expect(seen.invites).toEqual(['invite --web'])
})

test('an address typed under Other: invite --ssh ADDRESS', async ($, on) => {
  const seen = world($, on, { answers: ['jess@devbox', null] })
  await open($, seen)
  await until(() => seen.invites.length === 1)
  expect(seen.invites).toEqual(['invite --ssh jess@devbox'])
})

test('no turn for the join: asked anyway once the wait is over', async ($, on) => {
  const seen = world($, on)
  await start($)
  await typed($, '')
  await seen.tick(6000)
  await seen.tick()
  await until(() => seen.cards.length === 1)
  expect(shown(seen)?.question).toBe(QUESTION)
})

for (const [why, opts, interactive] of [
  ['a join of a room already open', { opened: false }, true],
  ['SUB_HUMAN_WALK=0', { walk: '0' }, true],
  ['a session nobody types in (-p)', {}, false],
] as const) {
  test(`no question for ${why}`, async ($, on) => {
    const seen = world($, on, opts)
    await start($, interactive)
    await typed($, '')
    await $.turn.start({ text: '/sub-human', turnId: 't-join' })
    await $.turn.complete({ turnId: 't-join', answer: '', durationMs: 0, isAborted: false, reason: 'answer' })
    await seen.tick(6000); await seen.tick()
    await new Promise(r => setTimeout(r, 200))
    expect(seen.cards).toEqual([])
    expect(seen.scripts).not.toContain('walk.ts')
  })
}
