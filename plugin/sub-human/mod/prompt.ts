/**
 * plugin/sub-human/mod/prompt.ts: the prompt gate, "working" presence (pending until the turn starts: mod/deliver.ts) and the UserPromptSubmit shim (HOOKS in
 * mod/register.ts says what each hook does). An @room no person typed is dropped (cc CONTRACT
 * prompt-origin-composer); one the shim could not handle is refused, never let through as typed. The origin goes
 * to at-room with the session's nonce, which at-room checks against this session's lease. The origin hand-off is
 * a module variable: classic.UserPromptSubmit runs inside prompt.submit's next(e) (cc CONTRACT
 * prompt-submit-ups-order); a reload in between loses it, and at-room then refuses the @room. The room context the tail sent since the last turn (the pull lane,
 * held by mod/deliver.ts) rides as context beside the next prompt that starts a turn, never as a user row of its own:
 * a row of it before the person's words read as one turn with them (stage 8e B). An @room's receipt (the shim's stop, "✓ sent") shows as itself: the
 * warning row Claude Code draws for the stop loses its "Operation stopped by hook: " frame (session.append).
 */
import {
  gateVerdict, GATE_FAILED, isAtRoom, needsNode, originQueue, originKind, mergeClassic, TYPED_ORIGINS, titleFor, failClosed, shimFailed,
  writesWorking, receiptBook, unseatedRefusal, roomClaudeCommand,
} from './core/prompt.ts';
import { shimArgv, shimEnv, toClassic, asNotice, SHIM_TIMEOUT_MS } from './core/shim.ts';
import { reviewOpenOf, seatedOrUnsure } from './core/prefilter.ts';
import { delivering, wakeContextOf, facts, presence, serialPulls } from './deliver.ts';
import { pullContext, clearPulls } from './core/deliver.ts';
import { asHello, asNonce } from './core/state.ts';
import { rowsToSay, toolsDownStep, TOOLS_DOWN, TOOLS_DOWN_NOTICE } from './core/rows.ts';
import type { ClassicHookInputs, EngineInterface, On } from 'claude-code';
import type { Hello, Pulls, ShimResult } from './core/types.ts';

const HELLO = { plugin: 'sub-human', key: 'hello' } as const;
const REVIEW = { plugin: 'sub-human', key: 'reviewMaybeOpen' } as const;
const TITLED = { plugin: 'sub-human', key: 'titled' } as const;
const ROWS = { plugin: 'sub-human', key: 'rows' } as const;
const SERVER = 'room'; // the room server's key in .mcp.json
/** Whether the room server is connected in this session (unsure: yes, as before). */
const roomUp = async ($: EngineInterface): Promise<boolean> => {
  try { return (await $.mcp.connect(SERVER)).isConnected; } catch { return true; }
};
const INJECTED = { plugin: 'sub-human', key: 'rowsInjected' } as const;
const TOOLS_DOWN_SAID = { plugin: 'sub-human', key: 'toolsDown' } as const;
const NONCE = { plugin: 'sub-human', key: 'nonce' } as const;
const PULLS = { plugin: 'sub-human', key: 'pulls' } as const;
const origins = originQueue();
/** The @room receipts (stopReason) whose warning row session.append shows without "Operation stopped by hook: ". */
const receipts = receiptBook();
/** presence.last, reset when the hello names another seat than the one it was written for (mod/deliver.ts presence:
 * its turn.complete writes "idle" after a "working" turn). */
function presenceOf(hello: Hello | null): string | null {
  const key = hello && hello.seat ? `${hello.seat.addr}|${hello.sid}` : null;
  if (key !== presence.seat) { presence.seat = key; presence.last = null; }
  return presence.last;
}

/** node hooks/run.ts presence for this event (Working, Notification, StopFailure), not awaited: the one writer of a
 * seat's presence document (hooks/handlers/presence.ts). */
function writePresence($: EngineInterface, payload: Record<string, unknown>, sid: unknown) {
  const root = $.plugin.root;
  return $.process.run(shimArgv(root, 'presence'), {
    stdin: JSON.stringify(payload),
    env: shimEnv({ session_id: typeof sid === 'string' ? sid : undefined }, root),
    timeoutMs: SHIM_TIMEOUT_MS,
  });
}

/** The hello, or null before mod-hello answered. */
async function helloOf($: EngineInterface): Promise<Hello | null> {
  const { value } = await $.state.get(HELLO);
  return asHello(value);
}

/** Prompts prompt.submit gave the held room context: classic.UserPromptSubmit adds it only to one it did not reach
 * (a prompt the plugin submits from inside one of its own hooks skips its prompt.submit hook). */
const pulled = new Set<string>();
/** Prompts classic.UserPromptSubmit stopped or blocked: they start no turn, so the room context they carried stays held. */
const stopped = new Set<string>();

