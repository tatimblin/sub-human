// Risk 1 (docs/internals/v2-risks.md): a session.send hook that answers { isDelivered: true } without next.
// The kit has no engine core: the test's own `on` is the bottom of the chain, and a SendMessage tool call is not
// routed to session.send ("no implementation for tool.call"). So this shows only that the chain stops at the module
// and its answer reaches the caller; the real-session check is scripts/risk-send.ts.
import type { On, SessionSendOrigin } from 'claude-code'
import { test, expect } from 'claude-code/testing'

// Inline plugins are loaded from their source: register may close over nothing, so the catch is reported on ui.log.
const catcher = {
  name: 'risk-catcher',
  register(on: On) {
    on('session.send', ($, e, next) => {
      if (!/\.TESTROOM$/.test(e.to)) return next(e)
      $.ui.log(`caught ${e.to} ${e.text}`, { to: 'debug' })
      return { isDelivered: true }
    })
  },
}

// The engine stamps origin in a session; the kit's $ passes the input whole, so the test gives it.
const origin: SessionSendOrigin = { kind: 'model' }

function bottom(on: On) {
  const reached: string[] = []
  const logged: string[] = []
  on('session.send', (_, e) => { reached.push(e.to); return { isDelivered: false, reason: 'bottom reached' } })
  on('ui.log', (_, e) => { logged.push(e.text); return { value: undefined } })
  return { reached, logged }
}

test('a room address is answered delivered without next', { plugins: [catcher] }, async ($, on) => {
  const seen = bottom(on)
  const r = await $.session.send({ to: 'bob.TESTROOM', text: 'hello', origin })
  expect(r).toEqual({ isDelivered: true })
  expect(seen.reached).toEqual([])
  expect(seen.logged).toEqual(['caught bob.TESTROOM hello'])
})

test('any other address goes on with next', { plugins: [catcher] }, async ($, on) => {
  const seen = bottom(on)
  const r = await $.session.send({ to: 'team-lead', text: 'hello', origin })
  expect(r).toEqual({ isDelivered: false, reason: 'bottom reached' })
  expect(seen.reached).toEqual(['team-lead'])
  expect(seen.logged).toEqual([])
})

// A hook that throws is skipped, so the send goes on beneath it: in a session, to native delivery.
test('a throwing session.send hook falls through to what is beneath', {
  plugins: [{ name: 'risk-thrower', register(on: On) { on('session.send', () => { throw new Error('boom') }) } }],
}, async ($, on) => {
  const seen = bottom(on)
  const r = await $.session.send({ to: 'bob.TESTROOM', text: 'hello', origin })
  expect(r).toEqual({ isDelivered: false, reason: 'bottom reached' })
  expect(seen.reached).toEqual(['bob.TESTROOM'])
})

test('the kit does not route a SendMessage tool call to session.send', { plugins: [catcher] }, async ($, on) => {
  const seen = bottom(on)
  await expect($.tool.call({ tool: 'SendMessage', to: 'bob.TESTROOM', message: 'hello' })).rejects.toThrow(/no implementation for tool\.call/)
  expect(seen.reached).toEqual([])
  expect(seen.logged).toEqual([])
})
