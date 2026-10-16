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
 *       (lib/remote/server.ts hello: a token's or a login's hello, where the id decides nothing a replay could take)
 *   proofFor(room, challenge) -> {key, ts, sig}   sig over "sub-human machine v2:<room>:<challenge>": the host's
 *       challenge from the hello before (protocol 3), so the proof is good for that session's next hello alone
 *   verifyFor(proof, room, challenge) -> id | null   the id, when the proof is over this challenge (an invite line's
 *       hello: a proof a former host or anyone in between saw cannot be replayed to another session)
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
import { isMachineId } from '../text.ts';
import { readJson } from '../io.ts';
import { obj, str } from '../decode.ts';
import type { Infer } from '../decode.ts';
import { SIG_SKEW_MS } from '../room/envelope.ts';
import { machineKeyFile } from '../room/keys.ts';
import type { MachineId } from '../brand.ts';

interface Proof { key: string; ts: number; sig: string }
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex'); // the DER prefix of an Ed25519 SubjectPublicKeyInfo

const file = (): string => machineKeyFile();
const message = (room: string, ts: number): Buffer => Buffer.from(`sub-human machine:${room}:${ts}`);
function idOf(key: string): MachineId {
  const id = `k${crypto.createHash('sha256').update(key).digest('hex').slice(0, 15)}`;
  if (!isMachineId(id)) throw new Error('a machine key id is k and 15 hex'); // it always is
  return id;
}

let cached: { home: string; priv: crypto.KeyObject; pub: string } | null = null;
/** <home>/keys/machine.json as read: {v, priv (PKCS#8 PEM), pub (base64url)}; null when missing or not one. */
const KEY_REC = obj({ priv: str, pub: str });
const readKey = (): Infer<typeof KEY_REC> | null => readJson(file(), KEY_REC, null);
function load(): { priv: crypto.KeyObject; pub: string } {
  const h = home();
  if (cached && cached.home === h) return cached;
  let rec = readKey();
  if (!rec) {
    const kp = crypto.generateKeyPairSync('ed25519');
    const { x } = kp.publicKey.export({ format: 'jwk' });
    if (typeof x !== 'string') throw new Error('an Ed25519 public key exported no JWK x'); // an OKP key always has it
    rec = { priv: kp.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), pub: x };
    fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, ...rec }) + '\n', { mode: 0o600 });
    try { fs.linkSync(tmp, file()); } catch { /* another process made it first: read theirs */ } finally { fs.rmSync(tmp, { force: true }); }
    rec = readKey();
    if (!rec) throw new Error(`${file()}: not a machine key`); // another process's, unreadable
  }
  cached = { home: h, priv: crypto.createPrivateKey(rec.priv), pub: rec.pub };
  return cached;
}

function proof(room: string, now: number = Date.now()): Proof {
  const { priv, pub } = load();
  return { key: pub, ts: now, sig: crypto.sign(null, message(room, now), priv).toString('base64url') };
}

const boundMessage = (room: string, challenge: string): Buffer => Buffer.from(`sub-human machine v2:${room}:${challenge}`);
function proofFor(room: string, challenge: string, now: number = Date.now()): Proof {
  const { priv, pub } = load();
  return { key: pub, ts: now, sig: crypto.sign(null, boundMessage(room, challenge), priv).toString('base64url') };
}
function verifyFor(p: unknown, room: string, challenge: string | null | undefined): MachineId | null {
  const x = p as Partial<Proof> | null | undefined;
  if (!challenge || !x || typeof x.key !== 'string' || !KEY_RE.test(x.key) || typeof x.sig !== 'string') return null;
  try {
    return crypto.verify(null, boundMessage(room, challenge), pubObj(x.key), Buffer.from(x.sig, 'base64url')) ? idOf(x.key) : null;
  } catch { return null; }
}

const hostMessage = (room: string, nonce: string): Buffer => Buffer.from(`sub-human host v3:${room}:${nonce}`);
const NONCE_RE: RegExp = /^[A-Za-z0-9_-]{16,64}$/;
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

function verify(p: unknown, room: string, now: number = Date.now()): MachineId | null {
  const x = p as Partial<Proof> | null | undefined;
  if (!x || typeof x.key !== 'string' || !KEY_RE.test(x.key) || !Number.isFinite(x.ts) || typeof x.sig !== 'string') return null;
  if (Math.abs(now - (x.ts as number)) > SIG_SKEW_MS) return null;
  try {
    return crypto.verify(null, message(room, x.ts as number), pubObj(x.key), Buffer.from(x.sig, 'base64url')) ? idOf(x.key) : null;
  } catch { return null; }
}

export { proof, verify, proofFor, verifyFor, idOf, publicKey, hostProof, verifyHost, NONCE_RE };
export type { Proof as MachineProof };
