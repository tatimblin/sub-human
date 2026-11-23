// capture.ts on recorded tool results (test/fixtures/cc/2.1.330): what my session's work writes to the room, and the
// presence my turns keep. Each write is a request to the kit's daemon (test/support/seed-room.ts).
import { expect, mock, test } from 'claude-code/testing'
import * as v from '../vendor/valibot.mjs'
import { toolFixture } from '../test/support/fixtures.js'
import { kitReader } from '../test/support/kit-fixtures.js'
import { CWD, EDIT, EDITED, END, START, seedRoom } from '../test/support/seed-room.js'

const COMMIT = toolFixture('tool-bash-git-commit', 'Bash', kitReader)
const NPM_TEST = toolFixture('tool-bash-test', 'Bash', kitReader)
const CREATE = toolFixture('tool-task-create', 'TaskCreate', kitReader)
const DONE = toolFixture('tool-task-update-completed', 'TaskUpdate', kitReader)
const Line = v.looseObject({ kind: v.string(), from: v.string(), by: v.string(), text: v.optional(v.string()), event: v.optional(v.string()) })
const entries = (lines: readonly string[]) => lines.map(l => v.parse(Line, JSON.parse(l)))

test('a commit and a test run are activity entries, mine and labelled my Claude\'s (R12, R35)', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'Bash' }, (_, e) => (e.command === COMMIT.input.command ? COMMIT.result : NPM_TEST.result))
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await $.tool.call(COMMIT.input)
  await $.tool.call(NPM_TEST.input)
  const mine = entries(room.store.room.lines).filter(e => e.kind === 'activity')
  expect(mine).toMatchObject([
    { from: 'alice', by: 'claude', event: 'commit', text: 'committed 9b6afa1: add notes' },
    { from: 'alice', by: 'claude', event: 'test', text: 'npm test' },
  ])
  await $.session.end(END)
})

test('a secret in a commit message is never shared (R14a)', async ($, on) => {
  const clock = mock.clock(on)
  const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
  on('tool.call', { tool: 'Bash' }, () => ({
    result: {
      stdout: `[master 9b6afa1] token ${secret}`, stderr: '', interrupted: false, isImage: false, noOutputExpected: false,
      gitOperation: { commit: { sha: '9b6afa1', kind: 'committed', branch: 'master' } },
    },
  }))
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await $.tool.call(COMMIT.input)
  expect(room.store.room.lines.join('\n')).not.toContain(secret)
  expect(room.requests.filter(r => r.op === 'append')).toEqual([])
  await $.session.end(END)
})

test('a personal task finished is an activity entry, named by the subject its create carried (R23)', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'TaskCreate' }, () => CREATE.result)
  on('tool.call', { tool: 'TaskUpdate' }, () => DONE.result)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await $.tool.call(CREATE.input)
  await $.tool.call(DONE.input)
  expect(entries(room.store.room.lines).filter(e => e.kind === 'activity').map(e => e.text)).toEqual(['added task: demo task', 'completed task: demo task'])
  await $.session.end(END)
})

test('a subagent\'s edit is mine (R16a)', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'Edit' }, () => EDIT.result)
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  await $.tool.call({ ...EDIT.input, agentId: 'helper-1' })
  expect(JSON.parse(room.store.room.docs.get('activity/alice') ?? '{}')).toMatchObject({ name: 'alice', files: [EDITED] })
  await $.session.end(END)
})

test('my work is shared from its repo: an ignored file never, a plans folder\'s file is no edit, and entries name the repo and branch (R1, R12, R14a)', async ($, on) => {
  const clock = mock.clock(on)
  const repo = CWD.split('/').at(-1) ?? ''
  on('vcs.detect', () => ({ vcs: 'git', root: CWD, mainRoot: null, revision: null, branch: 'alice/paging', defaultBranch: 'main', remote: null }))
  on('tool.call', { tool: 'Edit' }, () => EDIT.result)
  on('tool.call', { tool: 'Bash' }, () => NPM_TEST.result)
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ result: { plan: '# p', filePath: `${CWD}/plans/p.md` }, text: 'approved' }))
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now, files: { [`${CWD}/.gitignore`]: 'private/\n*.log\n' } })
  await $.session.start({ ...START, cwd: `${CWD}/sub`, isInteractive: false }) // a folder inside the repo
  await room.settled(clock)
  for (const ignored of ['debug.log', 'private/a.md']) await $.tool.call({ ...EDIT.input, file_path: `${CWD}/${ignored}` })
  await $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'toolu_exit' })
  await $.tool.call({ ...EDIT.input, file_path: `${CWD}/plans/p.md` })
  await $.tool.call(EDIT.input)
  await $.tool.call(NPM_TEST.input)
  const docs = room.requests.flatMap(r => (r.op === 'put_doc' && r.kind === 'activity' && 'files' in r.doc ? [r.doc.files] : []))
  expect(docs).toEqual([[EDITED]])
  expect(JSON.stringify(room.requests)).not.toMatch(/debug\.log|private|plans\/p\.md/)
  const Where = v.looseObject({ kind: v.string(), event: v.optional(v.string()), repo: v.optional(v.string()), branch: v.optional(v.string()) })
  expect(room.store.room.lines.map(l => v.parse(Where, JSON.parse(l))).filter(e => e.kind === 'activity')).toMatchObject([{ event: 'test', repo, branch: 'alice/paging' }])
  await $.session.end(END)
})

test('a main turn marks me working and its end idle; a subagent\'s turn writes nothing (R12)', async ($, on) => {
  const clock = mock.clock(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  const states = () => room.requests.flatMap(r => (r.op === 'put_doc' && r.kind === 'presence' && 'state' in r.doc ? [r.doc.state] : []))
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(states()).toEqual(['working'])
  await $.turn.start({ text: '', turnId: 't2', agentId: 'helper-1' })
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'helper-1' })
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(states()).toEqual(['working', 'idle'])
  expect(JSON.parse(room.store.room.docs.get('presence/alice@my-laptop') ?? '{}')).toMatchObject({ state: 'idle' })
  await $.session.end(END)
})

test('the session pings the daemon at the start and every 20 s, idle at the prompt too, with its Claude Code version', async ($, on) => {
  const clock = mock.clock(on)
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330' } }))
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  await $.session.start(START)
  await room.settled(clock)
  const pings = () => room.requests.filter(r => r.op === 'ping')
  expect(pings()).toEqual([{ op: 'ping', session: 'session-1', code: room.code, name: 'alice', cc: '2.1.330' }])
  for (let i = 0; i < 20; i++) await room.poll(clock)
  expect(pings()).toHaveLength(2)
  await $.session.end(END)
})

test('a main turn\'s start clears a permission wait the Notification hook wrote', async ($, on) => {
  const clock = mock.clock(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  const room = await seedRoom(on, { me: 'alice', others: ['bob'], now: clock.now })
  room.store.room.docs.set('presence/alice@my-laptop', JSON.stringify({ name: 'alice', state: 'working', waiting: true, machine: 'my-laptop', at: 0 }))
  await $.session.start(START)
  await room.settled(clock)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  const doc = v.parse(v.record(v.string(), v.unknown()), JSON.parse(room.store.room.docs.get('presence/alice@my-laptop') ?? '{}'))
  expect(doc).toMatchObject({ name: 'alice', state: 'working' })
  expect(doc.waiting).toBeUndefined()
  await $.session.end(END)
})
