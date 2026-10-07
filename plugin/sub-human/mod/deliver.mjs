/**
 * plugin/sub-human/mod/deliver.mjs: the room's delivery through the hooks module (docs/next/MODS-PLAN.md Part 2b,
 * W3 M7). A child `node bin/sub-human tail --ndjson` (lib/tail.js) follows the seat's room for the session's life
 * and writes events; this file routes them (mod/core/deliver.mjs route):
 *   chat   -> $.ui.log: the person sees people's words, joins and leaves as dim rows; no model turn (D3)
 *   pull   -> $.session.append (user, isMeta): the model reads it with its next request; no wake. At most once (D8)
 *   wake   -> idle: $.prompt.submit (origin plugin sub-human); mid-turn (a turn.start with no turn.complete yet):
 *             the isMeta append plus $.ui.log of its visible lines, and at that turn's end a $.prompt.submit after
 *             all when no main-loop tool call finished after the row (classic.PostToolUse / PostToolUseFailure, no
 *             agent_id): the model's request then in flight was its last and never carried the row. A submit that
 *             is dropped or fails falls back to the append; a wake neither takes waits for the next turn.start
 *   rows   -> $.state rows, attached as context to the person's next prompt (prompt.submit, typed origins)
 *   health -> $.ui.log plus the append
 * The child is the seat's only delivery (D2: no Monitor): nothing else tells the person or the model what
 * happened in the room.
 *
 * The child starts on session.start (a reload or a lost worker runs it again), after the join
 * (classic.UserPromptExpansion /sub-human) and after classic.SessionStart (a /clear runs on under a new session
 * id: the old child is stopped at session.end, the new one started here). It is not started when the hello says
 * the session surely has no seat. A child that exits is started again after restartDelay (1 s doubling to 60 s).
 * It dies with the module (a reload, the session's end): $.process.spawn's loop is its life. All time is $.clock's.
 *
 * A failure on the way (an event that could not be applied, a child that exited or did not start, no timer to
 * restart it, a wake nothing took) adds one to $.state deliveryErrors and shows DELIVERY_ERROR_NOTICE, at most
 * once per MOD_DELIVERY_ERROR_LOG_MS: the person learns the room may hold something they did not get.
 *
 * The session's lifecycle is here too (one file per event: validate refuses a second unmatched session.start):
 * on session.start the mod runs node hooks/mod-hello.js with {session_id, nonce} (the session's nonce, minted once
 * per session id and kept in $.state; at-room checks it); mod-hello writes the module's lease and
 * prints {home, realHome, userHome, pluginRoot, seat}, kept in $.state hello, and runs it again after the join and
 * after classic.SessionStart. A refresh that fails keeps the last hello but marks it as no session's (sid null), so
 * every prefilter runs node until a refresh succeeds: a join whose hello failed must not leave "no seat" looking
 * certain. session.start and a classic SessionStart also set reviewMaybeOpen (mod/consent.mjs): unsure until
 * consent says.
 *
 *   delivering(sid) -> bool     the child follows a seat for this session id (mod/prompt.mjs skips node on it)
 */
import {
  tailArgv, tailEnv, lineBuffer, parseEvent, route, restartDelay, nextFails, noticeDue, turnLedger, spawnWanted,
  DELIVERY_ERROR_NOTICE, MOD_RESTART_TELL_FAILS,
} from './core/deliver.mjs';
import { parseHello } from './core/seat.mjs';
import { shimArgv, shimEnv, SHIM_TIMEOUT_MS } from './core/shim.mjs';
import { asHello, asNonce, mintNonce } from './core/state.mjs';

const ROWS = { plugin: 'sub-human', key: 'rows' };
const HELLO = { plugin: 'sub-human', key: 'hello' };
const REVIEW = { plugin: 'sub-human', key: 'reviewMaybeOpen' };
const ERRORS = { plugin: 'sub-human', key: 'deliveryErrors' };
const NONCE = { plugin: 'sub-human', key: 'nonce' };

/** Nonce reads and mints in order: two refreshes at once for one session id must hand mod-hello the same one. */
let minting = Promise.resolve(null);

/** sid's nonce: the one kept in $.state, or a new one kept there first (mod-hello then writes it to the lease). */
function nonceFor($, sid) {
  const mint = async () => {
    const { value } = await $.state.get(NONCE);
    const kept = asNonce(value, sid);
    if (kept) return kept;
    const nonce = mintNonce();
    await $.state.set(NONCE, { sid, value: nonce });
    return nonce;
  };
  minting = minting.then(mint, mint);
  return minting;
}

/** Run hooks/mod-hello.js for sid and keep its answer in $.state (only a good answer replaces the last one). */
async function sayHello($, sid) {
  const root = $.plugin.root;
  const nonce = typeof sid === 'string' && sid ? await nonceFor($, sid) : null;
  const run = await $.process.run(shimArgv(root, 'mod-hello.js'), {
    stdin: JSON.stringify(nonce ? { session_id: sid, nonce } : { session_id: sid }),
    env: shimEnv({ session_id: sid }, root),
    timeoutMs: SHIM_TIMEOUT_MS,
  });
  const hello = run.exitCode === 0 ? parseHello(run.stdout, sid) : null;
  if (hello) await $.state.set(HELLO, hello);
  return hello;
}

