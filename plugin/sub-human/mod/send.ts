/**
 * plugin/sub-human/mod/send.ts: SendMessage to a member on another machine goes through the room (mod/core/send.ts
 * says why). It reads the room's members document and this machine's id in the room (machines.json, else machine.json;
 * reads only: the room server writes
 * the post, as the seat, with its rate limit and signature), and answers the send itself. Anything it cannot judge
 * (no seat, an unreadable file, the room server not connected) passes on to the engine unchanged.
 */
import { remotePeer, postArgs, postResult } from './core/send.ts';
import { asHello } from './core/state.ts';
import type { On } from 'claude-code';

const HELLO = { plugin: 'sub-human', key: 'hello' } as const;
const SERVER = 'room'; // the server's key in .mcp.json

const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

export function registerSend(on: On): void {
  on('session.send', async ($, e, next) => {
    const hello = asHello((await $.state.get(HELLO)).value);
    const seat = hello?.seat;
    if (!hello || !seat || !e.to.endsWith('.' + seat.code)) return next(e);
    const [members, machine, inRooms] = await Promise.all([
      $.fs.read(`${hello.home}/rooms/${seat.code}/members.json`).then(parse, () => null),
      $.fs.read(`${hello.home}/machine.json`).then(parse, () => null),
      $.fs.read(`${hello.home}/machines.json`).then(parse, () => null),
    ]);
    // this machine in the room: the id the host recorded for its link (lib/home.ts machineIn), else the home's own
    const inRoom = (inRooms as Record<string, unknown> | null)?.[seat.code];
    const name = remotePeer(e.to, seat, members, typeof inRoom === 'string' && inRoom ? inRoom : (machine as { id?: unknown } | null)?.id);
    if (!name) return next(e);
    const room = await $.mcp.connect(SERVER);
    if (!room.isConnected) return next(e);
    return postResult(name, await $.mcp.call(room.server, 'post', postArgs(name, e.text)));
  }).catch((_$, e, next) => next(e));
}
