/**
 * plugin/sub-human/mod/render.ts: the group-chat drawing of UserMessage rows.
 * Display only: a rewritten row changes the drawing, never what the model read (cc CONTRACT usermessage-draw-only).
 *   - origin peer / peer-send-message (another member's Claude, its session titled NAME.CODE): one compact row,
 *     "bob's Claude: <first line>", further lines under "  │ " (mod/core/chat.ts peerLines); the room's Claude
 *     (claude.CODE) is "the room's Claude: …";
 *   - origin plugin sub-human (the room's wakes): its chat lines, and each run of "(for Claude)" lines as one dim marker,
 *     Claude Code's "The sub-human plugin sent a message" frame left out (mod/core/chat.ts roomRows): the person sees
 *     that the model was told something; expanded (ctrl+o, or a row short enough for its speaker label, which Claude
 *     Code draws expanded too) every line whole, the frame and the markers dim;
 *   - anything else, a sender that is not a seat address, and a peer's row while expanded (ctrl+o): the engine's.
 * A prompt this plugin submitted is never drawn here (cc CONTRACT render-own-prompt-reentry): Claude Code raises that
 * row's ui.render with the submitting plugin itself as the origin, so every hook of this plugin is skipped for
 * re-entry ("the plugin's own code raised it"), no .catch asked either. Seen live: the stage 8c render of wakes never
 * ran. So a member's wake is submitted asUser with its lines for the person alone (mod/deliver.ts, core/deliver.ts
 * wakeParts): no frame to hide, and its "(for Claude)" lines ride as context. The plugin-origin branch below stays for
 * a row this hook is asked to draw (the test kit's mount, a later Claude Code).
 */
import { peerLines, roomRows } from './core/chat.ts';
import type { On, RenderElement } from 'claude-code';

/** The prompt's plugin is this one: its name as the origin carries it, with any marketplace or directory suffix. */
const ownPlugin = (name: unknown, mine: string): boolean => typeof name === 'string' && name.split('@')[0] === mine.split('@')[0];

/** A UserMessage row's props, as far as the drawing reads them. */
interface RowProps { text: string; origin: { kind: string; name?: string }; from?: { name?: string }; isExpanded: boolean }

/**
 * The row as plain RenderElement data (a Box of Texts, the dim ones dimColor), or null for the engine's own drawing.
 * own: the row is a prompt this plugin submitted (the origin names it; under re-entry it always does).
 */
export function drawRow(props: RowProps, own: boolean): RenderElement | null {
  const { text, origin, from, isExpanded } = props;
  // a peer's whole message is dim; a room prompt's chat lines are not, its "(for Claude)" markers and Claude Code's
  // frame are. Expanded (ctrl+o, and a plugin's prompt that fits its speaker label, which Claude Code also draws
  // expanded), a room prompt is drawn whole with those lines dim; a peer's is the engine's
  if (origin.kind === 'plugin' ? !own : isExpanded) return null;
  const rows = origin.kind === 'plugin' ? roomRows(text, { expanded: isExpanded })
    : peerLines(from && from.name, text)?.map(l => ({ text: l, dim: true })) ?? null;
  if (!rows) return null;
  return { type: 'Box', props: { flexDirection: 'column' }, children: rows.map((r): RenderElement => ({ type: 'Text', props: { dimColor: r.dim }, children: [r.text] })) };
}

export function registerRender(on: On): void {
  // the d.ts takes no list for a field nested in a union (origin.kind), the engine does (validate reads it): typed as
  // the UserMessage matcher it is, the origin left to the engine
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: ['peer', 'peer-send-message', 'plugin'] } } } as { component: 'UserMessage' }, ($, e, next) => {
    const tree = drawRow(e.props, e.props.origin.kind === 'plugin' && ownPlugin(e.props.origin.name, $.plugin.name));
    return tree ?? next(e);
  }); // no .catch: a throw skips this hook for that one row (the engine draws its own) and the next row runs it again
}
