/**
 * plugin/sub-human/mod/send.ts: SendMessage to a member on another machine goes through the room (mod/core/send.ts
 * says why). It reads the room's members document and this machine's id in the room (machines.json, else machine.json;
 * reads only: the room server writes
 * the post, as the seat, with its rate limit and signature), and answers the send itself. When the room server is not
 * connected (Claude Code holds a stdio server back for 15 minutes after one failed start, in every session), node
 * hooks/handlers/send.ts posts it the same way (lib/agent-post.ts): a send to another machine is never passed on to
 * the engine, whose only answer there is "not reachable". Anything it cannot judge (no seat, an unreadable file)
 * passes on to the engine unchanged.
 */
import { peerOf, postArgs, postResult, relayResult } from './core/send.ts';
import { shimArgv, shimEnv, SHIM_TIMEOUT_MS } from './core/shim.ts';
import { asHello } from './core/state.ts';
import type { On } from 'claude-code';

const HELLO = { plugin: 'sub-human', key: 'hello' } as const;
const SERVER = 'room'; // the server's key in .mcp.json

const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

export function registerSend(on: On): void {
  on('session.send', async ($, e, next) => {
    const hello = asHello((await $.state.get(HELLO)).value);
    const seat = hello?.seat;
    if (!hello || !seat) return next(e);
    const name = await peerOf(e.to, seat, hello.home, (f: string) => $.fs.read(f).then(parse, () => null));
    if (!name) return next(e);
    const room = await $.mcp.connect(SERVER).catch(() => null);
    if (room && room.isConnected) return postResult(name, await $.mcp.call(room.server, 'post', postArgs(name, e.text)));
    const sid = await $.session.id();
    const root = $.plugin.root;
    const run = await $.process.run(shimArgv(root, 'send'), {
      stdin: JSON.stringify({ session_id: sid, to: name, text: e.text }), env: shimEnv({ session_id: sid }, root), timeoutMs: SHIM_TIMEOUT_MS,
    }).catch((err: unknown) => ({ stderr: String(err) }));
    return relayResult(name, run);
  }).catch((_$, e, next) => next(e));
}
