/**
 * plugin/sub-human/mod/prompt.ts: the prompt gate, "working" presence (pending until the turn starts: mod/deliver.ts) and the UserPromptSubmit shim (HOOKS in
 * mod/register.ts says what each hook does). An @room no person typed is dropped (cc CONTRACT
 * prompt-origin-composer); one the shim could not handle is refused, never let through as typed. The origin goes
 * to at-room with the session's nonce, which at-room checks against this session's lease. The origin hand-off is
 * a module variable: classic.UserPromptSubmit runs inside prompt.submit's next(e) (cc CONTRACT
 * prompt-submit-ups-order); a reload in between loses it, and at-room then refuses the @room. A typed prompt's origin
 * also says where the person is (onRemote): through Remote Control, room lines and an @room's refusal are relayed
 * as prompts (mod/deliver.ts), since the phone shows no $.ui.log notice. A relay is only the lines the person reads;
 * what the model needs (RELAY_CONTEXT) goes as context (prompt.submit, else classic.UserPromptSubmit
 * additionalContext), and no node runs for it. An @room's receipt (the shim's stop, "✓ sent") shows as itself: the
 * warning row Claude Code draws for the stop loses its "Operation stopped by hook: " frame (session.append).
 */
import {
  gateVerdict, GATE_FAILED, isAtRoom, isAtClaude, needsNode, originQueue, originKind, mergeClassic, TYPED_ORIGINS, titleFor, failClosed, shimFailed,
  writesWorking, onRemote, receiptBook, unseatedRefusal, roomClaudeCommand,
} from './core/prompt.ts';
import { shimArgv, shimEnv, toClassic, asNotice, SHIM_TIMEOUT_MS } from './core/shim.ts';
import { reviewOpenOf, seatedOrUnsure } from './core/prefilter.ts';
import { delivering, setRemote, queueRelay, isRelay, facts, presence } from './deliver.ts';
import { RELAY_CONTEXT } from './core/deliver.ts';
import { asHello, asNonce } from './core/state.ts';
import type { ClassicHookInputs, EngineInterface, On } from 'claude-code';
import type { Hello, ShimResult } from './core/types.ts';

const HELLO = { plugin: 'sub-human', key: 'hello' } as const;
const REVIEW = { plugin: 'sub-human', key: 'reviewMaybeOpen' } as const;
const TITLED = { plugin: 'sub-human', key: 'titled' } as const;
const ROWS = { plugin: 'sub-human', key: 'rows' } as const;
const INJECTED = { plugin: 'sub-human', key: 'rowsInjected' } as const;
const NONCE = { plugin: 'sub-human', key: 'nonce' } as const;
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

/** Refusals for the person on Remote Control, held by the UserPromptSubmit shim until its prompt.submit returns. */
let refusals: string[] = [];

/** Show text (an @room's refusal) to the person on Remote Control, where no notice shows (cc CONTRACT
 * bridge-forwarded-rows): held, then queued for the next relay (mod/deliver.ts) by the prompt.submit hook around
 * it, so the relay's submitter is that hook and this module's classic.UserPromptSubmit sees the relay (a plugin's
 * prompt skips the hook that submits it). */
function relay(text: unknown) {
  refusals.push(...String(text ?? '').split('\n'));
}

/** Queue the held refusals with this hook's $ (no $ crosses an import: mod/deliver.ts takes plain functions). */
function sendRefusals($: EngineInterface) {
  if (!refusals.length) return;
  const lines = refusals;
  refusals = [];
  queueRelay({
    now: () => $.clock.now(),
    after: (ms, fn) => $.clock.after(ms, fn),
    submit: t => $.prompt.submit({ text: t, asUser: true }),
    log: t => $.ui.log(t),
  }, lines);
}

/** Relays the model has already been given RELAY_CONTEXT for (by prompt.submit), so the classic hook adds none. */
const contexted = new Set<string>();

/** node hooks/handlers/prompt.ts with the classic payload (plus the origin), translated; its notices and report applied: a
 * notice is a $.ui.log line, or for a prompt typed through Remote Control a relay (mod/deliver.ts; the phone shows no
 * notice). An @room it did not handle (exit other than 0 or 2) is refused, and a person on Remote Control told. */
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
  if (failed) {
    if (origin === 'bridge') relay(failed.block);
    return failed;
  }
  const { result, systemMessage, subHuman } = toClassic('UserPromptSubmit', run);
  if (systemMessage) { if (origin === 'bridge') relay(systemMessage); else for (const line of asNotice(systemMessage).split('\n')) if (line.trim()) $.ui.log(line); }
  const open = reviewOpenOf(subHuman);
  if (open !== undefined) await $.state.set(REVIEW, open);
  return result;
}

