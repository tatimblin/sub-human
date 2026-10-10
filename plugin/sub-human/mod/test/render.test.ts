// Wiring: the group-chat drawing of UserMessage rows (mod/render.ts). Run with `npm run test:mods`.
import { test, expect } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const row = (props: any) => ({ plugin: 'sub-human', component: 'UserMessage' as const, props: { isExpanded: false, ...props } })
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)

test('a peer message from another member\'s Claude is one compact chat row', async $ => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...row({ text: 'tests pass on my side\nmerging now', origin: { kind: 'peer-send-message' }, from: { name: 'bob.otter-4821' } }), surface })
    expect(await texts(ui)).toEqual(["bob's Claude: tests pass on my side", '  │ merging now'])
    await ui.unmount()
  }
})

test('a sub-human prompt draws its chat lines and leaves the (for Claude) lines out', async $ => {
  const text = 'bob: sure, once we agree\n  │ on the schema\ncarol joined\n(for Claude) room now: no proposals'
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...row({ text, origin: { kind: 'plugin', name: 'sub-human' } }), surface })
    expect(await texts(ui)).toEqual(['bob: sure, once we agree', '  │ on the schema', 'carol joined'])
    await ui.unmount()
  }
})

test('expanded (ctrl+o), another plugin, a sender that is no seat, a notification: the engine draws its own row', async ($, on) => {
  // the engine's own row, beneath the plugins
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return h(Text, { key: 'engine' }, e.props.text) })
  const cases = [
    { text: 'hi', origin: { kind: 'peer' }, from: { name: 'bob.otter-4821' }, isExpanded: true },
    { text: 'hi', origin: { kind: 'plugin', name: 'other' } },
    { text: 'hi', origin: { kind: 'peer' }, from: { name: 'Some session' } },
    { text: 'Monitor event: "sub-human room"', origin: { kind: 'task-notification' }, task: { id: 't1', status: 'running' } },
    { text: '(for Claude) only for the model', origin: { kind: 'plugin', name: 'sub-human' } },
  ]
  for (const surface of SURFACES) {
    for (const props of cases) {
      const ui = await $.ui.mount({ ...row(props), surface })
      expect(await texts(ui)).toEqual([props.text])
      await ui.unmount()
    }
  }
})
