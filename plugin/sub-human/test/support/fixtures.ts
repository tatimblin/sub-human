// Recorded Claude Code payloads (test/fixtures/cc/<version>/, scripts/record-fixtures.ts) by name, typed against the
// typings. Tests build tool results from these, never by hand (docs/TESTING.md §8).
//
// Each loader is a checked cast: it checks the event, the tool or hook the name promises, and for a tool call the key
// fields of its input and (when not an error) its result (KEYS); the rest of the type is taken on trust, as what the
// real binary sent. The canary checks the fixtures against the typings.
import type {
  BuiltinToolName, PromptSubmitInput, PromptSubmitResult, SessionSendInput, SessionSendResult, ToolCallInput,
  ToolCallResult, ToolInfo, TurnCompleteInput, TurnCompleteResult,
  NotificationHookInput, SessionEndHookInput, SessionStartHookInput, UserPromptExpansionHookInput, UserPromptSubmitHookInput,
} from 'claude-code'
import * as v from '../../vendor/valibot.mjs'

/** The Claude Code version the fixtures were recorded with. */
export const CC_VERSION = '2.1.330'

const Obj = v.looseObject({})
const of = (x: unknown, k: string): unknown => (v.is(Obj, x) ? x[k] : undefined)
const isObj = (x: unknown): boolean => v.is(Obj, x)
const Entry = v.looseObject({ name: v.string(), event: v.string(), hook: v.optional(v.string()), input: v.optional(v.unknown()), result: v.optional(v.unknown()) })

const Index = v.object({
  version: v.string(),
  costUsd: v.number(),
  runs: v.array(v.object({ date: v.string(), sessions: v.array(v.string()), costUsd: v.number() })),
  gaps: v.array(v.string()),
  fixtures: v.record(v.string(), v.object({ event: v.string(), session: v.string(), tool: v.optional(v.string()), hook: v.optional(v.string()) })),
})

// the fields a recorded call of each tool must carry: in its input, and in its result's record when it is no error
const KEYS: Partial<Record<string, { input: string[], result: string[] }>> = {
  Edit: { input: ['file_path', 'old_string', 'new_string'], result: ['filePath', 'structuredPatch'] },
  Write: { input: ['file_path', 'content'], result: ['filePath', 'type'] },
  Bash: { input: ['command'], result: ['stdout', 'stderr'] },
  TaskCreate: { input: ['subject'], result: ['task'] },
  TaskUpdate: { input: ['taskId'], result: ['success', 'taskId'] },
  ExitPlanMode: { input: ['plan'], result: ['plan', 'filePath'] },
  AskUserQuestion: { input: ['questions'], result: ['questions', 'answers'] },
  SendMessage: { input: ['to', 'message'], result: ['success'] },
}
const has = (x: unknown, keys: readonly string[]): boolean => keys.every(k => of(x, k) !== undefined)

type Hooks = {
  SessionStart: SessionStartHookInput, SessionEnd: SessionEndHookInput, UserPromptSubmit: UserPromptSubmitHookInput,
  UserPromptExpansion: UserPromptExpansionHookInput, Notification: NotificationHookInput,
}
export type ToolFixture<T extends BuiltinToolName> = { input: Extract<ToolCallInput, { tool: T }>, result: ToolCallResult<T> }

/** A fixture file's text by name; under node, read beside this file. Tests elsewhere pass their own reader. */
export type Reader = (name: string) => string
const nodeReader: Reader = name => {
  const fs = process.getBuiltinModule('node:fs')
  return fs.readFileSync(new URL(`../fixtures/cc/${CC_VERSION}/${name}.json`, import.meta.url), 'utf8')
}

const entry = (name: string, event: string, read: Reader): v.InferOutput<typeof Entry> => {
  const e = v.parse(Entry, JSON.parse(read(name)))
  if (e.event !== event) throw new Error(`fixture ${name} is a ${e.event}, not a ${event}`)
  return e
}

/** Every fixture's name, event and tool or hook, from index.json. */
export function fixtureIndex(read: Reader = nodeReader): v.InferOutput<typeof Index> {
  return v.parse(Index, JSON.parse(read('index')))
}

/** A recorded tool.call: the input as the hook saw it, and what `next(e)` resolved to. */
export function toolFixture<T extends BuiltinToolName>(name: string, tool: T, read: Reader = nodeReader): ToolFixture<T> {
  const e = entry(name, 'tool.call', read)
  const keys = KEYS[tool] ?? { input: [], result: [] }
  const input = v.parse(v.custom<Extract<ToolCallInput, { tool: T }>>(x => of(x, 'tool') === tool && has(x, keys.input), `not a ${tool} call with ${keys.input.join(', ')}`), e.input)
  const answered = (x: unknown): boolean => of(x, 'isError') === true || has(of(x, 'result'), keys.result)
  const result = v.parse(v.custom<ToolCallResult<T>>(x => typeof of(x, 'deny') === 'string' || (of(x, 'result') !== undefined && answered(x)), `not a ${tool} result with ${keys.result.join(', ')}`), e.result)
  return { input, result }
}

/** A recorded session.send: the send as the hook saw it, and whether it was delivered. */
export function sendFixture(name: string, read: Reader = nodeReader): { input: SessionSendInput, result: SessionSendResult } {
  const e = entry(name, 'session.send', read)
  const input = v.parse(v.custom<SessionSendInput>(x => typeof of(x, 'to') === 'string' && typeof of(x, 'text') === 'string'), e.input)
  const result = v.parse(v.custom<SessionSendResult>(x => typeof of(x, 'isDelivered') === 'boolean'), e.result)
  return { input, result }
}

/** A recorded prompt.submit. */
export function promptFixture(name: string, read: Reader = nodeReader): { input: PromptSubmitInput, result: PromptSubmitResult } {
  const e = entry(name, 'prompt.submit', read)
  const input = v.parse(v.custom<PromptSubmitInput>(isObj), e.input)
  const result = v.parse(v.custom<PromptSubmitResult>(isObj), e.result)
  return { input, result }
}

/** A recorded turn.complete. */
export function turnFixture(name: string, read: Reader = nodeReader): { input: TurnCompleteInput, result: TurnCompleteResult } {
  const e = entry(name, 'turn.complete', read)
  const input = v.parse(v.custom<TurnCompleteInput>(x => typeof of(x, 'isAborted') === 'boolean'), e.input)
  const result = v.parse(v.custom<TurnCompleteResult>(isObj), e.result)
  return { input, result }
}

/** A recorded `$.tool.list()` answer. */
export function toolListFixture(name: string, read: Reader = nodeReader): ToolInfo[] {
  const e = entry(name, 'tool.list', read)
  return v.parse(v.array(v.custom<ToolInfo>(x => typeof of(x, 'name') === 'string')), e.result)
}

/** A recorded command hook's stdin. */
export function hookFixture<H extends keyof Hooks>(name: string, hook: H, read: Reader = nodeReader): Hooks[H] {
  const e = entry(name, 'hook', read)
  return v.parse(v.custom<Hooks[H]>(x => of(x, 'hook_event_name') === hook, `not a ${hook} hook`), e.input)
}
