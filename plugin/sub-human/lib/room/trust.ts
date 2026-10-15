/**
 * plugin/sub-human/lib/room/trust.ts: whether a via=human entry is the person's. Pure: no file, no store; the keys
 * come in through a TrustCtx the store builds (its pinned keys, and the seat's local .pub for a legacy room).
 *
 * via=human means "a person typed or answered this in their own terminal". Only hook processes (run by Claude Code
 * itself, never by a model) can write it: append() signs with the seat's private key, which it gets from the signer
 * a hook process installs (hooks/seat-key.ts arm()). The MCP server and the CLI never install one, so they cannot
 * write via=human at all. Readers verify with the key the room's log pins for that name (the join hook puts it in
 * member_joined). A threat model of one OS user per machine: this stops a model (its tools, the room MCP server)
 * from forging a person, not a hostile local user.
 *
 *   SIGNER, humanKey(code, from) -> KeyObject   the installed signer's key for that seat (RoomError INVALID without
 *                                a signer: only hook processes have one)
 *   TrustCtx {code, pins(), localKey(name), hasLocalKey(name)}   what a verdict reads: the store's room, the keys its
 *                                log pins (envelope.pinnedKeys), and the seat's <home>/keys/<code>/<name>.pub
 *   publicKey(name, ctx)         the key name's entries verify against: the pinned one; the local .pub only in a room
 *                                whose log pins no key (a legacy room)
 *   verdict(e, ctx) -> 'verified' | 'legacy' | 'unverified' | null   (null: not via=human)
 *       verified: its sig verifies against publicKey (v2, or v1 from before sig v2), for this room (e.room, else the
 *       store's); legacy: unsigned, in a room that pins no key, from a seat with no local key (a room from before seat
 *       keys: shown "(unverified)" but still counted as an answer); unverified: anything else (a bad sig, a sig for
 *       another room, or no sig in a keyed room or from a seat that has a key; never counted)
 *   trustOver(ctx) -> Trust      verdict bound to one store: what store.trust is. Each verified or refuted sig is
 *                                cached on the entry object (the store's read cache shares them), so a fold or a
 *                                render repeats no signature check; a verdict made without a key is not cached
 *                                (the key may be pinned later)
 *   unverified(trust, e) -> bool via=human and not verified: render's "(unverified)" marker
 *   NO_TRUST                     a Trust for entries of no known room: every via=human entry is unverified
 */

import * as envelope from './envelope.ts';
import { RoomError } from './validate.ts';
import type { KeyObject } from 'node:crypto';
import type { Entry, HumanTrust, Trust, TrustCtx } from './types.ts';

/** The installed human signer (hooks/seat-key.ts arm): the seat's private key for (room, from), or null. */
type HumanSigner = (room: string, from: string) => KeyObject | null | undefined;

const SIGNER = Symbol.for('sub-human.human-signer');

function humanKey(code: string, from: string): KeyObject {
  const signer = (globalThis as unknown as Record<symbol, HumanSigner | undefined>)[SIGNER];
  let key: KeyObject | null | undefined = null;
  if (typeof signer === 'function') { try { key = signer(code, from); } catch { key = null; } }
  if (!key) throw new RoomError('INVALID', 'via "human" is written only by sub-human\'s hooks for a person\'s own typed words or answers; post as via "agent"');
  return key;
}

function publicKey(name: string, ctx: TrustCtx): KeyObject | null {
  const pins = ctx.pins();
  return pins.size ? pins.get(name) || null : ctx.localKey(name);
}

/** A signed entry's check: true / false when a key was there to check against, null when none was. */
function sigCheck(e: Entry, ctx: TrustCtx): boolean | null {
  const room = typeof e.room === 'string' ? e.room : ctx.code;
  if (room !== ctx.code) return false; // signed for another room
  const pub = publicKey(e.from, ctx);
  return pub ? envelope.verify(e, pub) : null;
}

function judge(e: Entry, ctx: TrustCtx, checked: boolean | null): HumanTrust {
  if (checked) return 'verified';
  if (e.sig !== undefined || typeof e.from !== 'string') return 'unverified';
  return ctx.pins().size > 0 || ctx.hasLocalKey(e.from) ? 'unverified' : 'legacy';
}

function verdict(e: Entry | null | undefined, ctx: TrustCtx): HumanTrust | null {
  if (!e || e.via !== 'human') return null;
  const signed = typeof e.sig === 'string' && typeof e.from === 'string';
  return judge(e, ctx, signed ? sigCheck(e, ctx) : null);
}

function trustOver(ctx: TrustCtx): Trust {
  const sigs = new WeakMap<object, boolean>(); // entry -> its sig verified (only when a key was there)
  return (e) => {
    if (!e || e.via !== 'human') return null;
    if (!(typeof e.sig === 'string' && typeof e.from === 'string')) return judge(e, ctx, null);
    let ok = sigs.get(e);
    if (ok === undefined) {
      const c = sigCheck(e, ctx);
      if (c === null) return judge(e, ctx, null);
      sigs.set(e, ok = c);
    }
    return judge(e, ctx, ok);
  };
}

const unverified = (trust: Trust, e: Entry | null | undefined): boolean => !!e && e.via === 'human' && trust(e) !== 'verified';

const NO_TRUST: Trust = e => (e && e.via === 'human' ? 'unverified' : null);

export { SIGNER, humanKey, publicKey, verdict, trustOver, unverified, NO_TRUST };
