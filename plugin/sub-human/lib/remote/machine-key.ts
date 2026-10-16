/**
 * plugin/sub-human/lib/remote/machine-key.ts: this home's machine key, what its links present so the host derives the
 * machine's id from a key instead of taking the id a hello reports. An Ed25519 key pair made once per home,
 * <home>/keys/machine.json (0600, beside the seat keys: the hooks module refuses a model's Read under <home>/keys). Its
 * id is the same for every room and every host, so a machine that joins again (a new invite, a handoff's new host)
 * is the machine it was; nobody without the private key can be it.
 *
 *   proof(room, now?) -> {key, ts, sig}   key: the raw public key (base64url), sig: Ed25519 over
 *       "sub-human machine:<room>:<ts>" (the link daemon's hello, lib/remote/link-connect.ts)
 *   verify(proof, room, now?) -> id | null   the id the proof is for, when it verifies and ts is within SIG_SKEW_MS
 *       (lib/remote/server.ts hello)
 *   idOf(key) -> 'k' + 15 hex of sha256(key)   never like a home's own 16-hex id (lib/home.ts machineId)
 *   publicKey() -> string                 the raw public key (base64url): what an invite line's tag names over ssh and
 *       a pipe (lib/remote/invite-secret.ts, role 'machine')
 *   hostProof(room, nonce) -> {key, sig}  the host's half: Ed25519 over "sub-human host v3:<room>:<nonce>", the
 *       joiner's fresh nonce (lib/remote/server.ts hello), so the host proves the key before the joiner sends a secret
 *   verifyHost(proof, room, nonce) -> key | null   the joiner's half: the key, when sig verifies
 *   NONCE_RE                              a nonce: 16 to 64 base64url characters
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { home } from '../home.ts';
import { SIG_SKEW_MS } from '../room/envelope.ts';
import { machineKeyFile } from '../room/keys.ts';

interface Proof { key: string; ts: number; sig: string }
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex'); // the DER prefix of an Ed25519 SubjectPublicKeyInfo

const file = (): string => machineKeyFile();
const message = (room: string, ts: number): Buffer => Buffer.from(`sub-human machine:${room}:${ts}`);
const idOf = (key: string): string => `k${crypto.createHash('sha256').update(key).digest('hex').slice(0, 15)}`;

let cached: { home: string; priv: crypto.KeyObject; pub: string } | null = null;
function load(): { priv: crypto.KeyObject; pub: string } {
  const h = home();
  if (cached && cached.home === h) return cached;
  let rec: { priv?: string; pub?: string } | null = null;
  try { rec = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { rec = null; }
  if (!rec || typeof rec.priv !== 'string' || typeof rec.pub !== 'string') {
    const kp = crypto.generateKeyPairSync('ed25519');
    rec = { priv: kp.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), pub: kp.publicKey.export({ format: 'jwk' }).x! };
    fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, ...rec }) + '\n', { mode: 0o600 });
    try { fs.linkSync(tmp, file()); } catch { /* another process made it first: read theirs */ } finally { fs.rmSync(tmp, { force: true }); }
    rec = JSON.parse(fs.readFileSync(file(), 'utf8'));
  }
  cached = { home: h, priv: crypto.createPrivateKey(rec!.priv!), pub: rec!.pub! };
  return cached;
}

function proof(room: string, now = Date.now()): Proof {
  const { priv, pub } = load();
  return { key: pub, ts: now, sig: crypto.sign(null, message(room, now), priv).toString('base64url') };
}

const hostMessage = (room: string, nonce: string): Buffer => Buffer.from(`sub-human host v3:${room}:${nonce}`);
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const publicKey = (): string => load().pub;
const pubObj = (key: string): crypto.KeyObject => crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(key, 'base64url')]), format: 'der', type: 'spki' });

function hostProof(room: string, nonce: string): { key: string; sig: string } {
  const { priv, pub } = load();
  return { key: pub, sig: crypto.sign(null, hostMessage(room, nonce), priv).toString('base64url') };
}

function verifyHost(p: unknown, room: string, nonce: string): string | null {
  const x = p as { key?: unknown; sig?: unknown } | null | undefined;
  if (!x || typeof x.key !== 'string' || !KEY_RE.test(x.key) || typeof x.sig !== 'string' || !NONCE_RE.test(nonce)) return null;
  try { return crypto.verify(null, hostMessage(room, nonce), pubObj(x.key), Buffer.from(x.sig, 'base64url')) ? x.key : null; } catch { return null; }
}

function verify(p: unknown, room: string, now = Date.now()): string | null {
  const x = p as Partial<Proof> | null | undefined;
  if (!x || typeof x.key !== 'string' || !KEY_RE.test(x.key) || !Number.isFinite(x.ts) || typeof x.sig !== 'string') return null;
  if (Math.abs(now - (x.ts as number)) > SIG_SKEW_MS) return null;
  try {
    return crypto.verify(null, message(room, x.ts as number), pubObj(x.key), Buffer.from(x.sig, 'base64url')) ? idOf(x.key) : null;
  } catch { return null; }
}

export { proof, verify, idOf, publicKey, hostProof, verifyHost, NONCE_RE };
export type { Proof as MachineProof };
