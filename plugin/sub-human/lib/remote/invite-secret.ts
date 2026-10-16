/**
 * plugin/sub-human/lib/remote/invite-secret.ts: the SECRET word of an invite line (protocol 3), pure. The host's
 * `/sub-human invite` shows `/sub-human join ADDR ROOM SECRET` and, beside it, a 4-digit PIN told separately; the PIN
 * is never in the line (lib/remote/invites.ts checks it online). SECRET is 24 bytes in 39 characters:
 *
 *   secret (16 bytes)   128 bits of single-use randomness: the invite's name on the host (its record is keyed by
 *                       sha256(secretId)), never stored there in clear
 *   tag (8 bytes)       the host key the line is for: the first 64 bits of HMAC-SHA256(key = secret, "sub-human host
 *                       key v3" 0 role 0 key). role 'listener': the web listener's X25519 Noise key (lib/remote/
 *                       listener.ts), which the joiner fetches and checks before its Noise handshake; role 'machine':
 *                       the host home's Ed25519 machine key (lib/remote/machine-key.ts), which the host proves by
 *                       signing the joiner's nonce (ssh, pipe) before the joiner sends the secret. Keyed by the secret,
 *                       so nobody can grind a key to match a tag without the line, and a line holder has the invite's
 *                       15 minutes: 64 bits is out of reach either way
 *
 * The alphabet is Crockford's base32 in lower case (0-9 a-z without i l o u): no punctuation for a chat app or a mail
 * client to eat, wrap or turn into markup, one case, and decode() reads upper case and the look-alikes (i l -> 1,
 * o -> 0) as Crockford says. 192 bits is 39 characters (the first carries 2 bits: 0-3).
 *
 *   ALPHABET, SECRET_BYTES (16), TAG_BYTES (8), WORD_LEN (39), WORD_RE
 *   mint() -> Buffer                    16 random bytes
 *   tagOf(secret, role, key) -> Buffer  8 bytes; key: the raw public key, base64url (43 characters)
 *   encode(secret, tag) -> word
 *   decode(text) -> {secret, tag} | null   a word of the right length and alphabet, else null
 *   keyHolds(decoded, role, key) -> bool   the tag names this key (constant time)
 *   idOf(secret) -> string              the secret as the host's records name it (base64url, 22 characters)
 *   admissionRef(secret) -> string      the ref (12 hex) of the join request its PIN makes on the host (invites.ts
 *                                       admissionSlot), which the card and the joiner's screen both show
 *   ROLES                               'listener', 'machine'
 */
import crypto from 'node:crypto';

type Role = 'listener' | 'machine';
const ROLES: readonly Role[] = Object.freeze(['listener', 'machine']);
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const SECRET_BYTES = 16;
const TAG_BYTES = 8;
const WORD_LEN = Math.ceil(((SECRET_BYTES + TAG_BYTES) * 8) / 5); // 39
const WORD_RE = new RegExp(`^[${ALPHABET}]{${WORD_LEN}}$`);
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const LOOKALIKE: Readonly<Record<string, string>> = Object.freeze({ i: '1', l: '1', o: '0' });

const mint = (): Buffer => crypto.randomBytes(SECRET_BYTES);

function tagOf(secret: Buffer, role: Role, key: string): Buffer {
  if (!Buffer.isBuffer(secret) || secret.length !== SECRET_BYTES) throw new TypeError('an invite secret is 16 bytes');
  if (!ROLES.includes(role) || !KEY_RE.test(String(key))) throw new TypeError('a host key tag needs a role and a 32-byte key, base64url');
  const msg = Buffer.concat([Buffer.from('sub-human host key v3\0'), Buffer.from(role), Buffer.from([0]), Buffer.from(key, 'base64url')]);
  return crypto.createHmac('sha256', secret).update(msg).digest().subarray(0, TAG_BYTES);
}

function encode(secret: Buffer, tag: Buffer): string {
  const bytes = Buffer.concat([secret, tag]);
  let n = BigInt(`0x${bytes.toString('hex')}`), out = '';
  for (let i = 0; i < WORD_LEN; i++) { out = ALPHABET[Number(n & 31n)] + out; n >>= 5n; }
  return out;
}

function decode(text: unknown): { secret: Buffer; tag: Buffer } | null {
  if (typeof text !== 'string') return null;
  const w = text.trim().toLowerCase().replace(/[ilo]/g, c => LOOKALIKE[c]);
  if (!WORD_RE.test(w)) return null;
  let n = 0n;
  for (const c of w) n = (n << 5n) | BigInt(ALPHABET.indexOf(c));
  if (n >> BigInt((SECRET_BYTES + TAG_BYTES) * 8)) return null; // more than 192 bits: not a word encode() made
  const bytes = Buffer.from(n.toString(16).padStart((SECRET_BYTES + TAG_BYTES) * 2, '0'), 'hex');
  return { secret: bytes.subarray(0, SECRET_BYTES), tag: bytes.subarray(SECRET_BYTES) };
}

function keyHolds(d: { secret: Buffer; tag: Buffer }, role: Role, key: unknown): boolean {
  if (!d || typeof key !== 'string' || !KEY_RE.test(key)) return false;
  return crypto.timingSafeEqual(tagOf(d.secret, role, key), d.tag);
}

const idOf = (secret: Buffer): string => Buffer.from(secret).toString('base64url');
const admissionRef = (secret: Buffer): string => crypto.createHash('sha256').update(`${idOf(secret)}/admission`).digest('hex').slice(0, 12);

export { ALPHABET, SECRET_BYTES, TAG_BYTES, WORD_LEN, WORD_RE, ROLES, mint, tagOf, encode, decode, keyHolds, idOf, admissionRef };
export type { Role };
