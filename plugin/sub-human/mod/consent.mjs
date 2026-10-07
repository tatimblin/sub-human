/**
 * plugin/sub-human/mod/consent.mjs: consent's per-turn checks without a node start while no review is open. The
 * review itself stays in hooks/consent.js (command hooks on AskUserQuestion, EnterPlanMode, ExitPlanMode and the
 * room tools): its lock, plan-file writes and via=human signing need node. $.state reviewMaybeOpen is set true by
 * anything that may open a review (here, and in mod/deliver.mjs) and cleared only by consent's own subHuman
 * {reviewOpen} report; unset counts as true. The room tools' PreToolUse stays with the command hook: a module hook
 * answering there without next(e) would skip every other plugin's and the user's hooks (cc CONTRACT
 * classic-chain-order). Stop's additionalContext continues the turn (cc CONTRACT stop-additional-context).
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
