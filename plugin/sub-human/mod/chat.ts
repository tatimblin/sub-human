/**
 * plugin/sub-human/mod/chat.ts: the room row as the room's chat (0.8.0, the gated feature room-chat; its pure parts
 * in mod/core/room-chat.ts). mod/deliver.ts roomRow spawns the row (sub-human:room named the room code, prompt
 * "chat: CODE"), or wakes the one kept here with a send, and sends it the room's lines; this file answers its steps
 * and draws it. What the two share is the module state below (`chat`): a `$` stays in the file whose hook holds it.
 *   - turn.step of the row, matched by its stored agent id, never its type (a /clear re-lists it as
 *     general-purpose): no model. Its first step starts its keeper (Agent sub-human:keeper, background; in auto mode
 *     the row's own model makes that call, cc CONTRACT turn-step-answer-subagent), at most KEEPER_MAX in
 *     KEEPER_WINDOW_MS (a keeper that ended on a WAKE is not counted), and once per turn of the row (a later step of
 *     that turn never asks again; mod/consent.ts refuses a second keeper call while one lives); then it answers with
 *     the lines waiting for it: the person's ("you: …", posted first) and the
 *     room's ("maya: …"), else "·" (drawn as nothing). A row no longer wanted (a /clear's old one: its keeper's hold
 *     was taken over; another room's; a seat that left) ends with no keeper.
 *   - turn.step of a keeper: its first step is the blocking hold ({room, take}, and wake for a row main's model
 *     started, which no send may reach: mod/core/room-chat.ts keeperHold); once it returns the keeper ends ("left"),
 *     and the row's notification turn starts another (after a WAKE it first waits, up to 3 s, for the lines the hold
 *     saw to come through the tail). A hold that did not run (auto mode denies a
 *     synthesized call with no allow rule) goes to the keeper's model, at most KEEPER_MAX times.
 *   - session.append door prompt of the row: a typed line (origin composer, typedText) waits for the row's step,
 *     which posts the person's exact words through node at-room (via=human, signed: the @room path); the row's user
 *     rows (the typed ❯ line and the module's sends, by their text: each is drawn under a uuid no append reports; the
 *     spawn prompts and the keeper's notifications, by uuid) are drawn as nothing. door response: the uuids of the
 *     row's lines. The row's own "Waiting for 1 background agent" (its TurnDuration) and main's have no row the module
 *     can tell apart, so both stay.
 *   - ui.render AssistantMessage of those uuids: drawn as the room line it is (drawLine: no bullet, the author bold).
 *     One drawn on screen: the person opened the row, its unread count starts over.
 *   - ui.render UserMessage, ToolUse, ToolResult of the rows above and the keeper's call: nothing.
 * Failure: each .catch passes the event on (a row step to its model, which can only start the keeper).
 */
