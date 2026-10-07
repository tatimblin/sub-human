/**
 * plugin/sub-human/mod/render.mjs: the group-chat drawing of UserMessage rows (docs/next/MODS-PLAN.md Part 2a).
 * Display only: a rewritten row changes the drawing, never what the model read (cc CONTRACT usermessage-draw-only).
 *   - origin peer / peer-send-message (another member's Claude, its session titled NAME.CODE): one compact row,
 *     "bob's Claude: <first line>", further lines under "  │ " (mod/core/chat.mjs peerLines);
 *   - origin plugin sub-human (the room's own prompts, W3): its chat lines, the "(for Claude)" lines left out;
 *   - anything else, a sender that is not a seat address, and every row while expanded (ctrl+o): the engine's.
 */
import { peerLines, roomLines } from './core/chat.mjs';

/** @param {import('claude-code').On} on */
export function registerRender(on) {
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: ['peer', 'peer-send-message', 'plugin'] } } }, ($, e, next) => {
    const { text, origin, from, isExpanded } = e.props;
    if (isExpanded) return next(e);
    const isOurs = origin.kind === 'plugin';
    const lines = isOurs ? (origin.name === $.plugin.name ? roomLines(text) : null) : peerLines(from && from.name, text);
    if (!lines) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return h(Box, { flexDirection: 'column' }, ...lines.map((l, i) => h(Text, { key: `l${i}`, dimColor: !isOurs }, l)));
  });
}
