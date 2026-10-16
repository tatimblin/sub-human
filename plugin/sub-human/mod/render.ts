/**
 * plugin/sub-human/mod/render.ts: the group-chat drawing of UserMessage rows.
 * Display only: a rewritten row changes the drawing, never what the model read (cc CONTRACT usermessage-draw-only).
 *   - origin peer / peer-send-message (another member's Claude, its session titled NAME.CODE): one compact row,
 *     "bob's Claude: <first line>", further lines under "  │ " (mod/core/chat.ts peerLines);
 *   - origin plugin sub-human (the room's wakes): its chat lines, and each run of "(for Claude)" lines as one dim marker
 *     (mod/core/chat.ts roomRows): the person sees that the model was told something, and ctrl+o shows it whole;
 *   - anything else, a sender that is not a seat address, and every row while expanded (ctrl+o): the engine's.
 */
import { peerLines, roomRows } from './core/chat.ts';
import type { On } from 'claude-code';

export function registerRender(on: On) {
  // the d.ts takes no list for a field nested in a union (origin.kind), the engine does (validate reads it): typed as
  // the UserMessage matcher it is, the origin left to the engine
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: ['peer', 'peer-send-message', 'plugin'] } } } as { component: 'UserMessage' }, ($, e, next) => {
    const { text, origin, from, isExpanded } = e.props;
    if (isExpanded) return next(e);
    // a peer's whole message is dim; a room prompt's chat lines are not, its "(for Claude)" markers are
    const rows = origin.kind === 'plugin' ? (origin.name === $.plugin.name ? roomRows(text) : null)
      : peerLines(from && from.name, text)?.map(l => ({ text: l, dim: true })) ?? null;
    if (!rows) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const tree = h(Box, { flexDirection: 'column' }, ...rows.map((r, i) => h(Text, { key: `l${i}`, dimColor: r.dim }, r.text)));
    return tree && typeof tree === 'object' ? tree : next(e); // a Box is an element (h is typed for any tag)
  }); // no .catch: a throw skips this hook for that one row (the engine draws its own) and the next row runs it again
}
