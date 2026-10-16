/**
 * plugin/sub-human/lib/remote/sshkeys.ts: the SSH key material of an ssh link, on both machines. Zero dependencies
 * beyond node:crypto, node:fs and lib/io.ts; `ssh-keygen` makes the joiner's key (it ships wherever ssh does).
 *
 * The joiner pins the host's sshd Ed25519 host key (a known_hosts of the link's own, HostKeyAlias,
 * StrictHostKeyChecking yes: no first-use prompt, no MITM): an invite's PIN vouches for it (lib/remote/enroll.ts), or
 * a handoff's invite carries it. The joiner makes a key of its own for the link (never a key that travelled); the
 * host's person lets it in on the card (lib/remote/admission.ts): the authorized_keys line with the forced command
 * for that link (lib/remote/shim.ts).

 *   ed25519Raw(line) -> base64url | null      the 32-byte key of an "ssh-ed25519 AAAA… [comment]" line
 *   openssh(raw) -> "ssh-ed25519 AAAA…"        the public key line for a 32-byte key (base64url)
 *   fingerprint(raw) -> "SHA256:…"            as ssh-keygen -l prints it
 *   hostKey({file?}) -> base64url | null      this machine's sshd Ed25519 host key: SUB_HUMAN_SSH_HOST_KEY (a .pub
 *                                              file), else /etc/ssh/ssh_host_ed25519_key.pub; null when unreadable
 *   knownHostsLine(alias, raw) -> string      "<alias> ssh-ed25519 AAAA…" (the link's HostKeyAlias)
 *   linkKey(dir, comment) -> {file, pub, raw} the link's own key in dir (id_ed25519, 0600), made once by ssh-keygen
 *   publicKey(text) -> "type base64" | null   the one public key line in text (ed25519, rsa, ecdsa, sk-*; no options)
 *   formatRequest({code, ref, key, name}) -> "shk1.CODE.REF.KEY.NAME"   a handoff follower's key the new host has not
 *                                              let in yet (the link file's request; no secret in it)
 *   authorizedKeysFile() -> string            SUB_HUMAN_AUTHORIZED_KEYS, else ~/.ssh/authorized_keys
 *   appendAuthorized(file, line, key) -> 'added' | 'present'   append line (0600, dir 0700) unless it is there;
 *                                              RoomError INVALID when key is in the file with another line
 *   removeAuthorized(file, code, id) -> n     drop every line that ends "sub-human:CODE:ID"; the count
 *   removeTagged(file, tag) -> n              drop every line that ends " TAG" (the enrollment door: sub-human-enroll:CODE)
 *
 * The short code's enrollment door (lib/remote/enroll.ts): sshd has to let a joiner that holds no admitted key yet
 * reach `serve --enroll CODE`, and nothing else. Its key is PUBLIC by design: anyone who knows the room code derives it
 * (it is never derived from the 4-digit PIN, so it leaks nothing a guess could be checked against offline), and the
 * forced command behind it only runs the PAKE, whose tries the host counts.
 *   enrollKey(code) -> {seed, raw, pub}       the Ed25519 key of seed sha256("sub-human enroll key v1\0" + code)
 *   opensshPrivate({seed, raw, comment}) -> string   that key as an unencrypted openssh-key-v1 file (ssh -i reads it)
 *   writeEnrollKey(dir, code) -> file         dir/enroll_ed25519 (0600) with its .pub, for the joiner's ssh
 *   ENROLL_TAG(code) -> 'sub-human-enroll:CODE'
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { RoomError } from '../room/validate.ts';
import { CODE_RE } from '../text.ts';
import * as io from '../io.ts';


const TYPE = 'ssh-ed25519';
const REQ_PREFIX = 'shk1';

/** The SSH wire form of an Ed25519 public key: string "ssh-ed25519", string key. */
function wire(raw: string): Buffer {
  const k = Buffer.from(raw, 'base64url');
  const t = Buffer.from(TYPE);
  const len = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return Buffer.concat([len(t.length), t, len(k.length), k]);
}

function ed25519Raw(line: string): string | null {
  const m = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,3})(?:\s.*)?$/.exec(String(line).trim());
  if (!m) return null;
  const b = Buffer.from(m[1], 'base64');
  if (b.length !== 51 || b.readUInt32BE(0) !== 11 || b.subarray(4, 15).toString() !== TYPE || b.readUInt32BE(15) !== 32) return null;
  return b.subarray(19).toString('base64url');
}

const openssh = (raw: string): string => `${TYPE} ${wire(raw).toString('base64')}`;
const fingerprint = (raw: string): string => `SHA256:${crypto.createHash('sha256').update(wire(raw)).digest('base64').replace(/=+$/, '')}`;
const knownHostsLine = (alias: string, raw: string): string => `${alias} ${openssh(raw)}`;