import { typedText, postNote, keeperCall, keeperHold, keeperStep, ended, woken, rowStatus, drawLine, KEEPER_AGENT, KEEPER_MAX } from './core/room-chat.ts';
import { shimArgv, shimEnv, toClassic, SHIM_TIMEOUT_MS } from './core/shim.ts';
import { asNonce } from './core/state.ts';
import { ROOM_AGENT } from './core/rows.ts';
import { facts, statusPinned } from './deliver.ts';
import type { AgentInfo, EngineInterface, On, RenderElement, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code';

const NONCE = { plugin: 'sub-human', key: 'nonce' } as const;
const HOLD = 'mcp__plugin_sub-human_room__hold';
/** An empty drawing: the row is not drawn at all. */
const EMPTY: RenderElement = { type: 'Box', props: {}, children: [] };
/** A step's text when nothing waits: some text the engine takes as an answer (an empty one asks again), drawn as nothing. */
export const NOTHING = '·';
/** How long (in 100 ms) a woken row waits for the lines it woke for. */
const WAKE_WAIT_STEPS = 30;
/** A row agent's spawn prompt: the row's ("chat: CODE") or its keeper's ("keep: CODE"). */
const SPAWN_PROMPT = /^(?:chat|keep): \S+$/;
/** The origins of the row's own ❯ rows: the person's typing, the module's sends. */
const ECHO = new Set(['composer', 'coordinator']);

/** The room row as this process knows it (module memory; mod/deliver.ts keeps its id per session id in $.store). */
export const chat: {
  /** the row answered now: its session id, room and agent id; wake: main's model started it, so it is woken by its
   * keeper's end (keeperHold), never by a send */
  row: { sid: string; code: string; id: string; wake?: true } | null;
  /** the keeper ended on a WAKE: its next spawn is no death (not counted), and the lines it woke for may be a moment
   * behind (the tail's batch) */
  woke: boolean;
  /** the row's turn that asked for its keeper last */
  keeperTurn: string | null;
  /** rows no longer wanted: their next step ends them, with no keeper */
  gone: Set<string>;
  /** what the row's next text step draws, in order: a typed line (posted then) or a room line */
  waiting: ({ typed: string } | { line: string })[];
  /** the uuids of the row's lines, and of its rows and calls drawn as nothing; the texts of its ❯ rows (a line typed
   * into it, a line sent to it: each drawn under a uuid no append reports, live 2.1.296), drawn as nothing too */
  lines: Set<string>;
  quiet: Set<string>;
  echo: Set<string>;
  /** the keeper spawns of the window (keeperStep), and the keeper holds handed to its model */
  keepers: number[];
  modelHolds: number;
  /** who else is here (the tail's here event), and the room lines drawn since the person last opened or typed in it */
  here: string;
  /** the row opened before who's here was known: the first here event draws it as the row's first line */
  rosterDue: boolean;
  unread: number;
} = { row: null, woke: false, keeperTurn: null, gone: new Set(), waiting: [], lines: new Set(), quiet: new Set(), echo: new Set(), keepers: [], modelHolds: 0, here: '', rosterDue: false, unread: 0 };

/** The status line under main's prompt, or undefined (no row). */
export const chatStatus = (): string | undefined => (chat.row ? rowStatus(chat.row.code, chat.here, chat.unread) : undefined);
/** A row id of this file's (mod/consent.ts: its Agent call is drawn as nothing, never denied). */
export const isChatRow = (id: unknown): boolean => typeof id === 'string' && (chat.row?.id === id || chat.gone.has(id));
export const quietCall = (id: string): void => { chat.quiet.add(id); };
/** The row's keeper runs (listed running, the row its parent). */
export const keeperOf = (list: readonly Pick<AgentInfo, 'type' | 'parentId' | 'status'>[], id: string): boolean =>
  list.some(a => a.type === KEEPER_AGENT && a.parentId === id && a.status === 'running');

const nowOf = ($: EngineInterface): Promise<number> => $.clock.now().catch(() => Date.now());
const autoMode = async ($: EngineInterface): Promise<boolean> => facts.of(await $.session.id()).permission_mode === 'auto';
/** The status line again, unless an invite's line holds it (mod/deliver.ts). */
function status($: EngineInterface): void { if (!statusPinned()) $.ui.status(chatStatus()); }

/** The person's typed line through node at-room (the @room path: via=human, signed with the seat key there), and
 * what the row says under it (null: sent). */
async function post($: EngineInterface, text: string): Promise<string | null> {
  const root = $.plugin.root, sid = await $.session.id();
  const nonce = asNonce((await $.state.get(NONCE)).value, sid);
  const run = await $.process.run(shimArgv(root, 'at-room'), {
    stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: await $.session.cwd(), prompt: `@room ${text}`, sub_human_origin: 'composer', ...(nonce ? { sub_human_nonce: nonce } : {}) }),
    env: shimEnv({ session_id: sid }, root),
    timeoutMs: SHIM_TIMEOUT_MS,
  }).catch(() => null);
  return postNote(run ? toClassic('UserPromptSubmit', run).result : {});
}

/** The lines waiting, as one answer (the typed ones posted now). */
async function drain($: EngineInterface): Promise<string> {
  const items = chat.waiting;
  chat.waiting = [];
  const out: string[] = [];
  for (const it of items) {
    if ('line' in it) { out.push(it.line); continue; }
    const note = await post($, it.typed);
    out.push(`you: ${it.typed}${note ? `\n${note}` : ''}`);
  }
  return out.join('\n');
}

/** A step answered with text, no model. */
async function* answer(e: TurnStepInput, text: string): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  yield { kind: 'text', index: 0, text };
  yield { kind: 'stop', stopReason: 'end_turn', usage: null };
  return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null };
}
let seq = 0;
/** A step answered with one tool call, no model; its rows are drawn as nothing. */
async function* call(e: TurnStepInput, name: string, input: unknown): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const id = `toolu_subhuman_${Date.now()}_${seq++}`;
  chat.quiet.add(id);
  yield { kind: 'tool', index: 0, id, name };
  yield { kind: 'input', index: 0, json: JSON.stringify(input) };
  yield { kind: 'stop', stopReason: 'tool_use', usage: null };
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name, input }], stopReason: 'tool_use', usage: null };
}

/** A ❯ row of the row's own (a line typed into it or sent to it), or a keeper's "finished" notification there (by the
 * call that started that keeper). */
const quietRow = (p: { text: string; origin: { kind: string }; task?: { toolUseId?: string } }): boolean =>
  (ECHO.has(p.origin.kind) && chat.echo.has(p.text)) || (p.origin.kind === 'task-notification' && !!p.task?.toolUseId && chat.quiet.has(p.task.toolUseId));