export function registerPrompt(on: On) {
  // the room's Claude: a slash command a person types there is answered with the refusal, never run
  on('command.run', async ($, e, next) => {
    const why = roomClaudeCommand(e.command, e.origin, await $.env.get('SUB_HUMAN_ROOM'));
    return why ? { text: why } : next(e);
  }).catch(($, e, next) => next(e)); // unsure: the command runs, as without the module

  on('prompt.submit', async ($, e, next) => {
    // A relay this module submits: room lines for the person, never a post (its first line may read "room: …"). The
    // model gets what it needs as context, which the phone does not show.
    if (e.origin && e.origin.kind === 'plugin' && e.origin.name === $.plugin.name && isRelay(e.text)) {
      contexted.add(e.text);
      try { return await next({ ...e, context: [...(e.context ?? []), RELAY_CONTEXT] }); } finally { contexted.delete(e.text); }
    }
    const why = gateVerdict(e, isAtClaude(e.text) ? await helloOf($) : null);
    if (why) return { drop: why };
    let down = e;
    if (e.origin && TYPED_ORIGINS.includes(e.origin.kind)) {
      setRemote(onRemote(e.origin)); // the phone (bridge) or this terminal: where room lines must go
      const sid = await $.session.id();
      const hello = await helloOf($);
      // "working" once the turn starts (mod/deliver.ts turn.start): a prompt stopped or refused below starts none
      presence.pending = writesWorking(e.origin, hello, presenceOf(hello)) ? sid : null;
      if (delivering(sid)) {
        // the held rows text rides once per change: on the first typed prompt after it changes, not on every prompt
        const { value: rows } = await $.state.get(ROWS);
        const { value: injected } = await $.state.get(INJECTED);
        const held = typeof rows === 'string' && rows ? rows : null;
        if (held && held !== injected) down = { ...e, context: [...(e.context ?? []), held] };
        if (held !== (injected ?? null)) await $.state.set(INJECTED, held); // none held: the same text again is a change
      }
    }
    const item = origins.push(e.text, originKind(e.origin));
    try { return await next(down); } finally { origins.drop(item); sendRefusals($); }
  }).catch(($, e, next) => (next.called || !isAtRoom(e.text) ? next(e) : { drop: GATE_FAILED }));

  // idle, waiting on the person, or stalled: written (not awaited) for a seat, or when unsure; the next typed prompt
  // then writes "working" again
  on('classic.Notification', { notification_type: ['idle_prompt', 'permission_prompt'] }, async ($, e, next) => {
    facts.noteEvent(e);
    const hello = await helloOf($);
    presenceOf(hello);
    presence.last = e.notification_type;
    if (seatedOrUnsure(hello, e.session_id)) void writePresence($, e, e.session_id).catch(() => { presence.last = null; });
    return next(e);
  }).catch(($, e, next) => next(e));
  on('classic.StopFailure', async ($, e, next) => {
    facts.noteEvent(e);
    const hello = await helloOf($);
    presenceOf(hello);
    presence.last = 'error';
    if (seatedOrUnsure(hello, e.session_id)) void writePresence($, e, e.session_id).catch(() => { presence.last = null; });
    return next(e);
  }).catch(($, e, next) => next(e));

  on('classic.UserPromptSubmit', async ($, e, next) => {
    facts.noteEvent(e);
    const hello = await helloOf($);
    const { value: titled } = await $.state.get(TITLED);
    // NAME.CODE as the session title is the seat's SendMessage address (cc CONTRACT session-title-address).
    const title = titleFor(hello, e.session_id, titled);
    if (title) await $.state.set(TITLED, { sid: e.session_id, addr: title });
    const top = title ? { sessionTitle: title } : {};
    const { value: reviewFlag } = await $.state.get(REVIEW);
    if (isRelay(e.prompt)) { // room lines for the person: no node, and the model's part as context it alone reads
      const ctx = contexted.has(e.prompt) ? {} : { additionalContext: [RELAY_CONTEXT] };
      return mergeClassic({ ...ctx, ...top }, await next(e));
    }
    const refused = unseatedRefusal(e, hello); // an @room with surely no seat: at-room's words, no node
    if (refused) {
      presence.pending = null; // stopped: no turn, no "working"
      if (origins.take(e.prompt) === 'bridge') relay(refused.stopReason);
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
    const merged = mergeClassic({ ...ours, ...top }, await next(e));
    if (ours.preventContinuation && !merged.block) receipts.expect(merged.stopReason);
    if (merged.block || merged.preventContinuation) presence.pending = null; // stopped or refused: no turn, no "working"
    return merged;
  }).catch(($, e, next) => failClosed(e.prompt) ?? next(e)); // a plain prompt goes on, as when a command hook fails

  // The stop above is drawn as a warning row "Operation stopped by hook: ✓ sent" (cc CONTRACT ups-stop-frame): that
  // row, and only one whose receipt is waiting, is kept as the receipt alone (cc CONTRACT
  // session-append-notice-rewrite). The model's own copy (an isMeta user row) is left as it is.
  on('session.append', { door: 'notice' }, ($, e, next) => {
    const row = receipts.rewrite(e.message);
    return next(row ? { ...e, message: row } : e);
  }).catch(($, e, next) => next(e)); // a failure keeps the engine's words
}
