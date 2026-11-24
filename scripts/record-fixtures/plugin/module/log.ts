// The recorder's logging module: every tool.call, session.send, prompt.submit and turn.complete it sees, with what
// the rest of the chain answered, as one JSON file in ../log beside the plugin's copy. It changes nothing it passes on.
// (The engine wants `$.fs.write(...)` spelled at each call site, so each hook writes its own entry.)
import type { On } from 'claude-code'

const run = Date.now().toString(36)
let n = 0

/** Where entry `event` goes and what it holds. */
const entry = (root: string, event: string, body: Record<string, unknown>): [string, string] => {
  n += 1
  return [`${root}/../log/m-${run}-${String(n).padStart(3, '0')}-${event}.json`, JSON.stringify({ event, ...body }, null, 2)]
}

export function register(on: On): void {
  let probed = false

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const [file, text] = entry($.plugin.root, 'tool.call', { input: e, result })
    await $.fs.write(file, text).catch(() => undefined)
    return result
  })
  on('session.send', async ($, e, next) => {
    const result = await next(e)
    const [file, text] = entry($.plugin.root, 'session.send', { input: e, result })
    await $.fs.write(file, text).catch(() => undefined)
    return result
  })
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    const [file, text] = entry($.plugin.root, 'prompt.submit', { input: e, result })
    await $.fs.write(file, text).catch(() => undefined)
    if (!probed) {
      probed = true
      // free shapes, no model: the session's tool list, and a send of the plugin's own (origin plugin), refused
      const tools = await $.tool.list().catch((err: unknown) => String(err))
      const [listFile, listText] = entry($.plugin.root, 'tool.list', { result: tools })
      await $.fs.write(listFile, listText).catch(() => undefined)
      await $.session.send({ to: 'nobody', text: 'recorder ping' }).catch(() => undefined)
    }
    return result
  })
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const [file, text] = entry($.plugin.root, 'turn.complete', { input: e, result })
    await $.fs.write(file, text).catch(() => undefined)
    return result
  })
}