const textOf = (content: unknown): string => (Array.isArray(content)
  ? content.map((b: unknown) => (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? b.text : '')).join('')
  : '');

export function registerChat(on: On): void {
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId;
    if (id === undefined) return yield* next(e);
    const row = chat.row;
    if (isChatRow(id)) {
      if (!row || row.id !== id) return yield* answer(e, NOTHING); // no longer wanted: it ends, no keeper
      const woke = chat.woke;
      // one keeper call per turn of the row: a step after it (its result, a step the engine numbers 0 again) never asks
      // for another, even before the new keeper is listed
      if (chat.keeperTurn !== e.turnId && e.index === 0 && !keeperOf(await $.agent.list(), id)) {
        // a keeper that ended on a WAKE did its job: its successor is not counted against the cap
        const k = woke ? { spawn: true, times: chat.keepers } : keeperStep(chat.keepers, await nowOf($));
        if (k.spawn) {
          chat.keepers = k.times;
          chat.keeperTurn = e.turnId;
          if (await autoMode($)) return yield* next(e); // auto mode denies a synthesized call: the row's model makes it
          return yield* call(e, 'Agent', keeperCall(row.code));
        }
      }
      // woken by its keeper: the lines it woke for come through the tail a moment after the hold saw them
      for (let i = 0; woke && !chat.waiting.length && i < WAKE_WAIT_STEPS; i++) await $.clock.sleep(100);
      chat.woke = false;
      return yield* answer(e, (await drain($)) || NOTHING);
    }
    const me = (await $.agent.list()).find(a => a.id === id);
    if (!me || me.type !== KEEPER_AGENT) return yield* next(e);
    if (e.index === 0) {
      // a row not known yet is one main's model started (the fallback's call, noted once it returned): its room is the
      // row's name, and it is woken by this hold's end (keeperHold wake)
      const parent = row ? null : (await $.agent.list()).find(a => a.id === me.parentId && a.type === ROOM_AGENT);
      if (row) return yield* call(e, HOLD, keeperHold(row.code, row.wake));
      if (parent && parent.name) return yield* call(e, HOLD, keeperHold(parent.name, true));
    }
    const read = await $.session.messages({ agentId: id });
    // the hold's result (in auto mode Claude Code's hand-back contract nudges a plain "left" up to three times, each
    // nudge a step answered here: the hold's result is the last tool result, not the last message)
    const last = (Array.isArray(read) ? read : []).findLast(x => x.toolResults?.length)?.toolResults?.at(-1)?.text;
    if (woken(last)) chat.woke = true;
    // a hold that did not run (auto mode's deny of a synthesized call): the keeper's model makes it
    if (row && e.index > 0 && !ended(last) && chat.modelHolds < KEEPER_MAX && (await autoMode($))) { chat.modelHolds++; return yield* next(e); }
    return yield* answer(e, 'left');
  }).catch(async function* (_$, e, next) { return yield* next(e); });

  on('session.append', { door: ['prompt', 'response'] }, ($, e, next) => {
    const id = e.agentId, row = chat.row;
    if (id === undefined) return next(e);
    // the spawn prompts (the row's, before its id is known; the keeper's)
    if (e.door === 'prompt' && SPAWN_PROMPT.test(textOf(e.message.content))) chat.quiet.add(e.uuid);
    if (!row || id !== row.id) return next(e);
    if (e.door === 'response') { chat.lines.add(e.uuid); return next(e); }
    const kind = e.origin.kind;
    const typed = kind === 'composer' ? typedText(textOf(e.message.content)) : null;
    if (typed !== null) {
      chat.waiting.push({ typed });
      chat.echo.add(typed); // its ❯ row was drawn already: drawn again, as nothing
      $.ui.invalidate('ui.render');
      chat.unread = 0;
      status($);
    }
    if (kind === 'task-notification') chat.quiet.add(e.uuid); // its keeper's
    return next(e);
  }).catch((_$, e, next) => next(e));

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (!chat.lines.has(e.requestId)) return next(e);
    // drawn on screen: the person is in the row (the status line's count starts over, once this draw is done)
    if (chat.unread && e.props.onScreen !== null) { chat.unread = 0; try { $.clock.after(1, () => { status($); }); } catch { /* the next change says it */ } }
    return e.props.text.trim() === NOTHING ? EMPTY : drawLine(e.props.text);
  }).catch((_$, e, next) => next(e));

  on('ui.render', { component: ['UserMessage', 'ToolUse', 'ToolResult'] }, (_$, e, next) => (chat.quiet.has(e.requestId) || (e.component === 'UserMessage' && quietRow(e.props)) ? EMPTY : next(e)))
    .catch((_$, e, next) => next(e));
}
