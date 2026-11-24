// The test pathway: a dial is one end of an in-process stream pair, the other end handed straight to a host's accept,
// as the listener would hand it a loopback connection. Whatever the line names, it reaches that host.
import { duplexPair } from 'node:stream';
import type { Duplex } from 'node:stream';
import type { Dial } from '../link.js';

export function pipe(accept: (stream: Duplex, source: string) => void, source = 'pipe'): Dial {
  return () => {
    const [mine, theirs] = duplexPair();
    // as a socket's peer sees it: one end gone, the other reads what was sent, then its end, and closes
    for (const [a, b] of [[mine, theirs], [theirs, mine]] as const) {
      a.once('close', () => { b.push(null); });
      b.once('end', () => { b.destroy(); });
    }
    accept(theirs, source);
    return Promise.resolve(mine);
  };
}
