/**
 * net/invite.ts: invite lines (R30). A line names its pathway and the room code, and its fragment is one word: the
 * host's X25519 key (32 bytes) then a 128-bit single-use secret, in lower-case Crockford base32 (77 characters, nothing
 * a chat app eats or turns into markup). Two shapes:
 *   https://NODE.TAILNET.ts.net/CODE#WORD               Funnel (public) or Serve (tailnet): the same shape
 *   ssh://[USER@]HOST[:SSHPORT]/CODE?port=PORT#WORD      ssh -W 127.0.0.1:PORT HOST, through the joiner's own account
 *
 * The secret never goes on the wire. Message 3 of the handshake carries mac(): an HMAC keyed by it over both keys, so it
 * binds the joiner's link key and is useless to anyone who only sees it. The host keeps a record per line holding the
 * MAC key, not the secret, and verify() checks a payload against them in constant time before any other work.
 */
import crypto from 'node:crypto';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const LOOKALIKE: Readonly<Record<string, string>> = { i: '1', l: '1', o: '0' };
const KEY_BYTES = 32, SECRET_BYTES = 16, BYTES = KEY_BYTES + SECRET_BYTES;
const WORD_LEN = Math.ceil((BYTES * 8) / 5);
const WORD = new RegExp(`^[${ALPHABET}]{${WORD_LEN}}$`);
const CODE = /^[a-z][a-z0-9-]{1,39}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/; // never an ssh option: no leading '-'
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export type Pathway =
  | { kind: 'https'; origin: string }
  | { kind: 'ssh'; host: string; user: string | null; sshPort: number | null; port: number };

export interface Invite { code: string; hostKey: Buffer; secret: Buffer; via: Pathway }

/** open → pending (dialled, waiting on the host's answer) → used; refused or expired is dead. */
export type InviteState = 'open' | 'pending' | 'used' | 'dead';

/** The host's record of a line. It holds the MAC key, never the secret, so it cannot rebuild the line. */
export interface InviteRecord {
  id: string;
  code: string;
  name: string;
  macKey: string;
  expiresAt: number;
  state: InviteState;
}

export type Verdict =
  | { kind: 'open'; record: InviteRecord }
  /** a pending or used line dialled again: the host refuses both dials and alerts */
  | { kind: 'again'; record: InviteRecord }
  | { kind: 'dead'; record: InviteRecord }
  | { kind: 'none' };

function encodeWord(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString('hex')}`), out = '';
  for (let i = 0; i < WORD_LEN; i++) { out = (ALPHABET[Number(n & 31n)] ?? '') + out; n >>= 5n; }
  return out;
}

function decodeWord(text: string): Buffer | null {
  const w = text.toLowerCase().replace(/[ilo]/g, c => LOOKALIKE[c] ?? c);
  if (!WORD.test(w)) return null;
  let n = 0n;
  for (const c of w) n = (n << 5n) | BigInt(ALPHABET.indexOf(c));
  if (n >> BigInt(BYTES * 8)) return null; // more bits than a word holds
  return Buffer.from(n.toString(16).padStart(BYTES * 2, '0'), 'hex');
}

const macKeyOf = (secret: Buffer): Buffer => crypto.createHash('sha256').update('sub-human invite key v2\0').update(secret).digest();
const macWith = (macKey: Buffer, hostKey: Buffer, joinerKey: Buffer): Buffer =>
  crypto.createHmac('sha256', macKey).update('sub-human invite mac v2\0').update(hostKey).update(joinerKey).digest();

/** Message 3's payload for this line and the joiner's link key. */
export const mac = (invite: Invite, joinerKey: Buffer): Buffer => macWith(macKeyOf(invite.secret), invite.hostKey, joinerKey);

export function format(invite: Invite): string {
  const word = encodeWord(Buffer.concat([invite.hostKey, invite.secret]));
  const v = invite.via;
  if (v.kind === 'https') return `${v.origin}/${invite.code}#${word}`;
  const at = `${v.user ? `${v.user}@` : ''}${v.host}${v.sshPort ? `:${v.sshPort}` : ''}`;
  return `ssh://${at}/${invite.code}?port=${v.port}#${word}`;
}

/** A new line bound to the expected name and this host's key, and the host's record of it. */
export function mint(o: { code: string; name: string; hostKey: Buffer; via: Pathway; now: number; ttlMs: number }): {
  line: string;
  record: InviteRecord;
} {
  const secret = crypto.randomBytes(SECRET_BYTES);
  if (o.hostKey.length !== KEY_BYTES) throw new TypeError('an invite needs a 32-byte host key');
  const invite: Invite = { code: o.code, hostKey: o.hostKey, secret, via: o.via };
  const line = format(invite);
  const parsed = parse(line);
  if (!parsed.ok) throw new TypeError(`cannot mint an invite: ${parsed.error}`);
  const macKey = macKeyOf(secret);
  const id = crypto.createHash('sha256').update(macKey).digest('hex').slice(0, 12);
  return { line, record: { id, code: o.code, name: o.name, macKey: macKey.toString('base64url'), expiresAt: o.now + o.ttlMs, state: 'open' } };
}

const port = (s: string | null): number | null => {
  const n = s !== null && /^\d{1,5}$/.test(s) ? Number(s) : 0;
  return n >= 1 && n <= 65535 ? n : null;
};
const unescape = (s: string): string | null => { try { return decodeURIComponent(s); } catch { return null; } };

function pathwayOf(url: URL): Result<Pathway> {
  if (url.protocol === 'https:') {
    if (url.username || url.password || url.search) return err('an https invite has no user or query');
    return ok({ kind: 'https', origin: url.origin });
  }
  if (url.protocol !== 'ssh:') return err('an invite line starts with https:// or ssh://');
  const listener = port(url.searchParams.get('port'));
  const sshPort = url.port ? port(url.port) : null;
  const user = url.username ? unescape(url.username) ?? '' : null;
  if (listener === null || (url.port && sshPort === null)) return err('an ssh invite needs ?port=PORT');
  if (!HOST.test(url.hostname) || (user !== null && !USER.test(user)) || url.password) return err('not an ssh host');
  return ok({ kind: 'ssh', host: url.hostname, user, sshPort, port: listener });
}

export function parse(text: string): Result<Invite> {
  let url: URL;
  try { url = new URL(text.trim()); } catch { return err('not an invite line'); }
  const via = pathwayOf(url);
  if (!via.ok) return via;
  const code = url.pathname.slice(1);
  if (!CODE.test(code)) return err('the line names no room');
  const bytes = decodeWord(url.hash.slice(1));
  if (!bytes) return err('the line is cut short or mistyped');
  return ok({ code, hostKey: bytes.subarray(0, KEY_BYTES), secret: bytes.subarray(KEY_BYTES), via: via.value });
}

/** Which record, if any, message 3's payload was made for. Every record is checked, in constant time each. */
export function verify(payload: Buffer, hostKey: Buffer, joinerKey: Buffer, records: readonly InviteRecord[], now: number): Verdict {
  let hit: InviteRecord | null = null;
  for (const r of records) {
    const want = macWith(Buffer.from(r.macKey, 'base64url'), hostKey, joinerKey);
    if (payload.length === want.length && crypto.timingSafeEqual(payload, want) && !hit) hit = r;
  }
  if (!hit) return { kind: 'none' };
  if (hit.state === 'pending' || hit.state === 'used') return { kind: 'again', record: hit };
  if (hit.state === 'dead' || now >= hit.expiresAt) return { kind: 'dead', record: hit };
  return { kind: 'open', record: hit };
}
