/**
 * plugin/sub-human/mod/deliver.mjs: the room's delivery through the hooks module (docs/next/MODS-PLAN.md Part 2b,
 * W3 M7). A child `node bin/sub-human tail --ndjson` (lib/tail.js) follows the seat's room for the session's life
 * and writes events; this file routes them (mod/core/deliver.mjs route):
 *   chat   -> $.ui.log: the person sees people's words, joins and leaves as dim rows; no model turn (D3)
 *   pull   -> $.session.append (user, isMeta): the model reads it with its next request; no wake. At most once (D8)
 *   wake   -> idle: $.prompt.submit (origin plugin sub-human); mid-turn (a turn.start with no turn.complete yet):
 *             the isMeta append plus $.ui.log of its visible lines, and at that turn's end a $.prompt.submit after
 *             all when no main-loop tool call finished after the row (classic.PostToolUse / PostToolUseFailure, observed
 *             here; no agent_id): the model's request
 *             then in flight was its last and never carried the row
 *   rows   -> $.state rows, attached as context to the person's next prompt (prompt.submit, typed origins)
 *   health -> $.ui.log plus the append
 * While the child follows this session's seat (its `seat` event), the tail holds the seat's delivery lease
 * (delivery-NAME), so the Monitor's tail stays silent and at-room skips its digest, notices and row calls.
 *
 * The child starts on session.start (a reload or a lost worker runs it again), after the join
 * (classic.UserPromptExpansion /sub-human) and after classic.SessionStart (a /clear runs on under a new session
 * id: the old child is stopped at session.end, the new one started here). It is not started when the hello says
 * the session surely has no seat. A child that exits is started again after restartDelay (1 s doubling to 60 s).
 * It dies with the module (a reload, the session's end): $.process.spawn's loop is its life.
 *
 * The session's lifecycle is here too (one file per event: validate refuses a second unmatched session.start):
 * on session.start the mod runs node hooks/mod-hello.js with {session_id}; mod-hello writes the module's lease and
 * prints {home, realHome, userHome, pluginRoot, seat}, kept in $.state hello, and runs it again after the join and
 * after classic.SessionStart. A refresh that fails keeps the last hello but marks it as no session's (sid null), so
 * every prefilter runs node until a refresh succeeds: a join whose hello failed must not leave "no seat" looking
 * certain. session.start and a classic SessionStart also set reviewMaybeOpen (mod/consent.mjs): unsure until
 * consent says.
 *
 *   delivering(sid) -> bool     the child follows a seat for this session id (mod/prompt.mjs skips node on it)
 */
import { tailArgv, tailEnv, lineBuffer, parseEvent, route, unread, restartDelay, spawnWanted } from './core/deliver.mjs';
import { parseHello } from './core/seat.mjs';
import { shimArgv, shimEnv, SHIM_TIMEOUT_MS } from './core/shim.mjs';

const ROWS = { plugin: 'sub-human', key: 'rows' };
const HELLO = { plugin: 'sub-human', key: 'hello' };
const REVIEW = { plugin: 'sub-human', key: 'reviewMaybeOpen' };

/** Run hooks/mod-hello.js for sid and keep its answer in $.state (only a good answer replaces the last one). */
async function sayHello($, sid) {
  const root = $.plugin.root;
  const run = await $.process.run(shimArgv(root, 'mod-hello.js'), {
    stdin: JSON.stringify({ session_id: sid }),
    env: shimEnv({ session_id: sid }, root),
    timeoutMs: SHIM_TIMEOUT_MS,
  });
  const hello = run.exitCode === 0 ? parseHello(run.stdout, sid) : null;
  if (hello) await $.state.set(HELLO, hello);
  return hello;
}

/** After a refresh failed: keep the last hello for the guard's home, but as no session's (prefilters run node). */
async function forgetSession($) {
  const { value } = await $.state.get(HELLO);
  if (value && typeof value === 'object' && value.sid !== null) await $.state.set(HELLO, { ...value, sid: null });
}

/** mod-hello for sid; when it fails, forgetSession. */
async function refresh($, sid) {
  let hello = null;
  try { hello = await sayHello($, sid); } catch { /* below */ }
  if (!hello) await forgetSession($);
}


/** The current child: {sid, seat, stream, stopped}; null before the first start. Module state: a reload loses it
 * together with the child itself. */
let child = null;
/** The running main-loop turn's id, or null (idle, or unknown after a reload: then a wake is submitted, which
 * waits for idle anyway). */
let running = null;
/** Wakes appended mid-turn in the running turn ({text, at}), checked at its end. */
let midTurn = [];
/** When the main loop's last tool call finished (Date.now()): a model request follows each one. */
let lastToolDone = 0;

export const delivering = sid => !!(child && !child.stopped && child.sid === sid && child.seat);

const userRow = text => ({ message: { type: 'user', content: [{ type: 'text', text }] } });

function stopChild(sid) {
  const c = child;
  if (!c || (sid !== undefined && c.sid !== sid)) return;
  c.stopped = true;
  c.seat = null;
  child = null;
  try { if (c.stream) void c.stream.return(undefined).catch(() => {}); } catch { /* already gone */ }
}

/** Start the child for sid unless it already runs for it; stops one for another session id. */
function ensureChild($, sid) {
  if (typeof sid !== 'string' || !sid) return;
  if (child && !child.stopped && child.sid === sid) return;
  if (child) stopChild();
  const c = { sid, seat: null, stream: null, stopped: false, fails: 0 };
  child = c;
  void runChild($, c);
}

