/**
 * plugin/sub-human/lib/room/envelope.ts: the signed envelope (sig v2) and the keys pinned in the log. Shared by
 * the local store (lib/room/store.ts append = sign + place), the mirror (lib/room/store-mirror.ts signs, the
 * server places) and the server (lib/remote/server.ts verifies before it places), so a client and a server
 * judge a payload the same way. Pure: no file, no process state. Zero dependencies beyond node:crypto.
 *
 * sig v2 covers the payload, not its place in the log: the entry without id, at, prev and sig, plus room,
 * from, nonce and ts, as JSON with sorted keys. The server stamps id, at and prev afterwards, so a signature
 * made on one machine stays valid wherever the line lands.
 *
 * A v2 entry has sigv === 2 or a nonce. freshTs (|now - ts| <= SIG_SKEW_MS) with the nonce is the replay bound.
 * First sight pins a name's key; a keyed room (one pin or more) never accepts a `legacy` answer.
 */

import crypto from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { Entry, Envelope } from './types.ts';

/** What the envelope functions read of an entry or payload: any object, its envelope fields if it has them. */
type Signable = object & Partial<Envelope>;

const SIG_VERSION = 2;
const SIG_SKEW_MS: number = 10 * 60 * 1000;
/** Stamped by the store when it places an entry; never under a v2 signature. */
const PLACED_FIELDS: readonly string[] = ['id', 'at', 'prev', 'sig'];

/** v with the keys of every plain object sorted, so the same fields serialize to the same bytes. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) out[k] = sorted((v as Record<string, unknown>)[k]);
  return out;
}

/** The bytes a v2 signature covers: e without PLACED_FIELDS, JSON with keys sorted at every level. */
function signable(e: object): string {
  const rest: Record<string, unknown> = { ...e };
  for (const k of PLACED_FIELDS) delete rest[k];
  return JSON.stringify(sorted(rest));
}

const isV2 = (e: Signable | null | undefined): boolean => !!e && (e.sigv === SIG_VERSION || typeof e.nonce === 'string');


/** 16 random bytes as hex. */
const newNonce = (): string => crypto.randomBytes(16).toString('hex');

/** Sign the validated payload with the seat's Ed25519 private key (hooks/seat-key.ts): a new object with the Envelope. */
function sign<P extends object>(payload: P, key: KeyObject, { room, from, now = Date.now() }: { room: string; from: string; now?: number }): P & Envelope {
  const e = { ...payload, room, from, nonce: newNonce(), ts: now, sigv: SIG_VERSION };
  return { ...e, sig: crypto.sign(null, Buffer.from(signable(e), 'utf8'), key).toString('base64') };
}

/** Whether e's v2 sig verifies against pub, over signable(e). */
function verify(e: Signable | null | undefined, pub: KeyObject | null | undefined): boolean {
  if (!e || typeof e.sig !== 'string' || !pub || !isV2(e)) return false;
  try { return crypto.verify(null, Buffer.from(signable(e), 'utf8'), pub, Buffer.from(e.sig, 'base64')); } catch { return false; }
}

const freshTs = (e: Signable | null | undefined, now: number = Date.now(), skewMs: number = SIG_SKEW_MS): boolean =>
  !!e && typeof e.ts === 'number' && Number.isFinite(e.ts) && Math.abs(now - e.ts) <= skewMs;

/** An Ed25519 SPKI PEM public key (a member_joined pubkey), else null. */
function parseKey(pem: unknown): KeyObject | null {
  if (typeof pem !== 'string') return null;
  try {
    const key = crypto.createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch { return null; }
}

/** The public key pinned for each name: the first member_joined entry carrying pubkey, in log order. */
function pinnedKeys(entries: readonly (Entry | null | undefined)[] | null | undefined): Map<string, KeyObject> {
  const pins = new Map<string, KeyObject>();
  for (const e of entries ?? []) {
    if (!e || e.kind !== 'member_joined' || e.via !== 'system' || typeof e.from !== 'string' || pins.has(e.from)) continue;
    const key = parseKey(e.pubkey);
    if (key) pins.set(e.from, key);
  }
  return pins;
}

const keyed = (entries: readonly (Entry | null | undefined)[] | null | undefined): boolean => pinnedKeys(entries).size > 0;

export {
  SIG_VERSION, SIG_SKEW_MS, PLACED_FIELDS, signable, sign, verify, isV2, newNonce, freshTs, parseKey,
  pinnedKeys, keyed,
};