/** The held room context as the next prompt carries it (mod/core/deliver.ts pullContext), or null. */
async function heldPull($: EngineInterface): Promise<{ text: string; upTo: number } | null> {
  try { return pullContext((await $.state.get(PULLS)).value); } catch { return null; }
}

/** A prompt carried the room context up to upTo and goes on to a turn: what it carried is no longer held. */
function carried($: EngineInterface, upTo: number) {
  return serialPulls(async () => {
    const { value } = await $.state.get(PULLS);
    await $.state.set(PULLS, clearPulls(value as Pulls | null, upTo));
  });
}

/** Wakes the model has already been given their context for (by prompt.submit), so the classic hook adds none. */
const contexted = new Set<string>();

/** node hooks/handlers/prompt.ts with the classic payload (plus the origin), translated; its notices and report applied: a
 * notice is a $.ui.log line. An @room it did not handle (exit other than 0 or 2) is refused. */
async function runPrompt(
  $: EngineInterface, e: ClassicHookInputs['UserPromptSubmit'], origin: string | null, hello: Hello | null,
): Promise<ShimResult> {
  const root = $.plugin.root;
  const { value: kept } = await $.state.get(NONCE);
  const nonce = asNonce(kept, e.session_id);
  const attested = origin ? { sub_human_origin: origin, ...(nonce ? { sub_human_nonce: nonce } : {}) } : {};
  const run = await $.process.run(shimArgv(root, 'prompt'), {
    stdin: JSON.stringify({ ...e, ...attested }),
    env: shimEnv(e, root),
    timeoutMs: SHIM_TIMEOUT_MS,
  });
  const failed = shimFailed(run) ? failClosed(e.prompt, hello) : null;
  if (failed) return failed;
  const { result, systemMessage, subHuman } = toClassic('UserPromptSubmit', run);
  if (systemMessage) for (const line of asNotice(systemMessage).split('\n')) if (line.trim()) $.ui.log(line);
  const open = reviewOpenOf(subHuman);
  if (open !== undefined) await $.state.set(REVIEW, open);
  return result;
}

