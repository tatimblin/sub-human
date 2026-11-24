// The person's side of the plan tests: plan approval as Claude Code reports it (the recorded ExitPlanMode result, its
// plan text swapped), the native question card answered from a script, the plan pane, and the records R19 is
// checked on: every file write, every config change, and every tool the module itself called.
import type { On } from 'claude-code'
import * as v from '../../vendor/valibot.mjs'
import { toolFixture, turnFixture } from './fixtures.js'
import { kitReader } from './kit-fixtures.js'

export const EXIT = toolFixture('tool-exit-plan-mode', 'ExitPlanMode', kitReader)
const RECORDED = v.parse(v.looseObject({ result: v.looseObject({ plan: v.string(), filePath: v.string() }), text: v.string() }), EXIT.result)
const APPROVED = RECORDED.result
/** My main turn ending: the idle moment a review card takes. */
export const TURN = turnFixture('turn-complete-plan', kitReader).input
export const PANE = { title: 'plan', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } as const
export const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const

const Asked = v.looseObject({
  questions: v.tuple([v.looseObject({ question: v.string(), header: v.optional(v.string()), multiSelect: v.optional(v.boolean()), options: v.array(v.looseObject({ label: v.string() })) })]),
})

export interface Card { readonly question: string; readonly options: readonly string[]; readonly multiSelect: boolean }

export interface PlanWorld {
  /** The plan text the next approval carries. */
  plan: string
  /** Every card the module asked, in order. */
  readonly asked: Card[]
  /** The answers the next cards get, in order: a label, typed text, or null for a dismissed card. */
  answer(...picks: (string | null)[]): void
  readonly opened: string[]
  readonly closed: string[]
  /** The person closes the pane `id` with Esc: no `ui.close` call, it is just gone from `$.ui.panes()`. */
  escape(id: string): void
  /** R19: every file the module wrote, every config row it set, and every tool it called itself. */
  readonly writes: string[]
  readonly configs: string[]
  readonly tools: string[]
}

/** The plan file Claude Code wrote at approval: the person's own, which nothing here may write. */
export const PLAN_FILE: string = APPROVED.filePath

/**
 * Registers the stubs (before any `$` call): `branch` is what the working copy reports, `isAgent` marks the approval a
 * subagent's, `placed: false` has every pane open refused.
 */
export function planWorld(on: On, o: { branch?: string; isAgent?: boolean; placed?: false } = {}): PlanWorld {
  const picks: (string | null)[] = []
  const open = new Set<string>()
  const w: PlanWorld = { plan: APPROVED.plan, asked: [], answer: (...p) => { picks.push(...p) }, escape: id => { open.delete(id) }, opened: [], closed: [], writes: [], configs: [], tools: [] }
  on('tool.call', (_, e) => {
    if (e.tool === 'ExitPlanMode') return { result: { ...APPROVED, plan: w.plan, ...(o.isAgent && { isAgent: true }) }, text: RECORDED.text }
    w.tools.push(e.tool)
    if (e.tool !== 'AskUserQuestion') return { isError: true, result: null, text: `no ${e.tool} in this test` }
    const asked = v.parse(Asked, e).questions
    const q = asked[0]
    w.asked.push({ question: q.question, options: q.options.map(x => x.label), multiSelect: q.multiSelect === true })
    const pick = picks.shift()
    if (pick === undefined) throw new Error(`no answer scripted for "${q.question}"`)
    if (pick === null) throw new Error('dismissed')
    return { result: { questions: asked, answers: { [q.question]: pick } }, text: `answered ${pick}` }
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('ui.open', (_, e) => { w.opened.push(e.id); if (o.placed !== false) open.add(e.id); return { value: o.placed === false ? { isPlaced: false, reason: 'too narrow' } : { isPlaced: true } } })
  on('ui.close', (_, e) => { w.closed.push(e.id); open.delete(e.id); return { value: undefined } })
  // the panes still open: each placed open until its close (a test closes one with Esc by `w.escape`)
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) }))
  on('fs.write', (_, e) => { w.writes.push(e.path); return { value: undefined } })
  on('config.set', (_, e) => { w.configs.push(JSON.stringify(e)); return { deny: 'no config in this test' } })
  on('vcs.detect', (_, e) => (o.branch === undefined ? null : { vcs: 'git', root: e.path, mainRoot: null, revision: null, branch: o.branch, defaultBranch: 'main', remote: null }))
  return w
}
