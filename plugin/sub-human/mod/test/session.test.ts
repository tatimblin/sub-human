// Wiring: the session's hello and its SessionStart (mod/deliver.ts). Run with `npm run test:mods`.
// A session with no session index starts no node at its start: the hello is the module's own (the home from the
// environment, no seat), and its lease is written when /sub-human first runs. A /clear, compact or resume puts a seat
// back through node session-restore, then says hello; a member's rows then come with its next prompt (0.6.0: no wake and
// no line; the room session's resume still runs row-rewake, whose row calls are its wake). A session surely without a
// seat does none of it.
import type { EventOf, On } from 'claude-code'
import { test, expect, mock, type ClassicFields, type Engine } from 'claude-code/testing'
import { debugLines, SEAT, helloOf, must, ran, scriptOf, session, start, stdinOf, type Seat } from './support.ts'

const SID = 'sid-s'
const HOME = '/u/.sub-human'

/** The engine beneath: HOME=/u, a session index for SID only when `indexed`, mod-hello answering for `seat`, the
 * other scripts answering from `answer` ({stdout, exitCode, stderr}); what ran, the prompts submitted, the writes
 * the guard let through. */
type Answer = { stdout?: string; exitCode?: number; stderr?: string }
type Options = { indexed?: boolean; seat?: Seat | null; answer?: Record<string, Answer>; cc?: Record<string, unknown> }
function world(_engine: Engine, on: On, { indexed = false, seat = null, answer = {}, cc, home }: Options & { home?: string } = {}) {
  const seen: { runs: string[]; stdin: Record<string, Record<string, unknown>>; prompts: string[]; asUser: boolean[]; logs: string[] } = { runs: [], stdin: {}, prompts: [], asUser: [], logs: [] }
  session(on, SID)
  on('session.cwd', () => ({ value: '/w' }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/u' : undefined }))
  on('fs.exists', (_$, e) => ({ value: indexed && e.path === `${HOME}/sessions/by-sid/${SID}.json` }))
  on('fs.stat', (_$, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('ui.log', (_$, e) => { if (e.to === 'debug') debugLines.push(e.text); else seen.logs.push(e.text); return { value: undefined } })
  on('process.run', (_$, e) => {
    const script = scriptOf(e)
    seen.runs.push(script)
    seen.stdin[script] = stdinOf(e)
    if (script === 'mod-hello.ts') return ran(JSON.stringify({ ...helloOf(seat), ...(home ? { home, realHome: home } : {}), ...(cc ? { cc } : {}) }))
    const a = answer[script] ?? {}
    return ran(a.stdout ?? '', a.exitCode ?? 0, a.stderr ?? '')
  })
  on('process.spawn', async function* () { yield* []; return { value: { code: 0, signal: null } } })
  on('prompt.submit', (_$, e) => { seen.prompts.push(e.text); seen.asUser.push('asUser' in e.origin && e.origin.asUser === true); return { text: e.text } })
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptExpansion', () => ({}))
  on('command.run', () => ({}))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  return seen
}
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)) }
}

test('no session index: no node at session start, the guard still knows the home; /sub-human writes the lease first, then joins', async ($, on) => {
  const seen = world($, on)
  await start($)
  await new Promise(r => setTimeout(r, 30))
  expect(seen.runs).toEqual([])
  // the home came from the environment: a write into it is denied as one into the store
  const w = await $.tool.call({ tool: 'Write', file_path: `${HOME}/rooms/otter-4821/log.jsonl`, content: 'x' })
  expect(w.deny).toMatch(/sub-human/)
  // @ts-expect-error -- deliberate: no presentation, as these tests have always raised /sub-human
  await $.command.run({ command: 'sub-human:sub-human', args: 'help', origin: { kind: 'composer' } })
  expect(seen.runs).toEqual(['mod-hello.ts', 'join.ts', 'mod-hello.ts'])
  expect(seen.stdin['join.ts']?.sub_human_nonce).toBe(must(seen.stdin['mod-hello.ts'], 'the hello\'s stdin').nonce)
})

