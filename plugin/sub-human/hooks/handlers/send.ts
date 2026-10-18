// plugin/sub-human/hooks/handlers/send.ts: the hooks module's SendMessage relay without the room server (mod/send.ts).
// A SendMessage to a Claude on another machine is posted to the room addressed to its member; mod/send.ts asks the
// room server first, and runs this when that server is not connected (Claude Code caches a stdio server's failed
// start for 15 minutes, for every session: live 2026-10-17, a joiner's relay then fell through to the engine's "not
// reachable"). The same rules as the post tool (lib/agent-post.ts), as this session's seat.
//   in:  {session_id, to: NAME, text}
//   out: one line, the session.send answer: {"isDelivered": true} | {"isDelivered": false, "reason": "..."}
import { resolveSeat } from '../seat.ts';
import { agentPost } from '../../lib/agent-post.ts';
import { msgOf } from '../../lib/errors.ts';
import type { HookBase, Reply } from '../types.ts';

interface SendInput extends HookBase { to?: unknown; text?: unknown }

const answer = (o: object): Reply => ({ kind: 'classic', outputs: [o] });

export function handle(input: SendInput): Reply {
  const me = resolveSeat(input);
  if (!me) return answer({ isDelivered: false, reason: 'this session has no seat in a room (type /sub-human)' });
  if (typeof input.to !== 'string' || !input.to || typeof input.text !== 'string') return answer({ isDelivered: false, reason: 'nothing to send' });
  const r = agentPost(me, { kind: 'say', to: input.to, text: input.text });
  return answer(r.ok ? { isDelivered: true } : { isDelivered: false, reason: r.error });
}

/** A throw (a rate limit, the link down): not delivered, and why. */
export const fail = (err: unknown): Reply => answer({ isDelivered: false, reason: `refused: ${msgOf(err)}` });
