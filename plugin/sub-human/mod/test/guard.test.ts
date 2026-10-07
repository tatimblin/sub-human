// Wiring: the in-process store guard (mod/guard.mjs). Run with `npm run test:mods`.
// The verdict tables are tested in node (test/hooks/guard.test.js, security.test.js); this checks the hooks: what
// each denies through $.tool.call, the realPath walk through $.fs.stat, the tool.check allow, and the .catch.
import { test, expect } from 'claude-code/testing'
import { OUT, ran, session, start } from './support.mjs'

const HOME = OUT.home
/** Links on this fake disk: a path under a key resolves under its value. */
const LINKS: Record<string, string> = { '/tmp/link': HOME, '/w': '/w' }
const EXISTS = new Set(['/', '/u', HOME, `${HOME}/rooms`, '/tmp', '/tmp/link', '/tmp/link/rooms', '/w'])

/** The engine beneath the plugin: a session, a disk with one link into the store, and a tool that runs. */
function world(on: any, { cwd = true } = {}) {
  const ran_: string[] = []
  session(on, 'sid-g')
  on('session.cwd', () => (cwd ? { value: '/w' } : { deny: 'no cwd here' }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('process.run', () => ran(JSON.stringify(OUT)))
  on('fs.stat', ($: any, e: any) => {
    if (!EXISTS.has(e.path)) return { deny: 'ENOENT' }
    const link = Object.keys(LINKS).find(l => e.path === l || e.path.startsWith(l + '/'))
    const realPath = link ? LINKS[link] + e.path.slice(link.length) : e.path
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: !!link && link !== '/w', ...(e.resolve ? { realPath } : {}) } }
  })
  on('tool.call', ($: any, e: any) => { ran_.push(e.tool); return { result: 'ran', text: 'ran' } })
  return ran_
}
/** session.start: the module runs mod-hello and keeps the home and seat. */
const hello = ($: any) => start($, false)
const call = ($: any, input: any) => $.tool.call(input)
/** A guard's deny: the call resolves { deny } (or, as a session sees it, errored with the reason as text). */
const denied = (r: any) => /ROOM-GUARD|sub-human: hold/.test(String(r.deny ?? (r.isError ? r.text : '')))

test('Bash: a command that names the store is denied, before and after mod-hello; other commands run', async ($, on) => {
  const before = world(on)
  expect(denied(await call($, { tool: 'Bash', command: 'cat ~/.sub-human/rooms/x/log.jsonl' }))).toBe(true)
  expect(denied(await call($, { tool: 'Bash', command: 'SUB_HUMAN_HOME=/tmp/x sub-human read' }))).toBe(true)
  expect(denied(await call($, { tool: 'Bash', command: 'npm test' }))).toBe(false)
  expect(before).toEqual(['Bash'])
})

test('Bash: a custom home is protected by its path once mod-hello said it; the read-only CLI runs', async ($, on) => {
  const r = world(on)
  await hello($)
  expect(denied(await call($, { tool: 'Bash', command: `echo x >> ${HOME}/rooms/a/log.jsonl` }))).toBe(true)
  expect(denied(await call($, { tool: 'Bash', command: 'cat "$HOME/.sub-human/keys/a/bob.key"' }))).toBe(true)
  expect(denied(await call($, { tool: 'Bash', command: "node -e \"require('/x/sub-human/lib/room.js')\"" }))).toBe(true)
  expect(denied(await call($, { tool: 'Bash', command: 'sub-human read' }))).toBe(false)
  expect(r).toEqual(['Bash'])
})

test('Write: into the store, through a symlink to it, or via ~ is denied; elsewhere it runs', async ($, on) => {
  const r = world(on)
  await hello($)
  expect(denied(await call($, { tool: 'Write', file_path: `${HOME}/rooms/x/log.jsonl`, content: 'x' }))).toBe(true)
  expect(denied(await call($, { tool: 'Write', file_path: '/tmp/link/rooms/new.json', content: 'x' }))).toBe(true)
  expect(denied(await call($, { tool: 'Write', file_path: '/tmp/link/rooms/deeper/new.json', content: 'x' }))).toBe(true)
  expect(denied(await call($, { tool: 'Edit', file_path: '~/.sub-human/rooms/x/members.json', old_string: 'a', new_string: 'b' }))).toBe(true)
  expect(denied(await call($, { tool: 'Write', file_path: '/w/app.js', content: 'x' }))).toBe(false)
  expect(denied(await call($, { tool: 'Write', file_path: 'notes.md', content: 'x' }))).toBe(false)
  expect(r).toEqual(['Write', 'Write'])
})

test('Write: before mod-hello, a path through .sub-human is denied by its spelling', async ($, on) => {
  world(on)
  expect(denied(await call($, { tool: 'Write', file_path: '/u/.sub-human/rooms/x', content: 'x' }))).toBe(true)
  expect(denied(await call($, { tool: 'Write', file_path: '/w/.sub-human-notes.md', content: 'x' }))).toBe(false)
})

test('a guard that fails denies only a call that mentions sub-human', async ($, on) => {
  world(on, { cwd: false }) // a relative path needs the cwd: the hook throws
  await hello($)
  expect(denied(await call($, { tool: 'Write', file_path: 'notes/sub-human/x.md', content: 'x' }))).toBe(true)
  expect(denied(await call($, { tool: 'Write', file_path: 'notes/x.md', content: 'x' }))).toBe(false)
})

test('hold is denied to the main thread', async ($, on) => {
  const r = world(on)
  await hello($)
  const res: any = await call($, { tool: 'mcp__plugin_sub-human_room__hold', member: 'bob' })
  expect(denied(res)).toBe(true)
  expect(String(res.deny ?? res.text)).toMatch(/hold is for row agents only/)
  expect(r).toEqual([])
})

test('tool.check: the room tools are allowed for a seated session, hold never from the main thread', async ($, on) => {
  world(on)
  await hello($)
  expect((await $.tool.check({ tool: 'mcp__plugin_sub-human_room__post', input: { text: 'hi' } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'mcp__plugin_sub-human_room__hold', input: {} })).decision).toBe('deny')
  expect((await $.tool.check({ tool: 'mcp__other__post', input: {} })).decision).toBe('ask')
})