test('a session index: mod-hello at session start', async ($, on) => {
  const seen = world($, on, { indexed: true, seat: SEAT })
  await start($)
  expect(seen.runs[0]).toBe('mod-hello.ts')
})

test('a resumed seat: session-restore puts it back (its context and title), then the hello; a member\'s rows come with the next prompt: no row-rewake, no wake, no line', async ($, on) => {
  const restore = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'SUB-HUMAN: you are alice', sessionTitle: SEAT.addr } }
  const calls = 'sub-human: this session was resumed and its rows did not survive it. Re-create them now, exactly as written:\nAgent({subagent_type: "sub-human:room"})\nMake only these calls, then end your turn with the one word "ok".'
  const seen = world($, on, { indexed: true, seat: SEAT, answer: { 'session-restore.ts': { stdout: JSON.stringify(restore) }, 'row-rewake.ts': { exitCode: 2, stderr: calls } } })
  await start($)
  seen.runs.length = 0
  const r = await $.classic.SessionStart({ session_id: SID, source: 'resume', cwd: '/w', transcript_path: '/t.jsonl' })
  expect(r.additionalContext).toEqual(['SUB-HUMAN: you are alice'])
  expect(r.sessionTitle).toBe(SEAT.addr)
  await until(() => seen.runs.includes('mod-hello.ts'))
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(seen.runs.slice(0, 2)).toEqual(['session-restore.ts', 'mod-hello.ts'])
  // 0.6.0: "restoring this session's rows" is gone: the rows ride with the person's next prompt (the tail's rows
  // event), said again since the resume
  expect(seen.runs).not.toContain('row-rewake.ts')
  expect(seen.prompts).toEqual([])
})

test('a session surely without a seat: compact, clear and resume start no node', async ($, on) => {
  const seen = world($, on)
  await start($)
  const sources: ClassicFields<'SessionStart'>['source'][] = ['compact', 'clear', 'resume', 'startup']
  for (const source of sources) await $.classic.SessionStart({ session_id: SID, source })
  expect(seen.runs).toEqual([])
})

test('a fork (← the agent view moved the conversation into a bg job, a new session id with no index): session-restore runs anyway and takes the old seat, then the hello names it; a member\'s rows come with the next prompt', async ($, on) => {
  const restore = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'SUB-HUMAN: you are alice\n(restored after the agent view)', sessionTitle: SEAT.addr } }
  const calls = 'sub-human: this session was resumed, and its rows are NOT running.\nAgent({subagent_type: "sub-human:room"})'
  const seen = world($, on, { seat: SEAT, answer: { 'session-restore.ts': { stdout: JSON.stringify(restore) }, 'row-rewake.ts': { exitCode: 2, stderr: calls } } })
  await start($)
  expect(seen.runs).toEqual([]) // no index for the new id: the hello is the module's own
  const r = await $.classic.SessionStart({ session_id: SID, source: 'fork', cwd: '/w', transcript_path: '/t.jsonl' })
  expect(r.additionalContext).toEqual([restore.hookSpecificOutput.additionalContext])
  expect(r.sessionTitle).toBe(SEAT.addr)
  expect(seen.runs.slice(0, 2)).toEqual(['session-restore.ts', 'mod-hello.ts'])
  expect(seen.stdin['session-restore.ts']?.source).toBe('fork')
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(seen.runs).not.toContain('row-rewake.ts')
  expect(seen.prompts).toEqual([])
})

test('a fork with nothing to take back: session-restore says nothing, no tail child, no rewake', async ($, on) => {
  const seen = world($, on)
  await start($)
  const r = await $.classic.SessionStart({ session_id: SID, source: 'fork', cwd: '/w', transcript_path: '/t.jsonl' })
  expect(r.additionalContext).toBeUndefined()
  expect(seen.runs).toEqual(['session-restore.ts', 'mod-hello.ts'])
})

