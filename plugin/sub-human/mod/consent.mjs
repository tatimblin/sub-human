/**
 * plugin/sub-human/mod/consent.mjs: consent's per-turn checks without a node start while no review is open. The
 * review itself stays in hooks/consent.js (command hooks on AskUserQuestion, EnterPlanMode, ExitPlanMode and the
 * room tools): its lock, plan-file writes and via=human signing need node.
 *   - $.state reviewMaybeOpen: unset (a new session, a reload) counts as true. tool.call EnterPlanMode /
 *     ExitPlanMode sets it true (a review starts only through them), and so do session.start and a /clear,
 *     compact or resume (mod/deliver.mjs). consent's own report clears it: run under SUB_HUMAN_SHIM=1 it
 *     prints subHuman {reviewOpen}, read here (Stop) and in mod/prompt.mjs (every seated prompt).
 *   - classic.Stop: the open-review nudge. It replaced the hooks.json Stop entry: node hooks/consent.js runs
 *     only when consentNeeded (mod/core/prefilter.mjs); its additionalContext continues the turn as the command
 *     hook's did (cc CONTRACT stop-additional-context, classic-chain-order).
 * The room tools' PreToolUse is left to consent's command hook, which exits at once outside plan mode: a module
 * hook that answered there without next(e) would skip every other plugin's and the user's PreToolUse hooks on
 * those tools too (cc CONTRACT classic-chain-order).
 */
import { shimArgv, shimEnv, toClassic, SHIM_TIMEOUT_MS, SHIM_MODE } from './core/shim.mjs';
import { consentNeeded, reviewOpenOf } from './core/prefilter.mjs';
import { mergeClassic } from './core/prompt.mjs';
import { asHello } from './core/state.mjs';

const HELLO = { plugin: 'sub-human', key: 'hello' };
const REVIEW = { plugin: 'sub-human', key: 'reviewMaybeOpen' };

/** Whether consent must run for this session: the hello and the flag, read from $.state. */
async function needed($, sid) {
  const { value: hello } = await $.state.get(HELLO);
  const { value: flag } = await $.state.get(REVIEW);
  return consentNeeded(asHello(hello), sid, flag);
}

/** @param {import('claude-code').On} on */
export function registerConsent(on) {
  on('tool.call', { tool: ['EnterPlanMode', 'ExitPlanMode'] }, async ($, e, next) => {
    await $.state.set(REVIEW, true);
    return next(e);
  }).catch(($, e, next) => next(e)); // the flag stays as it was; consent's command hooks run regardless

  on('classic.Stop', async ($, e, next) => {
    if (!(await needed($, e.session_id))) return next(e);
    const root = $.plugin.root;
    const run = await $.process.run(shimArgv(root, 'consent.js'), {
      stdin: JSON.stringify(e),
      env: { ...shimEnv(e, root), ...SHIM_MODE },
      timeoutMs: SHIM_TIMEOUT_MS,
    });
    const { result, systemMessage, subHuman } = toClassic('Stop', run);
    if (systemMessage) $.ui.log(systemMessage);
    const open = reviewOpenOf(subHuman);
    if (open !== undefined) await $.state.set(REVIEW, open);
    return mergeClassic(result, await next(e));
  }).catch(($, e, next) => next(e)); // a nudge, not a gate: the turn ends as it would
}
