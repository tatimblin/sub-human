/**
 * plugin/sub-human/mod/core/send.ts: Claude-to-Claude messages to a member on another machine, as pure functions
 * (mod/send.ts wires them to `session.send`; the node tests in test/mod-core.node-test.ts).
 *
 * A native SendMessage reaches only the sessions in this machine's session registry (the Claude Code config folder
 * these sessions share), so `SendMessage alice.vole-8126` from another machine finds nobody. The module catches that
 * send before the engine refuses it and posts the message to the room instead, addressed to that member (`post`
 * with `to`), which crosses the link and wakes their Claude. One address for every Claude, wherever it runs.
 *
 *   remotePeer(to, seat, members, thisMachine) -> name | null
 *       the member `to` names when it is NAME.CODE of this seat's room, not this seat, a seat that has not left, and
 *       on another machine than this one; null otherwise (the engine delivers, or refuses, as it would).
 *   postArgs(name, text) -> the room post tool's arguments
 *   postResult(name, result) -> the session.send answer for the post's MCP result
 */
import { parseAddr } from './seat.ts';
import type { HelloSeat } from './types.ts';

/** The fields of a seat record (lib/room/members.ts) this reads. */
interface PeerRecord { machine?: unknown; left_at?: unknown }

export function remotePeer(
  to: unknown, seat: HelloSeat | null | undefined, members: unknown, thisMachine: unknown,
): string | null {
  const a = parseAddr(to);
  if (!a || !seat || a.code !== seat.code || a.name === seat.name) return null;
  if (typeof thisMachine !== 'string' || !thisMachine || !members || typeof members !== 'object') return null;
  const m = (members as Record<string, PeerRecord | undefined>)[a.name];
  if (!m || typeof m !== 'object' || m.left_at) return null;
  return typeof m.machine === 'string' && m.machine && m.machine !== thisMachine ? a.name : null;
}

export const postArgs = (name: string, text: string): {
  kind: string;
  to: string;
  text: string;
} => ({ kind: 'say', to: name, text });

/** The post's MCP result as a session.send answer: delivered, or not with the room's refusal as the reason. */
export function postResult(
  name: string, result: { isError?: unknown; content?: unknown } | null | undefined,
): { isDelivered: true } | { isDelivered: false; reason: string } {
  if (result && !result.isError) return { isDelivered: true };
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const why = blocks.map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .filter(Boolean).join(' ').trim() || 'the room did not take it';
  return { isDelivered: false, reason: `Not sent to ${name} (on another machine, reached through the room): ${why}` };
}
