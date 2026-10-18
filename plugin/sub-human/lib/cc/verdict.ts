/**
 * plugin/sub-human/lib/cc/verdict.ts: what this machine found when it checked a Claude Code version against the
 * internals contract (contract.json), kept per version, and which features run their fallback on it.
 *
 * <home>/cc/<version>.json = {version, probedAt, contract, failed: [entry ids], off: [features]} (atomic). contract: a
 * hash of contract.json, so a plugin update that changes the contract checks the version again. failed: the entries
 * the probe (contract.ts probe) did not find in the binary, plus those reported changed on the version (degradedOn).
 * off: the gated features (mod/core/cc.ts GATED: room-session, tasks, plan-edit, sign-off) of failed entries, sign-off
 * implying plan-edit. A failed entry of any other feature (core plumbing, rows, delivery, ...) turns nothing off: it
 * only makes the version unverified (doctor warns). The version contract.json `probed` names is verified without a
 * probe. <home>/cc/seen.json = {version, at}: the version mod-hello last saw on this machine, for a process that has no
 * session to ask (the host's tail, a detached spawn).
 *
 * The check costs ~3-5 s (a read of the binary) and never runs on a hot path: mod-hello (hooks/handlers/mod-hello.ts)
 * calls ensure(), which reads the file (~1 ms) and, when there is none, starts `node lib/cc/verdict.ts run VERSION`
 * detached. The runner probes only the binary whose VERSION is that version (contract.ts locateBinary, binaryVersion;
 * a session on an older binary than the one on PATH is never judged by the newer one), under one lock per version.
 *
 * How a process learns the version its session runs on: the hooks module reads $.session.version at each hello and
 * hands it to mod-hello, which keeps it in the session's mod lease (lib/identity.ts writeModLease, cc_version) and in
 * seen.json. off(feature, {sid}) reads the lease's; off(feature) with neither sid nor version reads seen.json's.
 *
 *   file(version) -> path | null                  <home>/cc/<version>.json (null: not a version)
 *   read(version) -> Verdict | null               the kept verdict, if it was made with this contract
 *   verified(v) -> bool                           no entry failed
 *   judge(version, failed, {entries?, now?}) -> Verdict   the verdict for those failed ids (pure but for the hash)
 *   record(version, failed) -> Verdict | null    judge and keep it (the runner; doctor after its own probe)
 *   forced(env?) -> Gated[]                       SUB_HUMAN_CC_OFF's features (closed: sign-off implies plan-edit)
 *   offFor(version) -> Gated[]                    forced() and the version's verdict's off
 *   off(feature, {version?, sid?}?) -> bool       feature runs its fallback for that version (see above for the default)
 *   sessionVersion(sid) -> string | null          the version the session's lease names
 *   seen() -> string | null;  noteSeen(version)   seen.json
 *   ensure(version) -> Verdict | null             read, else (the probed version) judged now, else runDetached; never waits
 *   runDetached(version)                          the runner, detached and unref'd (skipped while one holds the lock)
 *   run(version, {env?}) -> Verdict | null        the probe under the version's lock; null when it cannot judge (no
 *                                                 binary, another version's, the lock held, a binary with none of them)
 *   hello(version, kept?) -> {version, verified, off}   what mod-hello hands the module (types/index.d.ts SubHumanCc):
 *                                                 verified null while the version has no verdict
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { home } from '../home.ts';
import { readJson, writeJsonAtomic, lazy } from '../io.ts';
import { obj, str, arr } from '../decode.ts';
import { envStr } from '../env.ts';
import { errCode } from '../errors.ts';
import { isCcVersion, closeOff, isGated } from '../../mod/core/cc.ts';
import type { Gated, Cc } from '../../mod/core/cc.ts';
import type * as ContractMod from './contract.ts';
import type * as LockMod from '../lock.ts';
import type * as IdentityMod from '../identity.ts';
import type * as BgMod from './bg.ts';

const contractLib = lazy<typeof ContractMod>(import.meta.url, './contract.ts');
const lockLib = lazy<typeof LockMod>(import.meta.url, '../lock.ts');
const identityLib = lazy<typeof IdentityMod>(import.meta.url, '../identity.ts');
const bgLib = lazy<typeof BgMod>(import.meta.url, './bg.ts');

/** A version's verdict, as kept in <home>/cc/<version>.json. */
interface Verdict { version: string; probedAt: string; contract: string; failed: string[]; off: Gated[] }
const VERDICT = obj({ version: str, probedAt: str, contract: str, failed: arr(str), off: arr(str) });
const SEEN = obj({ version: str });

