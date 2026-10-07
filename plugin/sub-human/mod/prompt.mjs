/**
 * plugin/sub-human/mod/prompt.mjs: the prompt gate and the UserPromptSubmit shim (docs/next/MODS-PLAN.md W2 M4).
 * They replaced the hooks.json UserPromptSubmit entry (node hooks/prompt.js on every prompt of every session).
 *   - prompt.submit: an @room / room: prompt that no person typed (origin not composer, sdk or bridge: a peer
 *     session, a notification, a plugin, an unclassified socket write) is dropped before any hook runs, its
 *     reason shown to the person (mod/core/prompt.mjs gateVerdict; cc CONTRACT prompt-origin-composer). The
 *     origin of every other prompt is handed to the classic hook below (the classic payload has none).
 *   - classic.UserPromptSubmit: no node when the session surely has no seat and the prompt is not an @room
 *     (mod/core/prompt.mjs needsNode); otherwise node hooks/prompt.js as before, with sub_human_origin (the
 *     origin's kind) in its stdin: at-room posts an @room only with a typed origin. A systemMessage goes out with
 *     $.ui.log, and consent's reviewOpen report sets the reviewMaybeOpen flag (mod/consent.mjs).
 * The origin hand-off is a module variable: classic.UserPromptSubmit runs inside prompt.submit's next(e) (cc
 * CONTRACT prompt-submit-ups-order). A reload in between loses it, and at-room then refuses the @room (type it
 * again).
 *
 * W3: a seated member's plain prompt starts no node either while the mod's tail child delivers for the session
 * (mod/deliver.mjs delivering) and no review may be open: the digest, notices and row calls are the child's.
 * The session title (the seat's address NAME.CODE, members only) is set here once per session id ($.state
 * titled; mod/core/deliver.mjs titleFor), whether node runs or not. While the child delivers, the person's typed
 * prompt also carries the rows text it holds ($.state rows: pending-proposal reminders, missing row calls) as
 * context, and writes "working" presence (node hooks/presence.js, not awaited) unless the last presence this module
 * wrote or saw was already "working" (classic.Notification and classic.StopFailure note idle, permission, error).
 */
import { gateVerdict, GATE_FAILED, isAtRoom, needsNode, originQueue, originKind, mergeClassic, TYPED_ORIGINS } from './core/prompt.mjs';
import { shimArgv, shimEnv, toClassic, SHIM_TIMEOUT_MS, SHIM_MODE } from './core/shim.mjs';
import { reviewOpenOf } from './core/prefilter.mjs';
import { titleFor } from './core/deliver.mjs';
import { delivering } from './deliver.mjs';

const HELLO = { plugin: 'sub-human', key: 'hello' };
const REVIEW = { plugin: 'sub-human', key: 'reviewMaybeOpen' };
const TITLED = { plugin: 'sub-human', key: 'titled' };
const ROWS = { plugin: 'sub-human', key: 'rows' };
const origins = originQueue();
/** The last presence this module wrote or saw: 'working' skips the node start. Lost on reload: then written once. */
let presence = null;

/** The hello, or null before mod-hello answered. */
async function helloOf($) {
  const { value } = await $.state.get(HELLO);
  return value && typeof value === 'object' ? value : null;
}

/** node hooks/prompt.js with the classic payload (plus the origin), translated; its notices and report applied. */
async function runPrompt($, e, origin) {
  const root = $.plugin.root;
  const run = await $.process.run(shimArgv(root, 'prompt.js'), {
    stdin: JSON.stringify(origin ? { ...e, sub_human_origin: origin } : e),
    env: { ...shimEnv(e, root), ...SHIM_MODE },
    timeoutMs: SHIM_TIMEOUT_MS,
  });
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
      if (delivering(sid)) {
        if (presence !== 'working') {
          presence = 'working';
          const root = $.plugin.root;
          void $.process.run(shimArgv(root, 'presence.js'), {
            stdin: JSON.stringify({ hook_event_name: 'Working', session_id: sid }),
            env: shimEnv({ session_id: sid }, root),
            timeoutMs: SHIM_TIMEOUT_MS,
          }).catch(() => { presence = null; });
        }
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
    const title = titleFor(hello, e.session_id, titled);
    if (title) await $.state.set(TITLED, e.session_id);
    const top = title ? { sessionTitle: title } : {};
    const { value: reviewFlag } = await $.state.get(REVIEW);
    if (!needsNode(e, hello, { delivering: delivering(e.session_id), reviewFlag })) return mergeClassic(top, await next(e));
    const ours = await runPrompt($, e, origins.take(e.prompt));
    return mergeClassic({ ...ours, ...top }, await next(e));
  }).catch(($, e, next) => next(e)); // the shim failed: the prompt goes on, as when a command hook fails
}
