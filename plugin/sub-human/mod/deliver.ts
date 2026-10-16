/**
 * plugin/sub-human/mod/deliver.ts: the session's lifecycle (the hello) and the room's delivery; HOOKS in
 * mod/register.ts says what each hook does. A child `node scripts/sub-human tail --ndjson` (lib/tail.ts) follows the
 * seat's room and writes events; mod/core/deliver.ts route() maps each to a $ call. The child is the seat's only
 * delivery: nothing else tells the person or the model what happened in the room. It restarts with backoff and dies
 * with the module. A failed hello refresh keeps the last hello but as no session's, so the prefilters run node.
 * Failure: every lost event, child exit or wake nothing took counts in $.state deliveryErrors and shows
 * DELIVERY_ERROR_NOTICE (rate-limited), so the person learns the room may hold something they did not get.
 *
 *   delivering(sid) -> bool     the child follows a seat for this session id (mod/prompt.ts skips node on it)
 *   setRemote(on)               mod/prompt.ts: the person's last typed prompt came through Remote Control (true) or
 *                               this terminal (false); undefined changes nothing. Module state: a reload forgets it
 *   queueRelay(io, lines)       lines for the person on Remote Control (room chat; mod/prompt.ts: an @room's refusal):
 *                               one relay prompt once idle, at most one per RELAY_GAP_MS, submitted asUser; io is a
 *                               hook's {now, after, submit, log} (no $ crosses an import)
 *   isRelay(text) -> bool       mod/prompt.ts: text is a relay this module is submitting (its context, no node)
 */
import {
  tailArgv, tailEnv, lineBuffer, parseEvent, route, restartDelay, nextFails, noticeDue, turnLedger, spawnWanted, logLines,
  relayQueue, rewakePrompt, DELIVERY_ERROR_NOTICE, MOD_RESTART_TELL_FAILS, RELAY_AFTER_MS, REWAKE_TIMEOUT_MS,
} from './core/deliver.ts';
import { parseHello, localHello, homeOf, sidIndex } from './core/seat.ts';
import { answersItself, joinPayload, readReply, answerOf, CONFIRM_AFTER_MS } from './core/command.ts';
import { shimArgv, shimEnv, toClassic, SHIM_TIMEOUT_MS } from './core/shim.ts';
import { restoreNeeded } from './core/prefilter.ts';
import { mergeClassic } from './core/prompt.ts';
import { factsBook } from './core/facts.ts';
import { asHello, asNonce, mintNonce } from './core/state.ts';
import type { EngineInterface, On, SessionAppendArgs } from 'claude-code';
import type { RelayIo, TailEvent, TailSeat } from './core/types.ts';

/** The tail child as the module tracks it; stream: its $.process.spawn stream, as stopChild ends it. */
interface Child { sid: string; seat: TailSeat | null; stream: { return(value?: unknown): Promise<unknown> } | null; stopped: boolean; fails: number }

const ROWS = { plugin: 'sub-human', key: 'rows' } as const;
const HELLO = { plugin: 'sub-human', key: 'hello' } as const;
const REVIEW = { plugin: 'sub-human', key: 'reviewMaybeOpen' } as const;
const ERRORS = { plugin: 'sub-human', key: 'deliveryErrors' } as const;
const NONCE = { plugin: 'sub-human', key: 'nonce' } as const;

/** Nonce reads and mints in order: two refreshes at once for one session id must hand mod-hello the same one. */
let minting: Promise<string | null> = Promise.resolve(null);

