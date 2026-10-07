/**
 * plugin/sub-human/mod/prompt.mjs: the prompt gate and the UserPromptSubmit shim (docs/next/MODS-PLAN.md W2 M4).
 * They replaced the hooks.json UserPromptSubmit entry (node hooks/prompt.js on every prompt of every session).
 *   - prompt.submit: an @room / room: prompt that no person typed (origin not composer, sdk or bridge: a peer
 *     session, a notification, a plugin, an unclassified socket write) is dropped before any hook runs, its
 *     reason shown to the person (mod/core/prompt.mjs gateVerdict; cc CONTRACT prompt-origin-composer). The
 *     origin of every other prompt is handed to the classic hook below (the classic payload has none).
 *   - classic.UserPromptSubmit: no node when the session surely has no seat and the prompt is not an @room
 *     (mod/core/prompt.mjs needsNode); otherwise node hooks/prompt.js as before, with sub_human_origin (the
 *     origin's kind) in its stdin, so at-room posts an attested @room without the provisional mark and the
 *     after-the-fact checker. Its systemMessage (join / leave lines) goes out with $.ui.log, and consent's
 *     reviewOpen report sets the reviewMaybeOpen flag (mod/consent.mjs).
 * The origin hand-off is a module variable: classic.UserPromptSubmit runs inside prompt.submit's next(e) (cc
 * CONTRACT prompt-submit-ups-order). A reload in between loses it, and at-room then keeps today's checks.
 */
import { gateVerdict, GATE_FAILED, isAtRoom, needsNode, originQueue, mergeClassic } from './core/prompt.mjs';
import { shimArgv, shimEnv, toClassic, SHIM_TIMEOUT_MS, SHIM_MODE } from './core/shim.mjs';
import { reviewOpenOf } from './core/prefilter.mjs';

const HELLO = { plugin: 'sub-human', key: 'hello' };
const REVIEW = { plugin: 'sub-human', key: 'reviewMaybeOpen' };
const origins = originQueue();

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
    const item = origins.push(e.text, e.origin && e.origin.kind);
    try { return await next(e); } finally { origins.drop(item); }
  }).catch(($, e, next) => (next.called || !isAtRoom(e.text) ? next(e) : { drop: GATE_FAILED }));

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (!needsNode(e, await helloOf($))) return next(e);
    const ours = await runPrompt($, e, origins.take(e.prompt));
    return mergeClassic(ours, await next(e));
  }).catch(($, e, next) => next(e)); // the shim failed: the prompt goes on, as when a command hook fails
}