function hostKey({ file = process.env.SUB_HUMAN_SSH_HOST_KEY || '/etc/ssh/ssh_host_ed25519_key.pub' }: { file?: string } = {}): string | null {
  try { return ed25519Raw(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The link's own key: its file, its public key line and its raw key (base64url). */
function linkKey(dir: string, comment: string): { file: string; pub: string; raw: string } {
  const file = path.join(dir, 'id_ed25519');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error || r.status !== 0) throw new RoomError('INVALID', `ssh-keygen could not make the link's key: ${(r.error && r.error.message) || r.stderr.trim()}`);
  }
  fs.chmodSync(`${file}.pub`, 0o600); // ssh-keygen leaves it 0644; nothing in the store is group/world-readable
  const pub = fs.readFileSync(`${file}.pub`, 'utf8').trim();
  const raw = ed25519Raw(pub);
  if (!raw) throw new RoomError('INVALID', `${file}.pub is not an Ed25519 key`);
  return { file, pub, raw };
}

const SSH_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) ([A-Za-z0-9+/]+={0,3})(?: .*)?$/;

/**
 * The one public key in text (a .pub or authorized_keys line of any common type, no options, comments and blank
 * lines skipped): "type base64", or null when there is not exactly one.
 */
function publicKey(text: string): string | null {
  const lines = String(text).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const m = lines.length === 1 && SSH_KEY_RE.exec(lines[0]);
  return m ? `${m[1]} ${m[2]}` : null;
}

const formatRequest = ({ code, ref, key, name }: { code: string; ref: string; key: string; name: string }): string => [REQ_PREFIX, code, ref, key, name].join('.');

const authorizedKeysFile = (): string => process.env.SUB_HUMAN_AUTHORIZED_KEYS || path.join(os.homedir(), '.ssh', 'authorized_keys');

function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
}

/** key: "type base64" */
function appendAuthorized(file: string, line: string, key: string): 'added' | 'present' {
  const cur = readText(file);
  const lines = cur.split('\n');
  if (lines.includes(line)) return 'present';
  const blob = key.split(' ')[1];
  if (lines.some(l => l.split(/\s+/).includes(blob))) throw new RoomError('INVALID', `that key is in ${file} already, with another line; remove it first`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n', { mode: 0o600 });
  return 'added';
}

function removeAuthorized(file: string, code: string, id: string): number {
  const cur = readText(file);
  if (!cur) return 0;
  const tag = `sub-human:${code}:${id}`;
  const lines = cur.split('\n');
  const kept = lines.filter(l => !l.trimEnd().endsWith(` ${tag}`));
  const n = lines.length - kept.length;
  if (n) io.writeFileAtomic(fs.realpathSync(file), kept.join('\n'), { mode: 0o600 });
  return n;
}

function removeTagged(file: string, tag: string): number {
  const cur = readText(file);
  if (!cur) return 0;
  const lines = cur.split('\n');
  const kept = lines.filter(l => !l.trimEnd().endsWith(` ${tag}`));
  const n = lines.length - kept.length;
  if (n) io.writeFileAtomic(fs.realpathSync(file), kept.join('\n'), { mode: 0o600 });
  return n;
}

// ---------- the enrollment door's key ----------
const ENROLL_TAG = (code: string): string => `sub-human-enroll:${code}`;
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function enrollKey(code: string): { seed: Buffer; raw: string; pub: string } {
  if (!CODE_RE.test(String(code))) throw new RoomError('INVALID', `invalid room code "${code}"`);
  const seed = crypto.createHash('sha256').update(`sub-human enroll key v1\0${code}`).digest();
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  const raw = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519.length).toString('base64url');
  return { seed, raw, pub: openssh(raw) };
}

/** openssh-key-v1 (PROTOCOL.key): no cipher, no kdf, one key; the private part is seed || public key. */
function opensshPrivate({ seed, raw, comment = '' }: { seed: Buffer; raw: string; comment?: string }): string {
  const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const str = (b: string | Buffer): Buffer => Buffer.concat([u32(Buffer.byteLength(b)), Buffer.from(b)]);
  const pub = Buffer.from(raw, 'base64url');
  const check = crypto.createHash('sha256').update(pub).digest().subarray(0, 4);
  let priv = Buffer.concat([check, check, str(TYPE), str(pub), str(Buffer.concat([seed, pub])), str(comment)]);
  const pad = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), str('none'), str('none'), str(''), u32(1), str(wire(raw)), str(priv)]);
  const b64 = body.toString('base64').match(/.{1,70}/g)!.join('\n'); // a body is never empty
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function writeEnrollKey(dir: string, code: string): string {
  const k = enrollKey(code);
  const file = path.join(dir, 'enroll_ed25519');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, opensshPrivate({ ...k, comment: ENROLL_TAG(code) }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(`${file}.pub`, `${k.pub} ${ENROLL_TAG(code)}\n`, { mode: 0o600 });
  return file;
}

export {
  enrollKey, opensshPrivate, writeEnrollKey, removeTagged, ENROLL_TAG, ed25519Raw, openssh, fingerprint, hostKey,
  knownHostsLine, linkKey, publicKey, formatRequest, authorizedKeysFile, appendAuthorized, removeAuthorized,
};