/** The child's loop: spawn, route each line, and on exit start again after the backoff (until stopped). Never
 * throws: it runs after the hook that started it returned, where nothing would handle a rejection. */
async function runChild($, c) {
  const root = $.plugin.root;
  const now = () => $.clock.now().catch(() => 0);
  while (!c.stopped && child === c) {
    const started = await now();
    try {
      const stream = $.process.spawn({ argv: tailArgv(root), env: tailEnv(c.sid, root) });
      c.stream = stream;
      const lines = lineBuffer();
      for await (const piece of stream) {
        if (c.stopped || child !== c) break;
        if (piece.stream !== 'stdout') continue;
        for (const line of lines.push(piece.text)) {
          try { await apply($, c, parseEvent(line)); } catch { /* one event lost; the next goes on */ }
        }
      }
    } catch { /* could not start, or the loop failed: retried below */ }
    c.seat = null;
    c.stream = null;
    if (c.stopped || child !== c) return;
    c.fails = (await now()) - started > 60_000 ? 0 : c.fails + 1;
    try {
      await new Promise((resolve, reject) => { try { $.clock.after(restartDelay(c.fails - 1), resolve); } catch (err) { reject(err); } });
    } catch {
      // no timer here: give up; the next session.start, join or SessionStart starts a child again
      if (child === c) child = null;
      return;
    }
  }
}

/** classic.PostToolUse / PostToolUseFailure: note when a main-loop tool call finished (no agent_id). */
function toolDone($, e, next) {
  if (!e.agent_id) lastToolDone = Date.now();
  return next(e);
}

async function heldRows($) {
  const { value } = await $.state.get(ROWS);
  return typeof value === 'string' && value ? value : null;
}

/** One event's actions (mod/core/deliver.mjs route). */
async function apply($, c, ev) {
  if (!ev || c.stopped) return;
  const role = c.seat && c.seat.role === 'orch' ? 'orch' : 'member';
  const actions = route(ev, { turnRunning: running !== null, role, rows: ev.type === 'wake' && role === 'orch' ? await heldRows($) : null });
  for (const a of actions) {
    switch (a.do) {
      case 'seat': c.seat = a.seat; break;
      case 'log': $.ui.log(a.text); break;
      case 'append': await $.session.append(userRow(a.text)); break;
      case 'hold-rows': await $.state.set(ROWS, a.text); break;
      case 'submit': void $.prompt.submit({ text: a.text }).catch(() => {}); break;
      case 'mid-turn-wake': {
        const r = await $.session.append(userRow(a.text)).catch(() => null);
        if (r && !r.deny && running !== null) midTurn.push({ text: a.text, at: Date.now() });
        else void $.prompt.submit({ text: a.text }).catch(() => {});
        break;
      }
      default: break;
    }
  }
}

/** @param {import('claude-code').On} on */
export function registerDeliver(on) {
  on('session.start', async ($, e, next) => {
    try {
      const sid = await $.session.id();
      await $.state.set(REVIEW, true);
      await refresh($, sid);
      const { value: hello } = await $.state.get(HELLO);
      if (spawnWanted(hello && typeof hello === 'object' ? hello : null)) ensureChild($, sid);
    } catch { /* unknown: the guard keeps its string rules; the Monitor delivers meanwhile */ }
    return next(e);
  });

  // after a join (hooks/join.js beneath): hello for the new seat; the child looks it up itself
  on('classic.UserPromptExpansion', { command_name: /^(sub-human:)?sub-human$/ }, async ($, e, next) => {
    const r = await next(e);
    try { await refresh($, e.session_id); } catch { /* the next refresh tries again */ }
    try { ensureChild($, e.session_id); } catch { /* next start tries again */ }
    return r;
  }).catch(($, e, next) => next(e)); // never in the join's way: what ran beneath stands, or runs

  // a /clear (new session id), compact or resume: session-restore beneath rebinds the seat first
  on('classic.SessionStart', { source: ['clear', 'compact', 'resume'] }, async ($, e, next) => {
    const r = await next(e);
    try { await $.state.set(REVIEW, true); await refresh($, e.session_id); } catch { /* the next refresh tries again */ }
    try {
      const { value: hello } = await $.state.get(HELLO);
      if (spawnWanted(hello && typeof hello === 'object' ? hello : null)) ensureChild($, e.session_id);
    } catch { /* the Monitor delivers meanwhile */ }
    return r;
  }).catch(($, e, next) => next(e));

  on('session.end', ($, e, next) => {
    stopChild(e.sessionId);
    return next(e);
  });

  on('turn.start', ($, e, next) => {
    running = e.turnId;
    midTurn = [];
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.turnId === running) {
      running = null;
      const waiting = midTurn;
      midTurn = [];
      // a wake appended while the turn's last request was already out was never read: submit it after all
      for (const text of unread(waiting, lastToolDone)) void $.prompt.submit({ text }).catch(() => {});
    }
    return next(e);
  });

  // observe: when a main-loop tool call finished (a model request follows it, carrying what was appended)
  on('classic.PostToolUse', toolDone).catch(($, e, next) => next(e));
  on('classic.PostToolUseFailure', toolDone).catch(($, e, next) => next(e));
}
