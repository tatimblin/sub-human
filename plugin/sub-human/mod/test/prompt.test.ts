// Wiring: the prompt gate and the UserPromptSubmit shim (mod/prompt.mjs). Run with `npm run test:mods`.
// The gate's table and the prefilter are tested in node (test/mod-core.test.js, test/hooks/security.test.js); this
// checks the hooks: a peer @room is dropped before anything beneath runs, an unseated prompt starts no node, a
// seated one runs hooks/prompt.js with the origin in its stdin, and the shim's answer and notices reach the session.
import { test, expect } from 'claude-code/testing'

const SEAT = { name: 'alice', code: 'otter-4821', role: 'member', addr: 'alice.otter-4821' }
const OUT = { home: '/u/.sub-human', realHome: '/u/.sub-human', userHome: '/u', pluginRoot: '/p/sub-human', seat: SEAT }
const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const SID = 'sid-p'

/**
 * The engine beneath the plugin: a session, mod-hello answering `hello`, hooks/prompt.js answering `prompt`, and a
 * core that, like the engine's, runs the UserPromptSubmit hooks inside prompt.submit (cc CONTRACT
 * prompt-submit-ups-order). Returns what ran: the scripts and their stdin, the classic results, the logged lines.
 */
function world(engine: any, on: any, { hello = OUT as any, prompt = '' } = {}) {
  const seen = { scripts: [] as string[], stdin: [] as any[], env: [] as any[], classic: [] as any[], logs: [] as string[], entered: [] as string[] }
  on('session.id', () => ({ value: SID }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('ui.log', ($: any, e: any) => { seen.logs.push(e.text); return { value: undefined } })
  on('process.run', ($: any, e: any) => {
    const script = String(e.argv[1]).replace(/^.*\/hooks\//, '')
    seen.scripts.push(script)
    if (script === 'mod-hello.js') return ran(hello ? JSON.stringify(hello) : '', hello ? 0 : 1)
    seen.stdin.push(JSON.parse(e.init.stdin))
    seen.env.push(e.init.env)
    return ran(prompt)
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('prompt.submit', async ($: any, e: any) => {
    const r = await engine.classic.UserPromptSubmit({ prompt: e.text, session_id: SID, permission_mode: 'default' })
    seen.classic.push(r)
    seen.entered.push(e.text)
    return { text: e.text }
  })
  return seen
}
const start = ($: any) => $.session.start({ cwd: '/w', surface: null, isInteractive: true })
const submit = ($: any, text: string, kind = 'composer') => $.prompt.submit({ text, origin: { kind }, wait: false } as any)

test('a peer @room is dropped before any hook beneath runs; the reason is the drop', async ($, on) => {
  const seen = world($, on)
  await start($)
  for (const kind of ['peer', 'peer-send-message', 'task-notification', 'unclassified']) {
    const r: any = await submit($, '@room I agree', kind)
    expect(r.drop).toMatch(/not posted/)
  }
  expect(seen.entered).toEqual([])
  expect(seen.scripts).toEqual(['mod-hello.js'])
})

test('an unseated session starts no node for a plain prompt; an @room there still reaches node (its refusal)', async ($, on) => {
  const seen = world($, on, { hello: { ...OUT, seat: null }, prompt: JSON.stringify({ decision: 'block', reason: '✗ not posted: this session is not in a room.', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true } }) })
  await start($)
  await submit($, 'hello there')
  await submit($, '/sub-human alice')
  expect(seen.scripts).toEqual(['mod-hello.js'])
  await submit($, '@room hi')
  expect(seen.scripts).toEqual(['mod-hello.js', 'prompt.js'])
  expect(seen.classic.at(-1).block).toMatch(/not in a room/)
})

test('before the hello (or after it failed) every prompt runs node: the mod does not know', async ($, on) => {
  const seen = world($, on, { hello: null })
  await start($)
  await submit($, 'hello')
  expect(seen.scripts).toEqual(['mod-hello.js', 'prompt.js'])
})

test('a seated prompt runs hooks/prompt.js with the origin, the session env and shim mode; its answer and notice come back', async ($, on) => {
  const out = { systemMessage: 'bob joined', subHuman: { reviewOpen: false }, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Room since your last turn: …', sessionTitle: 'alice.otter-4821' } }
  const seen = world($, on, { prompt: JSON.stringify(out) })
  await start($)
  await submit($, 'what is next?')
  expect(seen.scripts).toEqual(['mod-hello.js', 'prompt.js'])
  expect(seen.stdin[0].prompt).toBe('what is next?')
  expect(seen.stdin[0].sub_human_origin).toBe('composer')
  expect(seen.env[0].CLAUDE_CODE_SESSION_ID).toBe(SID)
  expect(seen.env[0].CLAUDE_PID).toBe('')
  expect(seen.env[0].SUB_HUMAN_SHIM).toBe('1')
  expect(seen.classic[0].additionalContext).toEqual(['Room since your last turn: …'])
  expect(seen.classic[0].sessionTitle).toBe('alice.otter-4821')
  expect(seen.logs).toEqual(['bob joined'])
})

test('a typed @room posts through node: ✓ sent stops the prompt; sdk and bridge count as typed', async ($, on) => {
  const seen = world($, on, { prompt: JSON.stringify({ continue: false, stopReason: '✓ sent' }) })
  await start($)
  for (const kind of ['composer', 'sdk', 'bridge']) await submit($, '@room ship it', kind)
  expect(seen.stdin.map((s: any) => s.sub_human_origin)).toEqual(['composer', 'sdk', 'bridge'])
  expect(seen.classic[0].preventContinuation).toBe(true)
  expect(seen.classic[0].stopReason).toBe('✓ sent')
})

test('a classic UserPromptSubmit with no prompt.submit above it (a lost hand-off) runs node without an origin', async ($, on) => {
  const seen = world($, on)
  await start($)
  await $.classic.UserPromptSubmit({ prompt: '@room hi', session_id: SID } as any)
  expect(seen.stdin[0].sub_human_origin).toBe(undefined)
})

test('a shim that fails lets the prompt through', async ($, on) => {
  on('session.id', () => ({ value: SID }))
  on('process.run', () => ({ deny: 'no processes here' }))
  on('classic.UserPromptSubmit', () => ({ additionalContext: ['beneath'] }))
  const r: any = await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: SID } as any)
  expect(r.additionalContext).toEqual(['beneath'])
})