/** How long a runner may hold a version's lock before another may take it (a live runner's is never broken). */
const RUN_STALE_MS = 120_000;
const CONTRACT_FILE = path.join(import.meta.dirname, 'contract.json');

let contractHash: { at: number; hash: string } | null = null;
/** contract.json's sha256 (12 hex digits), read again when the file changes. */
function hashOfContract(): string {
  let mt = 0;
  try { mt = fs.statSync(CONTRACT_FILE).mtimeMs; } catch { return 'none'; }
  if (contractHash && contractHash.at === mt) return contractHash.hash;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(CONTRACT_FILE)).digest('hex').slice(0, 12);
  contractHash = { at: mt, hash };
  return hash;
}

const dir = (): string => path.join(home(), 'cc');
const file = (version: unknown): string | null => (isCcVersion(version) ? path.join(dir(), `${version}.json`) : null);

function read(version: unknown): Verdict | null {
  const f = file(version);
  const v = f ? readJson(f, VERDICT, null) : null;
  if (!v || v.version !== version || v.contract !== hashOfContract()) return null;
  return { version: v.version, probedAt: v.probedAt, contract: v.contract, failed: v.failed, off: closeOff(v.off) };
}

const verified = (v: Verdict): boolean => v.failed.length === 0;

function judge(version: string, failed: readonly string[], { entries, now = Date.now() }: { entries?: readonly ContractMod.ContractEntry[]; now?: number } = {}): Verdict {
  const cc = contractLib();
  const all = entries ?? cc.CONTRACT;
  const ids = new Set(failed);
  for (const d of cc.degradedOn(version, all)) ids.add(d.id);
  const ordered = all.filter(e => ids.has(e.id));
  return {
    version, probedAt: new Date(now).toISOString(), contract: hashOfContract(),
    failed: ordered.map(e => e.id),
    off: closeOff(ordered.map(e => e.feature).filter(isGated)),
  };
}

function forced(env: NodeJS.ProcessEnv = process.env): Gated[] {
  return closeOff(String(envStr('SUB_HUMAN_CC_OFF', env) ?? '').split(',').map(s => s.trim()));
}

const offFor = (version: unknown): Gated[] => closeOff([...forced(), ...(read(version)?.off ?? [])]);

function sessionVersion(sid: unknown): string | null {
  try { const v = identityLib().readModLease(sid)?.cc_version; return isCcVersion(v) ? v : null; } catch { return null; }
}

function seen(): string | null {
  const v = readJson(path.join(dir(), 'seen.json'), SEEN, null)?.version;
  return isCcVersion(v) ? v : null;
}
/** Record version as the one last seen here, unless it is already. */
function noteSeen(version: unknown): void {
  if (!isCcVersion(version) || seen() === version) return;
  writeJsonAtomic(path.join(dir(), 'seen.json'), { version, at: new Date().toISOString() });
}

function off(feature: Gated, { version, sid }: { version?: string | null; sid?: unknown } = {}): boolean {
  if (forced().includes(feature)) return true;
  const v = version ?? (sid !== undefined ? sessionVersion(sid) : seen());
  return !!v && offFor(v).includes(feature);
}

const lockOf = (f: string): string => `${f}.lock`;

/** Keep the verdict for version's failed ids (the runner's probe, or doctor's own). */
function record(version: string, failed: readonly string[]): Verdict | null {
  const f = file(version);
  if (!f) return null;
  const v = judge(version, failed);
  writeJsonAtomic(f, v);
  return v;
}

/** A runner that found no binary of the version (the session's own, CLAUDE_BIN, PATH, the cask) leaves missOf; the
 * hellos start no other for MISS_MS, so a version nothing here can read is not probed on every hello. */
