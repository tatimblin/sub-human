/**
 * plugin/sub-human/mod/prompt.mjs: the prompt gate, "working" presence and the UserPromptSubmit shim (HOOKS in
 * mod/register.mjs says what each hook does). An @room no person typed is dropped (cc CONTRACT
 * prompt-origin-composer); one the shim could not handle is refused, never let through as typed. The origin goes
 * to at-room with the session's nonce, which at-room checks against this session's lease. The origin hand-off is
 * a module variable: classic.UserPromptSubmit runs inside prompt.submit's next(e) (cc CONTRACT
 * prompt-submit-ups-order); a reload in between loses it, and at-room then refuses the @room.
 */
import {
  gateVerdict, GATE_FAILED, isAtRoom, needsNode, originQueue, originKind, mergeClassic, TYPED_ORIGINS, titleFor, failClosed, shimFailed,
  writesWorking,
} from './core/prompt.mjs';
import { shimArgv, shimEnv, toClassic, SHIM_TIMEOUT_MS } from './core/shim.mjs';
import { reviewOpenOf } from './core/prefilter.mjs';
import { delivering } from './deliver.mjs';
import { asHello, asNonce } from './core/state.mjs';

const HELLO = { plugin: 'sub-human', key: 'hello' };
const REVIEW = { plugin: 'sub-human', key: 'reviewMaybeOpen' };
const TITLED = { plugin: 'sub-human', key: 'titled' };
const ROWS = { plugin: 'sub-human', key: 'rows' };
const NONCE = { plugin: 'sub-human', key: 'nonce' };
const origins = originQueue();
/** The last presence this module wrote or saw: 'working' skips the node start. Lost on reload: then written once. */
let presence = null;

/** The hello, or null before mod-hello answered. */
async function helloOf($) {
  const { value } = await $.state.get(HELLO);
  return asHello(value);
}

/** node hooks/prompt.js with the classic payload (plus the origin), translated; its notices and report applied.
 * An @room it did not handle (exit other than 0 or 2) is refused. */
async function runPrompt($, e, origin) {
  const root = $.plugin.root;
  const { value: kept } = await $.state.get(NONCE);
  const nonce = asNonce(kept, e.session_id);
  const attested = origin ? { sub_human_origin: origin, ...(nonce ? { sub_human_nonce: nonce } : {}) } : {};
  const run = await $.process.run(shimArgv(root, 'prompt.js'), {
    stdin: JSON.stringify({ ...e, ...attested }),
    env: shimEnv(e, root),
    timeoutMs: SHIM_TIMEOUT_MS,
  });
  if (shimFailed(run) && isAtRoom(e.prompt)) return failClosed(e.prompt);
  const { result, systemMessage, subHuman } = toClassic('UserPromptSubmit', run);
  if (systemMessage) $.ui.log(systemMessage);
  const open = reviewOpenOf(subHuman);
  if (open !== undefined) await $.state.set(REVIEW, open);
  return result;
}

/** @param {import('claude-code').On} on */
export function registerPrompt(on) {
  on('prompt.submit', async ($, e, next) => {
    const why = gateVerdict(e);
    if (why) return { drop: why };
    let down = e;
    if (e.origin && TYPED_ORIGINS.includes(e.origin.kind)) {
      const sid = await $.session.id();
      if (writesWorking(e.origin, await helloOf($), presence)) {
        presence = 'working';
        const root = $.plugin.root;
        void $.process.run(shimArgv(root, 'presence.js'), {
          stdin: JSON.stringify({ hook_event_name: 'Working', session_id: sid }),
          env: shimEnv({ session_id: sid }, root),
          timeoutMs: SHIM_TIMEOUT_MS,
        }).catch(() => { presence = null; });
      }
      if (delivering(sid)) {
        const { value: rows } = await $.state.get(ROWS);
        if (typeof rows === 'string' && rows) down = { ...e, context: [...(e.context ?? []), rows] };
      }
    }
    const item = origins.push(e.text, originKind(e.origin));
    try { return await next(down); } finally { origins.drop(item); }
  }).catch(($, e, next) => (next.called || !isAtRoom(e.text) ? next(e) : { drop: GATE_FAILED }));

  on('classic.Notification', { notification_type: ['idle_prompt', 'permission_prompt'] }, ($, e, next) => {
    presence = e.notification_type;
    return next(e);
  }).catch(($, e, next) => next(e)); // presence.js beneath runs regardless
  on('classic.StopFailure', ($, e, next) => {
    presence = 'error';
    return next(e);
  }).catch(($, e, next) => next(e));

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const hello = await helloOf($);
    const { value: titled } = await $.state.get(TITLED);
    // NAME.CODE as the session title is the seat's SendMessage address (cc CONTRACT session-title-address).
    const title = titleFor(hello, e.session_id, titled);
    if (title) await $.state.set(TITLED, { sid: e.session_id, addr: title });
    const top = title ? { sessionTitle: title } : {};
    const { value: reviewFlag } = await $.state.get(REVIEW);
    if (!needsNode(e, hello, { delivering: delivering(e.session_id), reviewFlag })) return mergeClassic(top, await next(e));
    const ours = await runPrompt($, e, origins.take(e.prompt));
    return mergeClassic({ ...ours, ...top }, await next(e));
  }).catch(($, e, next) => failClosed(e.prompt) ?? next(e)); // a plain prompt goes on, as when a command hook fails
}
