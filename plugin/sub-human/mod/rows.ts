/**
 * plugin/sub-human/mod/rows.ts: the room row's hooks. The row (agents/room.md) is the module's own: mod/deliver.ts
 * spawns it ($.agent.spawn, at a main-loop turn's start) and notes its id here (noteRow); the model is offered it only for
 * the auto-mode fallback's one Agent call (offerRow).
 *   - agent.offer sub-human:room: not offered to the model, so no Agent call of the model's spawns a row (and no
 *     "Backgrounded agent" block, no hand-back turn of one: cc CONTRACT module-agent-spawn-quiet), except while
 *     mod/deliver.ts's fallback asks for that one call (auto mode refused the module's spawn: offerRow).
 *   - classic.SubagentStop: node row-hold for the room row in a seated (or unsure) session (a row that gave up is told
 *     to hold again; its block continues it).
 *   - session.receive / prompt.submit: the row's hand-back (its final report, "left" or "error", which Claude Code
 *     delivers to the main conversation as a message of its own) and its "finished" task notification are taken: a row
 *     ending starts no model turn (stage 8e I.2: "Still in room" after a leave). The row's id is noted as it is
 *     spawned; a hand-back whose report is the row's last word (`left`, `error`) is the row's too, also one this
 *     process never saw spawned (the agent view's fork, or a reload). A local agent's hand-back and notification come
 *     as prompts, so the drop is what takes them; its warning row says nothing (session.append: QUIET_ROW, "row closed"
 *     to the debug log) in place of Claude Code's "Prompt dropped by a hook: …" frame. No hook ends them without a row.
 * Failure: each .catch passes the event on as it is: the row never disturbs the session.
 */
import { shimArgv, shimEnv, toClassic, SHIM_TIMEOUT_MS } from './core/shim.ts';
import { rowsNeeded } from './core/prefilter.ts';
import { mergeClassic } from './core/prompt.ts';
import { handbackFrom, finishedFrom, rowReportFrom, rowEndedRow, ROW_ENDED, ROOM_AGENT } from './core/rows.ts';
import { asHello } from './core/state.ts';
import type { EngineInterface, On } from 'claude-code';

const HELLO = { plugin: 'sub-human', key: 'hello' } as const;

async function needed($: EngineInterface, sid: unknown, agentType: unknown): Promise<boolean> {
  const { value } = await $.state.get(HELLO);
  return rowsNeeded(asHello(value), sid, agentType);
}

/** The room rows this process spawned (module state: a reload forgets them, and their hand-back is then known by its
 * last word alone). */
const rowAgents = new Set<string>();
/** mod/deliver.ts: the room row it just spawned, or the one the model's own Agent call started. */
export const noteRow = (id: string): void => { rowAgents.add(id); };
/** Whether the model is offered the room row now: only while mod/deliver.ts's fallback asks it for the Agent call
 * (auto mode refused the module's own spawn: mod/core/rows.ts rowFallback); never otherwise. */
let offering = false;
export const offerRow = (on: boolean): void => { offering = on; };
/** mod/consent.ts: the fallback asks for the call now (its rows are then drawn as nothing). */
export const rowOffered = (): boolean => offering;
/** The row agent a delivery is the hand-back of, or null: one this process spawned, or one whose report is the row's
 * last word (a fork's or a reload's row, never seen spawned here: its "finished" notification is then taken too). */
const rowHandback = (text: unknown): string | null => {
  const id = handbackFrom(text);
  if (id && rowAgents.has(id)) return id;
  const row = rowReportFrom(text);
  if (row) rowAgents.add(row);
  return row;
};
/** The row agent a task notification says finished, or null (live: after the hand-back, it started the turn). */
const rowFinished = (text: unknown): string | null => { const id = finishedFrom(text); return id && rowAgents.has(id) ? id : null; };

export function registerRows(on: On): void {
  // the row is the module's: the model never spawns one (the module's own $.agent.spawn is no offer), but for the
  // fallback's one call while it asks for it
  on('agent.offer', { agent: ROOM_AGENT }, () => ({ isOffered: offering }))
    .catch(() => ({ isOffered: false })); // never offered, even past a failure

  // a row's hand-back is no turn: taken before it is queued, or dropped as a prompt where it was not
  on('session.receive', { origin: [{ kind: 'peer' }, { kind: 'task-notification' }] }, (_$, e, next) => {
    const id = e.origin.kind === 'peer' ? rowHandback(e.text) : e.origin.kind === 'task-notification' ? rowFinished(e.text) : null;
    if (id && e.origin.kind === 'task-notification') rowAgents.delete(id);
    return id ? { consumed: ROW_ENDED } : next(e); // taken quietly: nothing queued, shown or read
  }).catch((_$, e, next) => next(e));
  on('prompt.submit', { origin: [{ kind: 'peer' }, { kind: 'task-notification' }] }, (_$, e, next) => {
    // the hand-back first (the agent id stays noted: its "finished" notification follows), then that notification
    if (e.origin && e.origin.kind === 'peer' && rowHandback(e.text)) return { drop: ROW_ENDED };
    const done = e.origin && e.origin.kind === 'task-notification' ? rowFinished(e.text) : null;
    if (!done) return next(e);
    rowAgents.delete(done);
    return { drop: ROW_ENDED };
  }).catch((_$, e, next) => next(e));
  // that drop's warning row, "Prompt dropped by a hook: sub-human: row ended, nothing to do", says nothing (ROW_CLOSED,
  // cc CONTRACT session-append-notice-rewrite): no hook takes a local agent's hand-back or notification without a row,
  // and a rewrite keeps the row (a warning, at least one character); "row closed" goes to the debug log
  on('session.append', { door: 'notice' }, ($, e, next) => {
    const row = rowEndedRow(e.message);
    if (row) $.ui.log('rows: row closed', { to: 'debug' });
    return next(row ? { ...e, message: row } : e);
  }).catch((_$, e, next) => next(e)); // a failure keeps the engine's words

  on('classic.SubagentStop', async ($, e, next) => {
    if (!(await needed($, e.session_id, e.agent_type))) return next(e);
    const root = $.plugin.root;
    const run = await $.process.run(shimArgv(root, 'row-hold'), { stdin: JSON.stringify(e), env: shimEnv(e, root), timeoutMs: SHIM_TIMEOUT_MS });
    return mergeClassic(toClassic('SubagentStop', run).result, await next(e));
  }).catch((_$, e, next) => next(e));
}
