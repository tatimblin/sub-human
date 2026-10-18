// Wiring: SendMessage to a member on another machine (mod/send.ts). Run with `npm run test:mods`.
// The judgement is tested in node (test/mod-core.node-test.ts: remotePeer, peerOf, postResult, relayResult) and end to
// end over two homes (test/remote-e2e.node-test.ts, which judges through the same mod/core/send.ts peerOf). This checks
// the hook: what it reads, that a send to another machine goes through the room (the room server's post, else node
// hooks/handlers/send.ts) and never to the engine, whose only answer there is "not reachable", and that anything else
// is the engine's.
import type { On } from 'claude-code'
import { test, expect, type Engine } from 'claude-code/testing'
import { SEAT, CODE, OUT, must, ran, scriptOf, session, start, stdinOf } from './support.ts'

const SID = 'sid-s'
const HOME = OUT.home
const HERE = 'machine-here', THERE = 'machine-there'

type Seen = { engine: { to: string; text: string }[]; calls: { server: string; tool: string; args: Readonly<Record<string, unknown>> }[]; relays: Record<string, unknown>[]; reads: string[] }
type Opts = {
  /** members.json's records (null: unreadable). */
  members?: Record<string, unknown> | null
  machine?: unknown; machines?: unknown
  /** What $.mcp.connect answers ('throw': it rejects). */
  server?: 'up' | 'down' | 'throw'
  /** What hooks/handlers/send.ts prints and exits with. */
  relay?: { stdout: string; exitCode: number; stderr?: string }
  hello?: typeof OUT
}
function world(on: On, { members = { alice: { machine: HERE }, bob: { machine: THERE }, carol: { machine: HERE } }, machine = { id: HERE }, machines = null, server = 'up', relay = { stdout: '{"isDelivered":true}', exitCode: 0 }, hello = OUT }: Opts = {}) {
  const seen: Seen = { engine: [], calls: [], relays: [], reads: [] }
  session(on, SID)
  const files: Record<string, unknown> = { [`${HOME}/rooms/${CODE}/members.json`]: members, [`${HOME}/machine.json`]: machine, [`${HOME}/machines.json`]: machines }
  on('fs.read', (_$, e) => {
    seen.reads.push(e.path)
    const v = files[e.path]
    if (v === null || v === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: JSON.stringify(v) }
  })
  on('process.run', (_$, e) => {
    const script = scriptOf(e)
    if (script === 'mod-hello.ts') return ran(JSON.stringify(hello))
    if (script === 'send.ts') { seen.relays.push(stdinOf(e)); return ran(relay.stdout, relay.exitCode, relay.stderr ?? '') }
    return ran('')
  })
  on('mcp.connect', () => {
    if (server === 'throw') throw new Error('no such server')
    return { value: server === 'up' ? { isConnected: true, server: 'plugin:sub-human:room' } : { isConnected: false, reason: 'failed', message: 'Skipping connection (recent failure cached)' } }
  })
  on('mcp.call', (_$, e) => { seen.calls.push({ server: e.server, tool: e.tool, args: e.args }); return { value: { content: [{ type: 'text', text: 'posted' }], isError: false } } })
  // the engine's own delivery, beneath the module
  on('session.send', (_$, e) => { seen.engine.push({ to: e.to, text: e.text }); return { isDelivered: true } })
  return seen
}
const send = ($: Engine, to: string, text = 'is the store done?') => $.session.send({ to, text, origin: { kind: 'model' } })

test('a send to a member on another machine is the room server\'s post, addressed to that member; the engine never sees it', async ($, on) => {
  const seen = world(on)
  await start($)
  const r = await send($, `bob.${CODE}`)
  expect(r).toEqual({ isDelivered: true })
  expect(seen.calls).toEqual([{ server: 'plugin:sub-human:room', tool: 'post', args: { kind: 'say', to: 'bob', text: 'is the store done?' } }])
  expect([seen.engine, seen.relays]).toEqual([[], []])
  expect(seen.reads.sort()).toEqual([`${HOME}/machine.json`, `${HOME}/machines.json`, `${HOME}/rooms/${CODE}/members.json`])
})

for (const server of ['down', 'throw'] as const) {
  test(`the room server not connected (its connect ${server === 'down' ? 'says so' : 'fails'}): node hooks/handlers/send.ts relays it as the seat; still never the engine`, async ($, on) => {
    const seen = world(on, { server })
    await start($)
    const r = await send($, `bob.${CODE}`)
    expect(r).toEqual({ isDelivered: true })
    expect(seen.relays).toEqual([{ session_id: SID, to: 'bob', text: 'is the store done?' }])
    expect([seen.engine, seen.calls]).toEqual([[], []])
  })
}

test('a relay that fails says why and how to reconnect, as the send\'s refusal; the engine is not asked', async ($, on) => {
  const seen = world(on, { server: 'down', relay: { stdout: '', exitCode: 1, stderr: 'boom' } })
  await start($)
  const r = await send($, `bob.${CODE}`)
  expect(r.isDelivered).toBe(false)
  expect(must(r.reason, 'the reason')).toMatch(/^Not sent to bob \(on another machine, reached through the room\): .*boom.*\/mcp reconnects them$/)
  expect(seen.engine).toEqual([])
})

test('a member on this machine, an unknown or departed one, another room\'s address or a plain name: the engine\'s', async ($, on) => {
  const seen = world(on, { members: { alice: { machine: HERE }, bob: { machine: THERE, left_at: 't' }, carol: { machine: HERE } } })
  await start($)
  for (const to of [`carol.${CODE}`, `bob.${CODE}`, `dave.${CODE}`, 'bob.other-1234', 'researcher']) await send($, to)
  expect(seen.engine.map(x => x.to)).toEqual([`carol.${CODE}`, `bob.${CODE}`, `dave.${CODE}`, 'bob.other-1234', 'researcher'])
  expect([seen.calls, seen.relays]).toEqual([[], []])
})

test('this machine in the room is the id the host gave its link (machines.json) before the home\'s own (machine.json)', async ($, on) => {
  // over a link the host records this machine as THERE: bob, on THERE too, is on this machine
  const seen = world(on, { machines: { [CODE]: THERE } })
  await start($)
  await send($, `bob.${CODE}`)
  await send($, `carol.${CODE}`)
  expect(seen.engine.map(x => x.to)).toEqual([`bob.${CODE}`])
  expect(seen.calls.map(c => c.args.to)).toEqual(['carol'])
})

test('a session with no seat, or files it cannot read: the engine\'s, unchanged', async ($, on) => {
  const seen = world(on, { hello: { ...OUT, seat: null } })
  await start($)
  await send($, `bob.${CODE}`)
  expect(seen.engine.map(x => x.to)).toEqual([`bob.${CODE}`])
  expect(seen.reads).toEqual([])
})

test('unreadable members document: the engine\'s', async ($, on) => {
  const seen = world(on, { members: null })
  await start($)
  await send($, `bob.${CODE}`)
  expect(seen.engine.map(x => x.to)).toEqual([`bob.${CODE}`])
  expect(SEAT.code).toBe(CODE)
})
