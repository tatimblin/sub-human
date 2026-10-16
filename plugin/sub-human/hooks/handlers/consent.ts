/**
 * plugin/sub-human/hooks/handlers/consent.ts: the consent hook's entry (hooks/run.ts consent). A room tool call outside
 * plan mode, other than post, exits here before anything else loads; every other event goes to hooks/consent.ts (the
 * plan view, the cards, the person's answers), imported past that exit.
 */
import type { ConsentIn } from '../consent.ts';

/** A room tool call outside plan mode, other than post: the reducer acts on one only while a review is open (plan
 * mode) or, for post, while a note waits for its card, so nothing else needs loading. */
const quiet = (input: ConsentIn | undefined): boolean => !!input && input.hook_event_name === 'PreToolUse' && input.permission_mode !== 'plan'
  && /^mcp__plugin_sub-human_room__/.test(String(input.tool_name || '')) && !POST_TOOL.test(String(input.tool_name || ''));
const POST_TOOL = /^mcp__plugin_sub-human_room__post$/;

/** Every event consent handles, as a hook. */
async function handle(input: ConsentIn): Promise<void> {
  if (quiet(input)) return;
  (await import('../consent.ts')).run(input);
}

/** The error is logged; never block a question or a plan. */
const fail = (): null => null;

export { handle, fail, quiet };
