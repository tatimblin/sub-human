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

function verify(p: unknown, room: string, now = Date.now()): string | null {
  const x = p as Partial<Proof> | null | undefined;
  if (!x || typeof x.key !== 'string' || !KEY_RE.test(x.key) || !Number.isFinite(x.ts) || typeof x.sig !== 'string') return null;
  if (Math.abs(now - (x.ts as number)) > SIG_SKEW_MS) return null;
  try {
    const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(x.key, 'base64url')]), format: 'der', type: 'spki' });
    return crypto.verify(null, message(room, x.ts as number), pub, Buffer.from(x.sig, 'base64url')) ? idOf(x.key) : null;
  } catch { return null; }
}

export { proof, verify, idOf };
export type { Proof as MachineProof };
