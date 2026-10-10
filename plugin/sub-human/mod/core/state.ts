/**
 * plugin/sub-human/mod/core/state.ts: the $.state values the hooks module keeps, and how a read value is taken.
 * Each file still writes its own references ({ plugin: 'sub-human', key: '…' } in a const of that file): claude
 * plugin validate lists state reads and writes only from literals there. test/mod-core.test.js checks that every
 * such literal names a key in KEYS and that KEYS is what types/index.d.ts declares.
 *
 *   KEYS                         the key names under plugin 'sub-human'
 *   asHello(value) -> hello|null the stored hello, or null when absent (none yet, or not an object)
 *   asNonce(value, sid) -> string|null   the nonce kept for session id sid, or null
 *   mintNonce() -> string        32 hex characters from crypto.getRandomValues (the module runtime has it)
 */
import type { Hello } from './types.ts';

export const KEYS = Object.freeze(['hello', 'reviewMaybeOpen', 'rows', 'titled', 'deliveryErrors', 'nonce']);

// the value is the module's own (sayHello stores only a parsed hello), so an object is taken as one
export const asHello = (value: unknown): Hello | null => (value && typeof value === 'object' ? value as Hello : null);

export const NONCE_RE = /^[0-9a-f]{32}$/;

export const asNonce = (value: unknown, sid: unknown): string | null => {
  const v = value && typeof value === 'object' ? value as { sid?: unknown; value?: unknown } : null;
  return v && typeof sid === 'string' && v.sid === sid && typeof v.value === 'string' && NONCE_RE.test(v.value) ? v.value : null;
};

export function mintNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
