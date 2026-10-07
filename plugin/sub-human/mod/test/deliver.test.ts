// Wiring: the room's delivery through the hooks module (mod/deliver.mjs). Run with `npm run test:mods`.
// The routing table is tested in node (test/mod-core.test.js, mod/core/deliver.mjs); the tail's events in
// test/tail.test.js. This checks the hooks: session.start spawns `node bin/sub-human tail --ndjson` for a seated
// session, and its events reach the session: a chat event is a $.ui.log notice and starts no turn, a wake while
// idle submits one prompt, a wake mid-turn goes to an append (and logs its visible lines) instead.
// The test kit has no bottom for a plugin's own $.session.append in 2.1.292 (a test's on('session.append') is not
// reached by it: "no implementation for session.append"), so the appends themselves (pull, a mid-turn wake) are
// seen here only as attempts: a pull is lost (at most once, D8) and a mid-turn wake falls back to a prompt. The
// live check in docs/next/MODS-PLAN.md (W3 results) saw both appends land.
import { test, expect } from 'claude-code/testing'

const SEAT = { name: 'alice', code: 'otter-4821', role: 'member', addr: 'alice.otter-4821' }
const OUT = { home: '/u/.sub-human', realHome: '/u/.sub-human', userHome: '/u', pluginRoot: '/p/sub-human', seat: SEAT }
const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
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

/**
 * The engine beneath: mod-hello answering `hello`; the tail child streaming `pieces` (once), then staying up until
 * the test ends (`release`); the session's notices, appends and prompts recorded.
 */
function world(engine: any, on: any, { hello = OUT as any, pieces = [] as string[], gate = Promise.resolve() as Promise<void> } = {}) {
  const seen = { spawns: [] as any[], logs: [] as string[], prompts: [] as string[], contexts: [] as any[], scripts: [] as string[], classic: [] as any[], release: () => {} }
  const held = new Promise<void>(r => { seen.release = r })
  on('session.id', () => ({ value: SID }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', ($: any, e: any) => {
    const script = String(e.argv[1]).replace(/^.*\/hooks\//, '')
    seen.scripts.push(script)
    if (script === 'prompt.js') return ran(JSON.stringify({ subHuman: { reviewOpen: false } }))
    return ran(script === 'mod-hello.js' ? JSON.stringify(hello) : '')
  })
  on('process.spawn', async function* ($: any, e: any) {
    seen.spawns.push(e)
    await gate
    if (seen.spawns.length === 1) for (const text of pieces) yield { stream: 'stdout', text }
    await held
    return { code: 0, signal: null }
  })
  on('ui.log', ($: any, e: any) => { seen.logs.push(e.text); return { value: undefined } })
  on('prompt.submit', async ($: any, e: any) => {
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
const start = ($: any) => $.session.start({ cwd: '/w', surface: null, isInteractive: true })

test('a seated session starts the tail child: node bin/sub-human tail --ndjson, by its session id', async ($, on) => {
  const seen = world($, on)
  await start($)
  await until(() => seen.spawns.length === 1)
  const e = seen.spawns[0]
  expect(e.argv[0]).toBe('node')
  expect(e.argv[1]).toMatch(/\/bin\/sub-human$/)
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
  await until(() => seen.prompts.length === 1).catch(() => { throw new Error(JSON.stringify(seen)) })
  expect(seen.logs).toEqual(['bob: hi', 'carol joined']) // one notice per line (a newline would show as U+FFFD)
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toMatch(/^\(for Claude\) sub-human room/)
  expect(seen.prompts[0]).toMatch(/bob's Claude \(to you\): q\?$/)
  seen.release()
})

test('a wake mid-turn goes to an append and logs what the person would see; a refused append falls back to a prompt', async ($, on) => {
  let go = () => {}
  const gate = new Promise<void>(r => { go = r })
  // the child here waits for the turn to be running before it writes its wake
  const seen = world($, on, { gate, pieces: [line({ type: 'seat', seat: SEAT }) + line({ type: 'wake', text: 'room: decided (room decision)\n(for Claude) room now: …' })] })
  await start($)
  await $.turn.start({ text: 'working on it', turnId: 't1' } as any)
  go()
  await until(() => seen.logs.length === 1 && seen.prompts.length === 1)
  expect(seen.logs).toEqual(['room: decided (room decision)'])
  // the kit refuses the append (see the head of this file): the wake is submitted after all, whole
  expect(seen.prompts[0]).toMatch(/^\(for Claude\) sub-human room[^\n]*\nroom: decided \(room decision\)\n\(for Claude\) room now: …$/)
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

test('while the child delivers, a member\'s plain prompt starts no node once consent said no review is open; the mod titles the session', async ($, on) => {
  const seen = world($, on, { pieces: [line({ type: 'seat', seat: SEAT })] })
  await start($)
  await until(() => seen.spawns.length === 1)
  await new Promise(r => setTimeout(r, 50))
  const typed = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as any)
  await typed('first')  // reviewMaybeOpen is unsure after session.start: prompt.js runs and reports no review
  expect(seen.scripts.filter(x => x === 'prompt.js').length).toBe(1)
  expect(seen.classic[0].sessionTitle).toBe('alice.otter-4821')
  await typed('second')
  await typed('third')
  expect(seen.scripts.filter(x => x === 'prompt.js').length).toBe(1)
  expect(seen.classic[1].sessionTitle).toBe(undefined)
  expect(seen.scripts.filter(x => x === 'presence.js').length).toBe(1)
  await typed('@room ship it') // a post is signed in node
  expect(seen.scripts.filter(x => x === 'prompt.js').length).toBe(2)
  seen.release()
})
