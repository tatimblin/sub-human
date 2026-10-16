/**
 * plugin/sub-human/lib/cli/doctor/redact.ts: `doctor --bundle` (lib/cli/doctor.ts): the report as redacted JSON to attach
 * to a bug report.
 *
 *   bundle(report, {salt?, env?}?) -> object   allowlisted fields only, every free text through redactor()
 *   redactor({home?, shHome?, hosts?, users?, rooms?, members?, salt?}) -> (text) -> text   ~ for paths under $HOME,
 *       <sub-human-home> for SUB_HUMAN_HOME elsewhere; hashed room codes, member names, hostnames, users and IPs;
 *       invites, tokens, long hex and secrets cut; SSH public keys as a SHA256 fingerprint prefix
 *   fingerprint(base64) -> 'SHA256:…'
 *   redact(secret) -> '####'   the one formatter of a secret (lib/brand.ts Secret: a PIN, an invite's SECRET or sh2
 *       invite, a link token) for text a person, a transcript or a log reads; only the reply that hands a secret
 *       over (the invite line, shown to its person alone) prints one (test/secrets.node-test.ts)
 */
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { lib } from './check.ts';
import { webRooms, webHosts } from './listener.ts';
import type { Report } from '../types.ts';
import type { Secret } from '../../brand.ts';

/** A secret, hidden: what a line shows in its place. */
const redact = (_secret: Secret): string => '####';

/** redactor(opts): what to hash, and the salt. */
interface RedactorOptions {
  home?: string;
  shHome?: string;
  hosts?: string[];
  users?: string[];
  rooms?: string[];
  members?: string[];
  salt?: string;
}

const hash8 = (s: string, salt: string) => crypto.createHash('sha256').update(`${salt}:${s}`).digest('hex').slice(0, 8);
const KEY_RE = /\b(ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) ([A-Za-z0-9+/]{16,}={0,3})/g;
function fingerprint(b64: string): string {
  try { return 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '').slice(0, 12); } catch { return 'SHA256:?'; }
}