test('stage 8e E: a fork whose seat is in another sub-human folder: session-restore\'s notice reaches the person, no seat, no tail child', async ($, on) => {
  const said = 'sub-human: this session continues alice.otter-4821 (the agent view moved it here), but that seat is not in this session\'s sub-human folder (/u/.sub-human): …'
  const seen = world($, on, { answer: { 'session-restore.ts': { stdout: JSON.stringify({ systemMessage: said }) } } })
  await start($)
  const r = await $.classic.SessionStart({ session_id: SID, source: 'fork', cwd: '/w', transcript_path: '/t.jsonl' })
  expect(r.additionalContext).toBeUndefined()
  expect(seen.logs).toEqual([said.replace(/^sub-human: /, '')])
  expect(seen.runs).toEqual(['session-restore.ts', 'mod-hello.ts'])
})

test('stage 8f item 1: a hello that names a seat in another folder appends the hidden home notice once per session and folder; the default folder and no seat append none', async ($, on) => {
  const appended: EventOf['session.append']['message'][] = []
  on('session.append', (_$, e, next) => { appended.push(e.message); return next(e) })
  const seen = world($, on, { indexed: true, seat: SEAT, home: '/u/work/.sub-human' })
  await start($)
  await until(() => appended.length === 1)
  expect(appended[0]?.type).toBe('system')
  expect(appended[0]?.content).toEqual([{ type: 'text', text: 'sub-human: home /u/work/.sub-human' }])
  // another hello for the same session and folder (a resume's restore): no second notice
  await $.classic.SessionStart({ session_id: SID, source: 'resume', cwd: '/w', transcript_path: '/t.jsonl' })
  await new Promise(r => setTimeout(r, 50))
  expect(seen.runs).toContain('mod-hello.ts')
  expect(appended.length).toBe(1)
})

test('the hello carries the Claude Code version; a seated hello on a version not verified says so once per version, in the debug log alone', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('session.version', () => ({ value: { version: '2.1.302', base: '2.1.302' } }))
  const seen = world($, on, { indexed: true, seat: SEAT, cc: { version: '2.1.302', verified: false, off: ['tasks', 'plan-edit', 'sign-off'] } })
  const hellos = () => seen.runs.filter(r => r === 'mod-hello.ts').length
  await start($)
  await until(() => hellos() === 1)
  expect(seen.stdin['mod-hello.ts']?.cc_version).toBe('2.1.302')
  expect(seen.logs).toEqual([])
  await clock.advance(400)
  const said = "Claude Code 2.1.302 isn't verified with sub-human yet: the room task list is off (tasks are kept in the room), plan edits use the plan tool, sign-off is a question Claude Code asks you, not the plan view. sub-human doctor has details."
  expect(seen.logs).toEqual([]) // 0.6.0: nothing on screen
  expect(debugLines.filter(l => l === said).length).toBe(1)
  // another hello for the same version: nothing more
  await $.classic.SessionStart({ session_id: SID, source: 'resume', cwd: '/w', transcript_path: '/t.jsonl' })
  await until(() => hellos() === 2)
  await clock.advance(400)
  expect(debugLines.filter(l => l === said).length).toBe(1)
})

test('a hello with no seat says nothing of the version', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('session.version', () => ({ value: { version: '2.1.302', base: '2.1.302' } }))
  const seen = world($, on, { indexed: true, seat: null, cc: { version: '2.1.302', verified: false, off: ['tasks'] } })
  await start($)
  await new Promise(r => setTimeout(r, 30))
  await clock.advance(400)
  expect(seen.logs).toEqual([])
})

test('noise pass H: a seat in the default folder (~/.sub-human) appends no home notice', async ($, on) => {
  const appended: unknown[] = []
  on('session.append', (_$, e, next) => { appended.push(e.message); return next(e) })
  const seen = world($, on, { indexed: true, seat: SEAT })
  await start($)
  await until(() => seen.runs.includes('mod-hello.ts'))
  await new Promise(r => setTimeout(r, 50))
  expect(appended).toEqual([])
})

test('stage 8f item 1: a session with no seat appends no home notice', async ($, on) => {
  const appended: EventOf['session.append']['message'][] = []
  on('session.append', (_$, e, next) => { appended.push(e.message); return next(e) })
  world($, on, { indexed: true, seat: null })
  await start($)
  await new Promise(r => setTimeout(r, 50))
  expect(appended).toEqual([])
})