export function registerPrompt(on: On): void {
  // the room's Claude: a slash command a person types there is answered with the refusal, never run
  on('command.run', async ($, e, next) => {
    const why = roomClaudeCommand(e.command, e.origin, await $.env.get('SUB_HUMAN_ROOM'));
    return why ? { text: why } : next(e);
  }).catch((_$, e, next) => next(e)); // unsure: the command runs, as without the module

  on('prompt.submit', async ($, e, next) => {
    // the room context held since the last turn rides beside this prompt; it is cleared once the prompt goes on to a
    // turn (one dropped, stopped or blocked starts none: it stays for the next)
    const pull = await heldPull($);
    const pass = async (ev: typeof e) => {
      if (!pull) return next(ev);
      pulled.add(e.text);
      try {
        const r = await next({ ...ev, context: [...(ev.context ?? []), pull.text] });
        if (!(r && typeof (r as { drop?: unknown }).drop === 'string') && !stopped.has(e.text)) await carried($, pull.upTo);
        return r;
      } finally { pulled.delete(e.text); stopped.delete(e.text); }
    };
    // a member's wake submitted asUser (mod/deliver.ts): what the model alone needs of it rides as context
    const wake = e.origin && e.origin.kind === 'plugin' && e.origin.name === $.plugin.name ? wakeContextOf(e.text) : undefined;
    if (wake) {
      contexted.add(e.text);
      try { return await pass({ ...e, context: [...(e.context ?? []), wake] }); } finally { contexted.delete(e.text); }
    }
    const why = gateVerdict(e);
    if (why) return { drop: why };
    let down = e;
    if (e.origin && TYPED_ORIGINS.includes(e.origin.kind)) {
      const sid = await $.session.id();
      const hello = await helloOf($);
      // "working" once the turn starts (mod/deliver.ts turn.start): a prompt stopped or refused below starts none
      presence.pending = writesWorking(e.origin, hello, presenceOf(hello)) ? sid : null;
      if (delivering(sid)) {
        // the held rows text rides once per change: on the first typed prompt after it changes, not on every prompt
        const { value: rows } = await $.state.get(ROWS);
        const { value: injected } = await $.state.get(INJECTED);
        const held = typeof rows === 'string' && rows ? rows : null;
        const up = await roomUp($);
        // the room server down: the person and Claude are told once per time it goes down (TOOLS_DOWN)
        const { value: wasDown } = await $.state.get(TOOLS_DOWN_SAID);
        const step = toolsDownStep(wasDown === true, up);
        if (step.say) {
          $.ui.log(TOOLS_DOWN_NOTICE);
          down = { ...down, context: [...(down.context ?? []), TOOLS_DOWN] };
        }
        if (step.down !== (wasDown === true)) await $.state.set(TOOLS_DOWN_SAID, step.down);
        // a row's only tool is the room server's hold: while that server is down, the calls are not asked for (ROWS_DOWN once)
        const say = rowsToSay(held, up);
        if (say && say !== injected) down = { ...down, context: [...(down.context ?? []), say] };
        if (say !== (injected ?? null)) await $.state.set(INJECTED, say); // none held: the same text again is a change
      }
    }
    const item = origins.push(e.text, originKind(e.origin));
    try { return await pass(down); } finally { origins.drop(item); }
  }).catch((_$, e, next) => (next.called || !isAtRoom(e.text) ? next(e) : { drop: GATE_FAILED }));

  // idle, waiting on the person, or stalled: written (not awaited) for a seat, or when unsure; the next typed prompt
  // then writes "working" again
  on('classic.Notification', { notification_type: ['idle_prompt', 'permission_prompt'] }, async ($, e, next) => {
    facts.noteEvent(e);
    const hello = await helloOf($);
    presenceOf(hello);
    presence.last = e.notification_type;
    if (seatedOrUnsure(hello, e.session_id)) void writePresence($, e, e.session_id).catch(() => { presence.last = null; });
    return next(e);
  }).catch((_$, e, next) => next(e));
  on('classic.StopFailure', async ($, e, next) => {
    facts.noteEvent(e);
    const hello = await helloOf($);
    presenceOf(hello);
    presence.last = 'error';
    if (seatedOrUnsure(hello, e.session_id)) void writePresence($, e, e.session_id).catch(() => { presence.last = null; });
    return next(e);
  }).catch((_$, e, next) => next(e));

  on('classic.UserPromptSubmit', async ($, e, next) => {
    // the held room context, for a prompt prompt.submit did not give it to (see pulled)
    const own = pulled.has(e.prompt) ? null : await heldPull($);
    const r = await (async (): Promise<ShimResult> => {
      facts.noteEvent(e);
      const hello = await helloOf($);
      const { value: titled } = await $.state.get(TITLED);
      // NAME.CODE as the session title is the seat's SendMessage address (cc CONTRACT session-title-address).
      const title = titleFor(hello, e.session_id, titled);
      if (title) await $.state.set(TITLED, { sid: e.session_id, addr: title });
      const top: ShimResult = title ? { sessionTitle: title } : {};
      const { value: reviewFlag } = await $.state.get(REVIEW);
      // a member's wake submitted asUser: its context, when prompt.submit above did not add it (the hook that submits a
      // prompt skips its own plugin's prompt.submit hook); the prompt goes on as any other (consent reads it too)
      const wake = wakeContextOf(e.prompt);
      if (wake && !contexted.has(e.prompt)) top.additionalContext = [wake];
      const refused = unseatedRefusal(e, hello); // an @room with surely no seat: at-room's words, no node
      if (refused) {
        presence.pending = null; // stopped: no turn, no "working"
        origins.take(e.prompt);
        const merged = mergeClassic({ ...refused, ...top }, await next(e));
        if (!merged.block) receipts.expect(merged.stopReason); // its warning row is the refusal alone, no frame
        return merged;
      }
      if (!needsNode(e, hello, { delivering: delivering(e.session_id), reviewFlag })) {
        const merged = mergeClassic(top, await next(e));
        if (merged.block || merged.preventContinuation) presence.pending = null;
        return merged;
      }
      const ours = await runPrompt($, e, origins.take(e.prompt), hello);
      const merged = mergeClassic(mergeClassic(ours, top), await next(e)); // both contexts kept (a wake's and node's)
      if (ours.preventContinuation && !merged.block) receipts.expect(merged.stopReason);
      if (merged.block || merged.preventContinuation) presence.pending = null; // stopped or refused: no turn, no "working"
      return merged;
    })();
    const out: ShimResult = own ? { ...r, additionalContext: [...(r.additionalContext ?? []), own.text] } : r;
    if (r.block || r.preventContinuation) { if (pulled.has(e.prompt)) stopped.add(e.prompt); } // no turn: it stays held
    else if (own) await carried($, own.upTo);
    return out;
  }).catch((_$, e, next) => failClosed(e.prompt) ?? next(e)); // a plain prompt goes on, as when a command hook fails

  // The stop above is drawn as a warning row "Operation stopped by hook: ✓ sent" (cc CONTRACT ups-stop-frame): that
  // row, and only one whose receipt is waiting, is kept as the receipt alone (cc CONTRACT
  // session-append-notice-rewrite). The model's copy (an isMeta user row) says the @room line went to the room and
  // nothing is asked of it: read before the person's next words with no turn between, the bare frame read as a request.
  on('session.append', (_$, e, next) => {
    const row = e.door === 'notice' ? receipts.rewrite(e.message) : receipts.modelRow(e.message);
    return next(row ? { ...e, message: row } : e);
  }).catch((_$, e, next) => next(e)); // a failure keeps the engine's words
}
