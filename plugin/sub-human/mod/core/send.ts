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
 *   sendFiles(home, code) -> the files a send reads: the room's members document, this home's machine.json and
 *       machines.json (this machine's id in each room it joined over a link)
 *   peerOf(to, seat, read) -> name | null   remotePeer over what those files say (read(file) -> parsed JSON or null):
 *       this machine in the room is the id the host recorded for its link (lib/home.ts machineIn), else the home's own.
 *       mod/send.ts and the two-home tests (test/support/two-homes.ts) both judge a send through it
 *   postArgs(name, text) -> the room post tool's arguments
 *   postResult(name, result) -> the session.send answer for the post's MCP result
 *   relayResult(name, run) -> the session.send answer for hooks/handlers/send.ts (the relay without the room server,
 *       which Claude Code may hold back for 15 minutes after one failed start): its one JSON line, else not delivered
 *       and why. Never passed on to the engine: on another machine its answer would only be "not reachable".
 */
import { parseAddr } from './seat.ts';
import type { HelloSeat, RunOutput } from './types.ts';

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

export const sendFiles = (home: string, code: string): { members: string; machine: string; machines: string } =>
  ({ members: `${home}/rooms/${code}/members.json`, machine: `${home}/machine.json`, machines: `${home}/machines.json` });

export async function peerOf(
  to: unknown, seat: HelloSeat | null | undefined, home: string, read: (file: string) => Promise<unknown> | unknown,
): Promise<string | null> {
  if (!seat || typeof to !== 'string' || !to.endsWith('.' + seat.code)) return null;
  const f = sendFiles(home, seat.code);
  const [members, machine, machines] = await Promise.all([read(f.members), read(f.machine), read(f.machines)]);
  const inRoom: unknown = machines && typeof machines === 'object' ? Reflect.get(machines, seat.code) : undefined;
  const own: unknown = machine && typeof machine === 'object' ? Reflect.get(machine, 'id') : undefined;
  return remotePeer(to, seat, members, typeof inRoom === 'string' && inRoom ? inRoom : own);
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
  return NOT_SENT(name, why);
}

const NOT_SENT = (name: string, why: string): { isDelivered: false; reason: string } =>
  ({ isDelivered: false, reason: `Not sent to ${name} (on another machine, reached through the room): ${why}` });

/** hooks/handlers/send.ts's answer (its stdout's last JSON line) as a session.send answer. */
export function relayResult(name: string, run: RunOutput | null | undefined): { isDelivered: true } | { isDelivered: false; reason: string } {
  const lines = String(run?.stdout ?? '').trim().split('\n').reverse();
  for (const l of lines) {
    let o: unknown;
    try { o = JSON.parse(l); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (Reflect.get(o, 'isDelivered') === true) return { isDelivered: true };
    const why: unknown = Reflect.get(o, 'reason');
    if (Reflect.get(o, 'isDelivered') === false) return NOT_SENT(name, typeof why === 'string' && why ? why : 'the room did not take it');
  }
  const err = String(run?.stderr ?? '').trim().split('\n').at(-1) ?? '';
  return NOT_SENT(name, `the room's tools are not connected in this session and the relay failed${err ? ` (${err.slice(0, 200)})` : ''}; /mcp reconnects them`);
}