/** After a refresh failed: keep the last hello for the guard's home, but as no session's (prefilters run node). */
async function forgetSession($) {
  const value = asHello((await $.state.get(HELLO)).value);
  if (value && value.sid !== null) await $.state.set(HELLO, { ...value, sid: null });
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
/** The main-loop turn (running is null when idle, or unknown after a reload: then a wake is submitted, which waits
 * for idle anyway), its mid-turn wakes and the wakes held for the next turn. */
const turns = turnLedger();
/** When the delivery-error notice last showed ($.clock); a reload may show it once more. */
let noticedAt = -Infinity;
/** Error counts in order: two failures at once must not both read the same count. */
let counting = Promise.resolve();

export const delivering = sid => !!(child && !child.stopped && child.sid === sid && child.seat);

const userRow = text => ({ message: { type: 'user', content: [{ type: 'text', text }] } });

/** One delivery failure: counted in $.state, and the person told unless they were told recently (or `tell` is
 * false: nothing was lost yet). Never throws. */
function noteError($, { tell = true } = {}) {
  counting = counting.then(async () => {
    try {
      const { value } = await $.state.get(ERRORS);
      await $.state.set(ERRORS, (typeof value === 'number' ? value : 0) + 1);
    } catch { /* the notice below still goes out */ }
    if (!tell) return;
    try {
      // with no time to go by, only the first is told
      const at = await $.clock.now().catch(() => null);
      if (at === null ? noticedAt !== -Infinity : !noticeDue(noticedAt, at)) return;
      noticedAt = at ?? 0;
      $.ui.log(DELIVERY_ERROR_NOTICE);
    } catch { /* nowhere left to say it */ }
  });
  return counting;
}

/** The isMeta append (the model reads it with its next request); true when the row was stored. */
async function appendRow($, text) {
  const r = await $.session.append(userRow(text)).catch(() => null);
  return !!(r && !r.deny);
}

/**
 * A wake as a turn of its own. When the submit is dropped (a hook refused it) or fails, the wake still reaches the
 * model: appended, unless it already was; when the append fails too, held for the next turn.start. Never throws.
 */
function submitWake($, text, { appended = false } = {}) {
  return (async () => {
    let r = null;
    try { r = await $.prompt.submit({ text }); } catch { /* below */ }
    if (r && typeof r.drop !== 'string') return;
    if (appended || await appendRow($, text)) return;
    turns.hold(text); // PENDING_MAX keeps the newest held
    await noteError($);
  })().catch(() => {});
}

/** A wake while a turn runs: appended and checked at the turn's end; submitted when it cannot be appended, or when
 * the turn ended before the row was stored (no turn's end would check it). */
async function midTurnWake($, text) {
  if (!(await appendRow($, text))) return submitWake($, text);
  // a clock that fails dates the row as never read: submitted again rather than lost
  const at = await $.clock.now().catch(() => Infinity);
  if (!turns.appended(text, at)) await submitWake($, text, { appended: true });
}

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
          try { await apply($, c, parseEvent(line)); } catch { await noteError($); } // one event lost; the next goes on
        }
      }
    } catch { /* could not start, or the loop failed: counted and retried below */ }
    c.seat = null;
    c.stream = null;
    if (c.stopped || child !== c) return;
    // the child runs for the session's life: until it is back, nothing reaches the session
    c.fails = nextFails(c.fails, (await now()) - started);
    await noteError($, { tell: c.fails >= MOD_RESTART_TELL_FAILS });
    try {
      await new Promise((resolve, reject) => { try { $.clock.after(restartDelay(c.fails - 1), resolve); } catch (err) { reject(err); } });
    } catch {
      // no timer here: give up; the next session.start, join or SessionStart starts a child again
      await noteError($);
      if (child === c) child = null;
      return;
    }
  }
}

/** classic.PostToolUse / PostToolUseFailure: note when a main-loop tool call finished (no agent_id). Without a
 * time the last one stands: a wake then reads as unread and is submitted again rather than lost. */
async function toolDone($, e, next) {
  if (!e.agent_id) {
    try { turns.toolDone(await $.clock.now()); } catch { /* above */ }
  }
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
  const actions = route(ev, { turnRunning: turns.running !== null, role, rows: ev.type === 'wake' && role === 'orch' ? await heldRows($) : null });
  for (const a of actions) {
    switch (a.do) {
      case 'seat': c.seat = a.seat; break;
      case 'log': $.ui.log(a.text); break;
      case 'append': if (!(await appendRow($, a.text))) await noteError($); break; // refused or failed: lost
      case 'hold-rows': await $.state.set(ROWS, a.text); break;
      case 'submit': void submitWake($, a.text); break; // not awaited: it resolves only as the turn starts
      case 'mid-turn-wake': await midTurnWake($, a.text); break;
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
      if (spawnWanted(asHello(hello))) ensureChild($, sid);
    } catch { /* unknown: the guard keeps its string rules; the join or a SessionStart starts the child */ }
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
      if (spawnWanted(asHello(hello))) ensureChild($, e.session_id);
    } catch { /* the next session.start or join starts it */ }
    return r;
  }).catch(($, e, next) => next(e));

  on('session.end', ($, e, next) => {
    stopChild(e.sessionId);
    return next(e);
  });

  on('turn.start', ($, e, next) => {
    // a wake nothing took before goes into this turn, as any wake that lands mid-turn
    for (const text of turns.start(e.turnId)) void midTurnWake($, text).catch(() => {});
    return next(e);
  });

  on('turn.complete', ($, e, next) => {
    // a wake appended while the turn's last request was already out was never read: submit it after all (its row
    // is stored, so a failed submit leaves it for the next request)
    if (e.agentId === undefined) for (const text of turns.complete(e.turnId)) void submitWake($, text, { appended: true });
    return next(e);
  });

  // observe: when a main-loop tool call finished (a model request follows it, carrying what was appended)
  on('classic.PostToolUse', toolDone).catch(($, e, next) => next(e));
  on('classic.PostToolUseFailure', toolDone).catch(($, e, next) => next(e));
}