const missOf = (f: string): string => `${f}.miss`;
const MISS_MS = 3_600_000;
const missedLately = (f: string): boolean => {
  try { return Date.now() - fs.statSync(missOf(f)).mtimeMs < MISS_MS; } catch { return false; }
};

/** The kept verdict for version, else one started in the background. pid: the session's claude process, whose own
 * executable is probed first (the `claude` on PATH may be another version). */
function ensure(version: unknown, { pid }: { pid?: number | null } = {}): Verdict | null {
  const f = file(version);
  if (!f || !isCcVersion(version)) return null;
  const kept = read(version);
  if (kept) return kept;
  if (contractLib().compareVersions(version, contractLib().PROBED_VERSION) === 0) {
    return record(version, []); // the version every entry was checked on: nothing to probe
  }
  if (!fs.existsSync(lockOf(f)) && !missedLately(f)) runDetached(version, exeOf(pid));
  return null;
}

/** pid's executable, absolute: /proc on Linux (cc.exeState); on macOS `ps` names only `claude` for one started from
 * PATH, so the first text mapping `lsof` lists (the executable) instead. Only on a hello with no verdict yet. */
function exeOf(pid: number | null | undefined): string | null {
  if (!pid) return null;
  try {
    const st = bgLib().exeState(pid);
    if (st && !st.deleted && path.isAbsolute(st.exe)) return st.exe;
    const out = String(spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { encoding: 'utf8', timeout: 3000 }).stdout || '');
    const exe = /^n(\/.+)$/m.exec(out)?.[1];
    return exe && path.isAbsolute(exe) ? exe : null;
  } catch { return null; }
}

function runDetached(version: string, bin: string | null = null): void {
  if (!isCcVersion(version)) return;
  const p = spawn(process.execPath, [import.meta.filename, 'run', version, ...(bin ? [bin] : [])], { detached: true, stdio: 'ignore', env: { ...process.env, SUB_HUMAN_HOME: home() } });
  p.on('error', () => { /* the next hello starts another */ });
  p.unref();
}

function run(version: string, { env = process.env, bin }: { env?: NodeJS.ProcessEnv; bin?: string | null } = {}): Verdict | null {
  const f = file(version);
  if (!f) return null;
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  try {
    return lockLib().withLock(lockOf(f), () => {
      const kept = read(version);
      if (kept) return kept;
      const cc = contractLib();
      // only the binary this version is: a session on 2.1.296 is not judged by a 2.1.302 put on PATH since. The
      // session's own executable first, then CLAUDE_BIN, PATH and the cask
      const tries = [...new Set([bin ? cc.locateBinary({ bin, env: {} }) : null, cc.locateBinary({ env })].filter((b): b is string => !!b))];
      for (const b of tries) {
        const buf = fs.readFileSync(b);
        if (cc.compareVersions(cc.binaryVersion(buf), version) !== 0) continue;
        const results = cc.probe(buf);
        // every entry missing is a probe that read the wrong thing, not every internal changed at once
        if (results.every(r => !r.ok)) continue;
        return record(version, results.filter(r => !r.ok).map(r => r.id));
      }
      fs.writeFileSync(missOf(f), '');
      return null;
    }, { timeoutMs: 100, staleMs: RUN_STALE_MS });
  } catch (e) {
    if (errCode(e) === 'LOCK') return null; // another runner is on it
    throw e;
  }
}

function hello(version: string, v: Verdict | null = read(version)): Cc {
  const f = forced();
  return { version, verified: v ? verified(v) : null, off: closeOff([...f, ...(v?.off ?? [])]), ...(f.length ? { forced: f } : {}) };
}

export { file, read, verified, judge, record, forced, offFor, off, sessionVersion, seen, noteSeen, ensure, exeOf, runDetached, run, hello };
export type { Verdict };

if (import.meta.main) {
  const [cmd, version, bin] = process.argv.slice(2);
  if (cmd !== 'run' || !isCcVersion(version)) { process.stderr.write('usage: node lib/cc/verdict.ts run VERSION [BINARY]\n'); process.exit(2); }
  const v = run(version, { bin: bin ?? null });
  process.stdout.write(JSON.stringify(v) + '\n');
}
