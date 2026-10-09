'use strict';
/**
 * plugin/sub-human/lib/remote/sshkeys.js: the SSH key material of an ssh link, on both machines. Zero dependencies
 * beyond node:crypto, node:fs and lib/io.js; `ssh-keygen` makes the joiner's key (it ships wherever ssh does).
 *
 * The flow (sh2 over ssh; README "Over SSH"): the host's invite carries its sshd Ed25519 host key, which the joiner
 * pins (a known_hosts of the link's own, HostKeyAlias, StrictHostKeyChecking yes: no first-use prompt, no MITM). The
 * joiner makes a key of its own for the link (never a key that travelled) and shows its person an admit request,
 * shk1.CODE.REF.KEY.NAME, to send back to the host: REF names the invite (lib/remote/auth.js inviteRef, not its
 * secret), KEY is the joiner's public key and NAME who asks (shown to the host, not trusted). The host's person
 * admits it (/sub-human admit REQUEST, or `sub-human admit`): the authorized_keys line with the forced command for
 * that invite's link (lib/remote/shim.js). ssh then connects, and the link's first hello still needs the PIN.
 *
 *   ed25519Raw(line) -> base64url | null      the 32-byte key of an "ssh-ed25519 AAAA… [comment]" line
 *   openssh(raw) -> "ssh-ed25519 AAAA…"        the public key line for a 32-byte key (base64url)
 *   fingerprint(raw) -> "SHA256:…"            as ssh-keygen -l prints it
 *   hostKey({file?}) -> base64url | null      this machine's sshd Ed25519 host key: SUB_HUMAN_SSH_HOST_KEY (a .pub
 *                                              file), else /etc/ssh/ssh_host_ed25519_key.pub; null when unreadable
 *   knownHostsLine(alias, raw) -> string      "<alias> ssh-ed25519 AAAA…" (the link's HostKeyAlias)
 *   linkKey(dir, comment) -> {file, pub, raw} the link's own key in dir (id_ed25519, 0600), made once by ssh-keygen
 *   publicKey(text) -> "type base64" | null   the one public key line in text (ed25519, rsa, ecdsa, sk-*; no options),
 *                                              for `sub-human authorize PUBKEY`
 *   formatRequest({code, ref, key, name}) -> "shk1.CODE.REF.KEY.NAME";  parseRequest(text) -> {…} | null
 *   authorizedKeysFile() -> string            SUB_HUMAN_AUTHORIZED_KEYS, else ~/.ssh/authorized_keys
 *   appendAuthorized(file, line, key) -> 'added' | 'present'   append line (0600, dir 0700) unless it is there;
 *                                              RoomError INVALID when key is in the file with another line
 *   removeAuthorized(file, code, id) -> n     drop every line that ends "sub-human:CODE:ID"; the count
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { RoomError } = require('../room/validate.js');
const { CODE_RE, NAME_RE } = require('../text.js');

const TYPE = 'ssh-ed25519';
const RAW_RE = /^[A-Za-z0-9_-]{43}$/;
const REQ_PREFIX = 'shk1';

/** The SSH wire form of an Ed25519 public key: string "ssh-ed25519", string key. */
function wire(raw) {
  const k = Buffer.from(raw, 'base64url');
  const t = Buffer.from(TYPE);
  const len = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return Buffer.concat([len(t.length), t, len(k.length), k]);
}

/**
 * @param {string} line
 * @returns {string | null}
 */
function ed25519Raw(line) {
  const m = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,3})(?:\s.*)?$/.exec(String(line).trim());
  if (!m) return null;
  const b = Buffer.from(m[1], 'base64');
  if (b.length !== 51 || b.readUInt32BE(0) !== 11 || b.subarray(4, 15).toString() !== TYPE || b.readUInt32BE(15) !== 32) return null;
  return b.subarray(19).toString('base64url');
}

/** @returns {string} */
const openssh = raw => `${TYPE} ${wire(raw).toString('base64')}`;
/** @returns {string} */
const fingerprint = raw => `SHA256:${crypto.createHash('sha256').update(wire(raw)).digest('base64').replace(/=+$/, '')}`;
/** @returns {string} */
const knownHostsLine = (alias, raw) => `${alias} ${openssh(raw)}`;

/**
 * @param {{file?: string}} [opts]
 * @returns {string | null}
 */
function hostKey({ file = process.env.SUB_HUMAN_SSH_HOST_KEY || '/etc/ssh/ssh_host_ed25519_key.pub' } = {}) {
  try { return ed25519Raw(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * @param {string} dir
 * @param {string} comment
 * @returns {{file: string, pub: string, raw: string}}
 */
function linkKey(dir, comment) {
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
 * @param {string} text
 * @returns {string | null}
 */
function publicKey(text) {
  const lines = String(text).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const m = lines.length === 1 && SSH_KEY_RE.exec(lines[0]);
  return m ? `${m[1]} ${m[2]}` : null;
}

/** @returns {string} */
const formatRequest = ({ code, ref, key, name }) => [REQ_PREFIX, code, ref, key, name].join('.');

/**
 * @param {string} text
 * @returns {{code: string, ref: string, key: string, name: string} | null}
 */
function parseRequest(text) {
  const parts = typeof text === 'string' ? text.trim().split('.') : [];
  if (parts.length < 5 || parts[0] !== REQ_PREFIX) return null;
  const [, code, ref, key, ...rest] = parts;
  const name = rest.join('.');
  if (!CODE_RE.test(code) || !/^[0-9a-f]{12}$/.test(ref) || !RAW_RE.test(key) || !NAME_RE.test(name)) return null;
  if (Buffer.from(key, 'base64url').length !== 32) return null;
  return { code, ref, key, name };
}

/** @returns {string} */
const authorizedKeysFile = () => process.env.SUB_HUMAN_AUTHORIZED_KEYS || path.join(os.homedir(), '.ssh', 'authorized_keys');

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}

/**
 * @param {string} file
 * @param {string} line
 * @param {string} key   "type base64"
 * @returns {'added' | 'present'}
 */
function appendAuthorized(file, line, key) {
  const cur = readText(file);
  const lines = cur.split('\n');
  if (lines.includes(line)) return 'present';
  const blob = key.split(' ')[1];
  if (lines.some(l => l.split(/\s+/).includes(blob))) throw new RoomError('INVALID', `that key is in ${file} already, with another line; remove it first`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n', { mode: 0o600 });
  return 'added';
}

/**
 * @param {string} file
 * @param {string} code
 * @param {string} id
 * @returns {number}
 */
function removeAuthorized(file, code, id) {
  const cur = readText(file);
  if (!cur) return 0;
  const tag = `sub-human:${code}:${id}`;
  const lines = cur.split('\n');
  const kept = lines.filter(l => !l.trimEnd().endsWith(` ${tag}`));
  const n = lines.length - kept.length;
  if (n) require('../io.js').writeFileAtomic(fs.realpathSync(file), kept.join('\n'), { mode: 0o600 });
  return n;
}

module.exports = {
  ed25519Raw, openssh, fingerprint, hostKey, knownHostsLine, linkKey, publicKey, formatRequest, parseRequest,
  authorizedKeysFile, appendAuthorized, removeAuthorized,
};
