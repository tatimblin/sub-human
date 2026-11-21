/**
 * plugin/sub-human/lib/agent-post.ts: a Claude's post to the room (via agent, from its seat), with the rules the room
 * server's `post` tool keeps. Two callers: mcp/room-server.ts (the tool) and hooks/handlers/send.ts (the hooks module's
 * SendMessage relay to a Claude on another machine when the room server is not connected: mod/send.ts), so a relayed
 * message is judged the same either way.
 *
 *   agentPost(me, {kind, text, to?, refs?}) -> {ok: true, entry} | {ok: false, error}
 *     refused: a kind other than say / question / status; a post repeating the person's objection note (relayed
 *     below); a post to the room session (it reads nothing). Else appended (validate() checks each field), which throws a RoomError on a
 *     rate limit or a refused field: the caller says why.
 */
import * as identity from './identity.ts';
import * as room from './room.ts';
import * as proposal from './proposal.ts';
import type { Identity } from './identity.ts';
import type { Entry, EntryInput } from './room/types.ts';

export const POST_KINDS: readonly string[] = ['say', 'question', 'status'];
const RELAY_WINDOW_MS = 10 * 60_000; // a post repeating the person's objection sent this recently is refused (relayed)

/**
 * A post that relays the person's objection note (proposal.repeatsNote), one they sent in the last RELAY_WINDOW_MS:
 * the room would show it twice; the refusal says why, else null. The receiving side does not dedupe.
 */
function relayed(me: Identity, body: unknown): string | null {
  if (typeof body !== 'string') return null;
  const since = Date.now() - RELAY_WINDOW_MS;
  const sent = room.open(me.code).readRecent().findLast(e => e.kind === 'objection' && e.via === 'human' && e.from === me.name
    && typeof e.text === 'string' && Date.parse(e.at) >= since && proposal.repeatsNote({ note: e.text }, body));
  return sent ? `refused: ${me.name} already sent that note as their objection to proposal ${sent.proposal_hash}; the room shows it, so posting it would relay it twice.` : null;
}

export function agentPost(me: Identity, args: Record<string, unknown>): { ok: true; entry: Entry } | { ok: false; error: string } {
  const { kind, text: body, to, refs } = args;
  if (typeof kind !== 'string' || !POST_KINDS.includes(kind)) {
    return { ok: false, error: `refused: kind must be one of ${POST_KINDS.join(', ')}. To ask for agreement, use plan (op ask); only people answer it, in their own session.` };
  }
  const twice = relayed(me, body);
  if (twice) return { ok: false, error: twice };
  if (to === identity.ROOM_CLAUDE) return { ok: false, error: 'refused: the room\'s session reads nothing; post to the room, or message a person\'s Claude (SendMessage NAME.CODE)' };
  // the model's arguments, unchecked: validate() (append) checks each field's type
  const entry = { kind, text: body, ...(to !== undefined ? { to } : {}), ...(refs !== undefined ? { refs } : {}) } as EntryInput;
  return { ok: true, entry: room.open(me.code).append(entry, { via: 'agent', from: me.name }) };
}