function redactor({ home = os.homedir(), shHome = lib('home.ts').home(), hosts = [], users = [], rooms = [], members = [], salt = crypto.randomBytes(8).toString('hex') }: RedactorOptions = {}): (text: unknown) => string {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  const homes = [...new Set([home, real(home)].filter(h => h && h !== '/'))].sort((a, b) => b.length - a.length);
  // a SUB_HUMAN_HOME outside $HOME (a temp dir, another disk) names nothing under ~: it is <sub-human-home>
  const under = (p: string) => homes.some(h => p === h || p.startsWith(h + '/'));
  const shHomes = [...new Set([shHome, real(shHome)].filter(h => h && h !== '/' && !under(h)))].sort((a, b) => b.length - a.length);
  const names = [...new Set([...hosts, os.hostname(), os.hostname().split('.')[0]].filter(h => h && h.length > 2 && h !== 'localhost'))].sort((a, b) => b.length - a.length);
  const people = [...new Set([...users, (() => { try { return os.userInfo().username; } catch { return ''; } })()].filter(u => u && u.length > 2))];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text => {
    let s = String(text == null ? '' : text).replace(/\x1b\[[0-9;]*m/g, '');
    s = s.replace(KEY_RE, (_: string, type: string, b64: string) => `${type} ${fingerprint(b64)}`);
    s = s.replace(/\bsh\d\.[A-Za-z0-9._~:-]+/g, 'sh2.<invite>');
    // an invite's PIN is its whole secret (join DEST ROOM 4829; a promote's sh2 PIN has 6 digits): any lone 4- or
    // 6-digit number goes
    s = s.replace(/(?<![\w.:/-])(?:\d{4}|\d{6})(?![\w.:/-])/g, '<pin>');
    for (const h of shHomes) s = s.replace(new RegExp(`${esc(h)}(?![^/\\s"':,)])`, 'g'), '<sub-human-home>');
    for (const h of homes) s = s.replace(new RegExp(`${esc(h)}(?![^/\\s"':,)])`, 'g'), '~');
    // a pipe link names another home on this machine: never its path
    s = s.replace(/\bpipe([: ])(\/[^\s"'),]+)/g, (_: string, sep: string, p: string) => `pipe${sep}<home-${hash8(p, salt)}>`);
    s = s.replace(/\/(Users|home)\/[^/\s"']+/g, '/$1/<user>');
    for (const n of names) s = s.replace(new RegExp(`(?<![\\w.-])${esc(n)}(?![\\w-])`, 'g'), `host-${hash8(n, salt)}`);
    for (const u of people) s = s.replace(new RegExp(`(?<![\\w.-])${esc(u)}(?=@)`, 'g'), `user-${hash8(u, salt)}`);
    for (const r of rooms) s = s.replace(new RegExp(`(?<![\\w-])${esc(r)}(?![\\w-])`, 'g'), `room-${hash8(r, salt)}`);
    for (const m of members) s = s.replace(new RegExp(`(?<![\\w.-])${esc(m)}(?![\\w-])`, 'g'), `member-${hash8(m, salt)}`);
    // any other user@host (an email, an ssh destination this machine has no link to)
    s = s.replace(/(?<![\w.-])([A-Za-z0-9_.+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, (_m: string, u: string, h: string) => `user-${hash8(u, salt)}@host-${hash8(h, salt)}`);
    s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, m => `ip-${hash8(m, salt)}`);
    s = s.replace(/\b[0-9a-f]{16,}\b/gi, '<hex>');
    s = s.replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g, '<secret>');
    s = s.replace(/\b(token|secret|password|passwd|authorization|bearer)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2<redacted>');
    return s;
  };
}

/** The report as an allowlist: versions, config, check verdicts, link states and recent errors; no message text. */
function bundle(report: Report, { salt, env = process.env }: { salt?: string; env?: NodeJS.ProcessEnv } = {}) {
  const links = report.links || [];
  const s = salt || crypto.randomBytes(8).toString('hex'); // per bundle: names hash the same within it, never across
  const red = redactor({
    salt: s,
    hosts: [...links.map(d => d.transport.host), ...webHosts()].filter((h): h is string => !!h),
    users: links.map(d => d.transport.user).filter((u): u is string => !!u),
    rooms: [...links.map(d => d.code), ...webRooms()],
    members: links.map(d => d.moved && d.moved.host).filter((m): m is string => !!m && m.length > 1),
  });
  const config = lib('config.ts');
  const timings = Object.fromEntries(Object.entries(config).filter(([k, v]) => /^[A-Z][A-Z0-9_]+$/.test(k) && (typeof v === 'number' || typeof v === 'boolean')));
  const overrides = Object.fromEntries(Object.entries(env).filter(([k]) => lib('env.ts').TIMING_ENV_RE.test(k)).map(([k, v]) => [k, Number(v)]));
  const opt = <T>(x: T): T | undefined => (x === undefined || x === null ? undefined : x);
  return {
    kind: 'sub-human-doctor-bundle', format: 1, generated_at: report.generated_at,
    note: 'redacted: no messages, keys, tokens or invites; paths under $HOME are ~, host and user names hashed',
    versions: { ...report.versions, os: red(report.versions.os), ssh: red(report.versions.ssh || '') || null },
    config: { timings, env_overrides: overrides, ssh_opts_set: !!lib('env.ts').envStr('SUB_HUMAN_SSH_OPTS', env), home_is_default: !lib('env.ts').envStr('SUB_HUMAN_HOME', env) },
    checks: report.checks.map(x => ({ id: red(x.id), status: x.status, title: red(x.title), detail: red(x.detail), ...(x.fix ? { fix: red(x.fix) } : {}) })),
    links: links.map(d => ({
      room: `room-${hash8(d.code, s)}`,
      transport: { kind: d.transport.kind, host: d.transport.host ? `host-${hash8(d.transport.host, s)}` : undefined, user: d.transport.user ? `user-${hash8(d.transport.user, s)}` : undefined, port: opt(d.transport.port) },
      credential: d.credential,
      moved: d.moved ? { epoch: d.moved.epoch, demoted: d.moved.demoted, reached: d.moved.reached } : undefined,
      daemon: { running: d.daemon.running },
      state: { state: d.state.state, since: opt(d.state.since), attempt: opt(d.state.attempt), rttMs: opt(d.state.rttMs), queued: opt(d.state.queued), lastError: d.state.lastError ? red(d.state.lastError) : undefined, source: d.state.source },
      reach: d.reach ? { ok: d.reach.ok, ms: d.reach.ms, skipped: d.reach.skipped, error: d.reach.error ? red(d.reach.error) : undefined, protocol: d.reach.protocol, skewMs: d.reach.skewMs, ssh_error: d.reach.stderr ? red(d.reach.stderr).split('\n').slice(-3) : undefined } : undefined,
      recent_errors: d.recent.map(red),
    })),
    authorized_keys: {
      exists: report.authorizedKeys.exists,
      lines: report.authorizedKeys.lines.map(l => ({ through_shim: !!l.shimmed, parsed: l.parse !== false, key: l.key ? `${l.type} ${fingerprint(l.key)}` : undefined })),
    },
    probe: report.probe,
  };
}

export { bundle, redactor, fingerprint, redact };