/** sid's nonce: the one kept in $.state, or a new one kept there first (mod-hello then writes it to the lease). */
function nonceFor($: EngineInterface, sid: string): Promise<string | null> {
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

/** What classic.PreToolUse needs and its event does not carry (mod/core/facts.ts): each main-loop classic event this
 * module sees notes the session's transcript path and permission mode; tool.call stashes the call's agentId. Module
 * state: a reload forgets it until the next event. */
export const facts = factsBook();
/** The last presence the module wrote or saw for seat (address|sid): mod/prompt.ts writes "working" for a typed prompt,
 * idle on a notification; turn.complete below writes "idle" when the turn that ends was a "working" one (an
 * idle_prompt notification may never come: seen live, every member stuck on "working"). Lost on reload. */
export const presence: { last: string | null; seat: string | null } = { last: null, seat: null };

/** The session id whose lease this module process has written (mod-hello ran for it): join and at-room need one. */
let leased: string | null = null;

/** Run hooks/handlers/mod-hello.ts for sid and keep its answer in $.state (only a good answer replaces the last one). */
async function sayHello($: EngineInterface, sid: string) {
  const root = $.plugin.root;
  const nonce = typeof sid === 'string' && sid ? await nonceFor($, sid) : null;
  const run = await $.process.run(shimArgv(root, 'mod-hello'), {
    stdin: JSON.stringify(nonce ? { session_id: sid, nonce } : { session_id: sid }),
    env: shimEnv({ session_id: sid }, root),
    timeoutMs: SHIM_TIMEOUT_MS,
  });
  const hello = run.exitCode === 0 ? parseHello(run.stdout, sid) : null;
  if (hello) { await $.state.set(HELLO, hello); leased = sid; }
  return hello;
}

/** The lease for sid (mod-hello writes it, with the nonce): before a join, which refuses a session without one. */
async function ensureLease($: EngineInterface, sid: string) {
  if (leased !== sid) await refresh($, sid);
}

/**
 * At session start: mod-hello only when this session may have a seat (its session index exists, or this process knew
 * a seat before: a /clear). Otherwise the hello is the module's own (localHello: the home from the environment, no seat),
 * so a session that never joins starts no node; its lease is written when it first types /sub-human (ensureLease).
 */
async function startHello($: EngineInterface, sid: string) {
  const prev = asHello((await $.state.get(HELLO)).value);
  if (!(prev && prev.seat)) {
    const userHome = (await $.env.get('HOME')) ?? null;
    const home = homeOf(await $.env.get('SUB_HUMAN_HOME'), userHome);
    const index = home && home.startsWith('/') ? sidIndex(home, sid) : null;
    if (home && index && !(await $.fs.exists(index))) {
      const real = await $.fs.stat(home, { resolve: true }).then(s => s.realPath, () => undefined);
      await $.state.set(HELLO, localHello({ sid, home, realHome: typeof real === 'string' ? real : null, userHome, pluginRoot: $.plugin.root }));
      return;
    }
  }
  await refresh($, sid);
}

/** After a refresh failed: keep the last hello for the guard's home, but as no session's (prefilters run node). */
async function forgetSession($: EngineInterface) {
  const value = asHello((await $.state.get(HELLO)).value);
  if (value && value.sid !== null) await $.state.set(HELLO, { ...value, sid: null });
}

/** mod-hello for sid; when it fails, forgetSession. */
async function refresh($: EngineInterface, sid: string) {
  let hello = null;
  try { hello = await sayHello($, sid); } catch { /* below */ }
  if (!hello) await forgetSession($);
}


/** A join the command.run hook took (hooks/handlers/join.ts said so): {sid, context}, for the expansion it lets run next, so
 * the join hook beneath does not run a second time. Module state, set only while that next(e) runs. */
let joined: { sid: string; context: string } | null = null;

/** The current child: {sid, seat, stream, stopped}; null before the first start. Module state: a reload loses it
 * together with the child itself. */
let child: Child | null = null;
/** The main-loop turn (running is null when idle, or unknown after a reload: then a wake is submitted, which waits
 * for idle anyway), its mid-turn wakes and the wakes held for the next turn. */
const turns = turnLedger();
/** The person types from Remote Control (mod/prompt.ts setRemote): chat is relayed as prompts there. */
let remote = false;
/** Lines waiting for the next relay (one per RELAY_GAP_MS; held while a main-loop turn runs). */
const relayQ = relayQueue();
/** A relay flush is scheduled. */
let relayTimer = false;
/** Relay texts being submitted: mod/prompt.ts attaches RELAY_CONTEXT to them and runs no node for them. */
const relaying = new Set();
/** When the delivery-error notice last showed ($.clock); a reload may show it once more. */
let noticedAt = -Infinity;
/** Error counts in order: two failures at once must not both read the same count. */
let counting: Promise<void> = Promise.resolve();

export const delivering = (sid: unknown) => !!(child && !child.stopped && child.sid === sid && child.seat);

export function setRemote(on: boolean | undefined) { if (typeof on === 'boolean') remote = on; }

const userRow = (text: string): SessionAppendArgs => ({ message: { type: 'user', content: [{ type: 'text', text }] } });

/** One delivery failure: counted in $.state, and the person told unless they were told recently (or `tell` is
 * false: nothing was lost yet). Never throws. */
function noteError($: EngineInterface, { tell = true } = {}): Promise<void> {
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
async function appendRow($: EngineInterface, text: string): Promise<boolean> {
  const r = await $.session.append(userRow(text)).catch(() => null);
  return !!(r && !r.deny);
}

/** Each line on its own notice, as a chat event's (a newline in one would be drawn as U+FFFD). */
function logEach($: EngineInterface, lines: unknown) {
  for (const a of logLines(lines)) $.ui.log(a.text);
}

/**
 * A wake as a turn of its own. When the submit is dropped (a hook refused it) or fails, the wake still reaches the
 * model: appended, unless it already was; when the append fails too, held for the next turn.start. The person then
 * sees the room lines `seen` as notices, since no prompt row shows them (only "Prompt dropped by a hook"); lines
 * already shown are passed as none. Never throws.
 */
function submitWake($: EngineInterface, text: string, { appended = false, seen = [] as string[] } = {}) {
  return (async () => {
    let r = null;
    try { r = await $.prompt.submit({ text }); } catch { /* below */ }
    if (r && typeof r.drop !== 'string') return;
    try { logEach($, seen); } catch { /* the model still gets it below */ }
    if (appended || await appendRow($, text)) return;
    turns.hold(text); // PENDING_MAX keeps the newest held
    await noteError($);
  })().catch(() => {});
}

/** A wake while a turn runs: appended and checked at the turn's end; submitted when it cannot be appended, or when
 * the turn ended before the row was stored (no turn's end would check it). */
/**
 * After a resume: hooks/handlers/row-rewake.ts, not awaited (it was an asyncRewake command hook). Its exit 2 is the row
 * calls the resume lost: they go to the model as a wake (submitWake), shown to the person as one line. Never throws.
 */
async function rewake($: EngineInterface, e: { session_id?: string }) {
  try {
    const root = $.plugin.root;
    const run = await $.process.run(shimArgv(root, 'row-rewake'), { stdin: JSON.stringify(e), env: shimEnv(e, root), timeoutMs: REWAKE_TIMEOUT_MS });
    if (run.exitCode === 2 && String(run.stderr || '').trim()) await submitWake($, rewakePrompt(run.stderr));
  } catch { /* the restore's context lists the same rows for the next prompt */ }
}

async function midTurnWake($: EngineInterface, text: string) {
  if (!(await appendRow($, text))) return submitWake($, text);
  // a clock that fails dates the row as never read: submitted again rather than lost
  const at = await $.clock.now().catch(() => Infinity);
  if (!turns.appended(text, at)) await submitWake($, text, { appended: true });
}

export const isRelay = (text: string) => relaying.has(text);

/**
 * What a relay needs of a hook's $, as plain functions (a hooks module passes no $ across an import): {now, after,
 * submit, log}. relayIo($) builds it here; mod/prompt.ts builds its own.
 */
const relayIo = ($: EngineInterface): RelayIo => ({
  now: () => $.clock.now(),
  after: (ms, fn) => $.clock.after(ms, fn),
  submit: text => $.prompt.submit({ text, asUser: true }),
  log: text => $.ui.log(text),
});

/** Lines for the person on Remote Control (io: relayIo's shape): queued for the next relay. Never throws. */
export function queueRelay(io: RelayIo, lines: unknown) {
  if (relayQ.add(lines)) scheduleRelay(io);
}

/** Flush the queue after RELAY_AFTER_MS (a prompt cannot be submitted from inside a hook) or the rest of the gap. */
function scheduleRelay(io: RelayIo) {
  if (relayTimer || !relayQ.size || turns.running !== null) return; // a running turn's end schedules it
  relayTimer = true;
  void (async () => {
    const now = await Promise.resolve().then(io.now).catch(() => 0);
    io.after(Math.max(RELAY_AFTER_MS, relayQ.wait(now)), () => { relayTimer = false; void flushRelay(io); });
  })().catch(() => { relayTimer = false; void flushRelay(io); });
}

/** Every queued line as one relay prompt, once idle: only the lines, submitted asUser (mod/prompt.ts adds the
 * context). The person back at the terminal, or a prompt nothing took: the lines as notices here. Never throws. */
async function flushRelay(io: RelayIo) {
  if (turns.running !== null) return;
  const text = relayQ.take(await Promise.resolve().then(io.now).catch(() => 0));
  if (!text) return;
  const asNotices = () => { for (const a of logLines(text)) { try { io.log(a.text); } catch { /* nowhere left */ } } };
  if (!remote) return asNotices();
  relaying.add(text);
  try {
    const r = await io.submit(text);
    if (r && typeof r.drop === 'string') asNotices();
  } catch { asNotices(); } finally { relaying.delete(text); }
}

function stopChild(sid?: string) {
  const c = child;
  if (!c || (sid !== undefined && c.sid !== sid)) return;
  c.stopped = true;
  c.seat = null;
  child = null;
  try { if (c.stream) void c.stream.return(undefined).catch(() => {}); } catch { /* already gone */ }
}

/** The child as the hello wants it: started (or kept) for a seat or a join waiting for its card; stopped once the
 * hello is sure the session has none (a /sub-human leave, a join refused). */
function childFor($: EngineInterface, sid: string, hello: ReturnType<typeof asHello>) {
  if (spawnWanted(hello)) ensureChild($, sid);
  else stopChild(sid);
}

/** Start the child for sid unless it already runs for it; stops one for another session id. */
function ensureChild($: EngineInterface, sid: unknown) {
  if (typeof sid !== 'string' || !sid) return;
  if (child && !child.stopped && child.sid === sid) return;
  if (child) stopChild();
  const c: Child = { sid, seat: null, stream: null, stopped: false, fails: 0 };
  child = c;
  void runChild($, c);
}

/** The child's loop: spawn, route each line, and on exit start again after the backoff (until stopped). Never
 * throws: it runs after the hook that started it returned, where nothing would handle a rejection. */
async function runChild($: EngineInterface, c: Child) {
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
      await new Promise<void>((resolve, reject) => { try { $.clock.after(restartDelay(c.fails - 1), resolve); } catch (err) { reject(err); } });
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
async function toolDone<E extends { readonly agent_id?: string; readonly session_id?: string }, R>($: EngineInterface, e: E, next: (e: E) => R | PromiseLike<R>): Promise<R> {
  facts.noteEvent(e);
  if (!e.agent_id) {
    try { turns.toolDone(await $.clock.now()); } catch { /* above */ }
  }
  return next(e);
}

async function heldRows($: EngineInterface): Promise<string | null> {
  const { value } = await $.state.get(ROWS);
  return typeof value === 'string' && value ? value : null;
}

/** One event's actions (mod/core/deliver.ts route). */
async function apply($: EngineInterface, c: Child, ev: TailEvent | null) {
  if (!ev || c.stopped) return;
  const role = c.seat && c.seat.role === 'claude' ? 'claude' : 'member';
  const rows = ev.type === 'wake' && role === 'claude' ? await heldRows($) : null;
  const actions = route(ev, { turnRunning: turns.running !== null, role, rows, remote: remote && role === 'member' });
  for (const a of actions) {
    switch (a.do) {
      case 'seat': {
        c.seat = a.seat;
        // no seat: once the hello says this session has none and waits for no join, the tail has nothing to deliver
        if (!a.seat) { const h = asHello((await $.state.get(HELLO)).value); if (h && h.sid === c.sid && !spawnWanted(h)) stopChild(c.sid); }
        break;
      }
      case 'log': $.ui.log(a.text); break;
      case 'append': if (!(await appendRow($, a.text))) await noteError($); break; // refused or failed: lost
      case 'hold-rows': await $.state.set(ROWS, a.text); break;
      case 'submit': void submitWake($, a.text, { seen: a.seen }); break; // not awaited: it resolves as the turn starts
      case 'mid-turn-wake': await midTurnWake($, a.text); break;
      case 'relay': queueRelay(relayIo($), a.lines); break;
      default: break;
    }
  }
}

/** An invite's line and PIN on this plugin's status line, under the prompt (Claude Code saves it in no transcript, as it
 * does a notice), until the invite's life is over; a newer one replaces it. */
let pinnedAt = 0;
function pinStatus($: EngineInterface, { status, ms }: { status: string; ms: number }): void {
  const mine = ++pinnedAt;
  $.ui.status(status);
  try { $.clock.after(ms, () => { if (mine === pinnedAt) $.ui.status(undefined); }); } catch { /* it stays until the next one replaces it */ }
}

export function registerDeliver(on: On) {
  on('session.start', async ($, e, next) => {
    try {
      const sid = await $.session.id();
      await $.state.set(REVIEW, true);
      await startHello($, sid).catch(() => refresh($, sid));
      const { value: hello } = await $.state.get(HELLO);
      if (spawnWanted(asHello(hello))) ensureChild($, sid);
    } catch { /* unknown: the guard keeps its string rules; the join or a SessionStart starts the child */ }
    return next(e);
  });

  // /sub-human answered here (mod/core/command.ts): join.ts through the shim, its reply as a notice or the command's
  // output; a join that worked expands as before, its mechanics block handed to the expansion hook below
  on('command.run', { command: ['sub-human:sub-human', 'sub-human'] }, async ($, e, next) => {
    const sid = await $.session.id();
    await ensureLease($, sid); // the join needs this session's lease, and the nonce it holds
    const nonce = asNonce((await $.state.get(NONCE)).value, sid);
    if (!answersItself(e, { roomClaude: !!(await $.env.get('SUB_HUMAN_ROOM')), nonce })) return next(e);
    const root = $.plugin.root;
    const run = await $.process.run(shimArgv(root, 'join'), {
      stdin: JSON.stringify(joinPayload({ sid, cwd: await $.session.cwd(), args: e.args, nonce })),
      env: shimEnv({ session_id: sid }, root),
      timeoutMs: SHIM_TIMEOUT_MS,
    });
    const reply = readReply(run);
    if (reply.kind === 'joined') {
      joined = { sid, context: reply.context };
      try {
        const r = await next(e);
        // after the command's own row, which Claude Code adds once this hook returns
        const confirm = () => { for (const line of reply.lines) $.ui.log(line); };
        try { $.clock.after(CONFIRM_AFTER_MS, confirm); } catch { confirm(); }
        return r;
      } finally { joined = null; }
    }
    const { result, logs, status } = answerOf(reply, { bridge: e.origin.kind === 'bridge' });
    for (const line of logs) $.ui.log(line);
    if (status) pinStatus($, status);
    try { await refresh($, sid); } catch { /* the next refresh tries again */ }
    try { childFor($, sid, asHello((await $.state.get(HELLO)).value)); } catch { /* next start tries again */ }
    return result;
  }).catch(($, e, next) => next(e)); // unsure: the classic hook beneath answers, as without the module

  // after a join (hooks/handlers/join.ts beneath, or the one command.run above took): hello for the new seat; the child looks
  // it up itself
  on('classic.UserPromptExpansion', { command_name: /^(sub-human:)?sub-human$/ }, async ($, e, next) => {
    facts.noteEvent(e);
    const took = joined && joined.sid === e.session_id ? joined : null;
    if (took) joined = null;
    else { try { await ensureLease($, e.session_id); } catch { /* the join beneath says what is missing */ } }
    const r = took ? { additionalContext: [took.context] } : await next(e);
    try { await refresh($, e.session_id); } catch { /* the next refresh tries again */ }
    try { childFor($, e.session_id, asHello((await $.state.get(HELLO)).value)); } catch { /* next start tries again */ }
    return r;
  }).catch(($, e, next) => next(e)); // never in the join's way: what ran beneath stands, or runs

  // a /clear (new session id), compact or resume: session-restore puts the seat back first (a /clear rebinds it to the
  // new session id), unless this session surely has none; then the hello for that id, the tail child, and on resume
  // the rows the resume lost (row-rewake, in the background: a wake once it answers)
  on('classic.SessionStart', async ($, e, next) => {
    facts.noteEvent(e);
    let ours = {};
    if (restoreNeeded(asHello((await $.state.get(HELLO)).value), e.session_id, e.source)) {
      const root = $.plugin.root;
      const run = await $.process.run(shimArgv(root, 'session-restore'), { stdin: JSON.stringify(e), env: shimEnv(e, root), timeoutMs: SHIM_TIMEOUT_MS });
      ours = toClassic('SessionStart', run).result;
      try { await $.state.set(REVIEW, true); await refresh($, e.session_id); } catch { /* the next refresh tries again */ }
      try {
        const hello = asHello((await $.state.get(HELLO)).value);
        if (e.source === 'resume' && hello && hello.seat) void rewake($, e);
      } catch { /* the rows come with the next prompt (the restore's context) */ }
    }
    try {
      // this session's hello first: one not said yet (classic.SessionStart can run before session.start's) is no seat
      // to start a tail for, only a hello not known
      let hello = asHello((await $.state.get(HELLO)).value);
      if (!hello || hello.sid !== e.session_id) { await startHello($, e.session_id).catch(() => {}); hello = asHello((await $.state.get(HELLO)).value); }
      childFor($, e.session_id, hello);
    } catch { /* the next session.start or join starts it */ }
    return mergeClassic(ours, await next(e));
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
    if (e.agentId === undefined) {
      for (const text of turns.complete(e.turnId)) void submitWake($, text, { appended: true });
      if (turns.running === null) scheduleRelay(relayIo($));
      // the turn the person's prompt started is over: back at the prompt (node hooks/run.ts presence, not awaited)
      if (presence.last === 'working') {
        presence.last = 'idle';
        void (async () => {
          const root = $.plugin.root, sid = await $.session.id();
          await $.process.run(shimArgv(root, 'presence'), { stdin: JSON.stringify({ hook_event_name: 'TurnEnd', session_id: sid }), env: shimEnv({ session_id: sid }, root), timeoutMs: SHIM_TIMEOUT_MS });
        })().catch(() => { presence.last = null; });
      }
    }
    return next(e);
  });

  // observe: when a main-loop tool call finished (a model request follows it, carrying what was appended)
  on('classic.PostToolUse', toolDone).catch(($, e, next) => next(e));
  on('classic.PostToolUseFailure', toolDone).catch(($, e, next) => next(e));
}
