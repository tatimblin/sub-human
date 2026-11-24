// The PROXY protocol v2 header tailscaled puts before each connection it forwards from Funnel or Serve
// (`--proxy-protocol=2`, R29a), so the host's per-source limits see the joiner's address, not one loopback source.
// Only PROXY over TCP4 or TCP6 is taken: LOCAL, UDP and unix sockets are not what a forward sends.

export const SIGNATURE: Buffer = Buffer.from('0d0a0d0a000d0a515549540a', 'hex');
const FIXED = 16;
/** The longest header taken: TCP6's addresses plus room for TLVs. */
const MAX = 536;

export type Proxied =
  | { readonly kind: 'more' }
  | { readonly kind: 'bad'; readonly why: string }
  | { readonly kind: 'ok'; readonly source: string; readonly rest: Buffer };

/** The header at the start of `buf`: the source address and the bytes after it, or more to wait for, or bad. */
export function parseProxy(buf: Buffer): Proxied {
  const sig = buf.subarray(0, SIGNATURE.length);
  if (!SIGNATURE.subarray(0, sig.length).equals(sig)) return { kind: 'bad', why: 'no PROXY v2 header' };
  if (buf.length < FIXED) return { kind: 'more' };
  const len = buf.readUInt16BE(14);
  if (FIXED + len > MAX) return { kind: 'bad', why: 'a PROXY header too long' };
  if (buf.length < FIXED + len) return { kind: 'more' };
  if (buf[12] !== 0x21) return { kind: 'bad', why: 'not a v2 PROXY command' };
  const body = buf.subarray(FIXED, FIXED + len);
  const rest = buf.subarray(FIXED + len);
  if (buf[13] === 0x11 && len >= 12) return { kind: 'ok', source: [...body.subarray(0, 4)].join('.'), rest };
  if (buf[13] === 0x21 && len >= 36) {
    const words = Array.from({ length: 8 }, (_, i) => body.readUInt16BE(i * 2).toString(16));
    return { kind: 'ok', source: words.join(':'), rest };
  }
  return { kind: 'bad', why: 'a PROXY header for neither TCP4 nor TCP6' };
}
