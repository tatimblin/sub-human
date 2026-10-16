/**
 * plugin/sub-human/lib/cli/doctor/check.ts: what every part of `sub-human doctor` shares (lib/cli/doctor.ts): a check,
 * the lazily loaded modules, and small file helpers.
 *
 *   check({id, status, title, detail, fix?}) -> Check
 *   lib(name) -> module            a module under lib/, loaded when a check needs it
 *   cli(args) -> string            a fix only a shell can make: the CLI by its path (lib/text.ts cliLine)
 *   tilde(path) -> string          ~ for paths under $HOME
 *   isExec(path), readText(path), truthy(value)
 *   PLUGIN_ROOT, BIN, DOCTOR_HELLO_MS (8 s: the hello's deadline per link)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAt } from '../../io.ts';
import type { Check, CheckStatus } from '../types.ts';
import type * as TextMod from '../../text.ts';
import type * as HomeMod from '../../home.ts';
import type * as IoMod from '../../io.ts';
import type * as ContractMod from '../../cc/contract.ts';
import type * as EnvMod from '../../cc/env.ts';
import type * as BgMod from '../../cc/bg.ts';
import type * as ConfigMod from '../../config.ts';
import type * as LibEnvMod from '../../env.ts';
import type * as IdentityMod from '../../identity.ts';
import type * as LinksMod from '../../room/links.ts';
import type * as LinkStateMod from '../../room/link-state.ts';
import type * as EnvelopeMod from '../../room/envelope.ts';
import type * as ShimMod from '../../remote/shim.ts';
import type * as SshkeysMod from '../../remote/sshkeys.ts';
import type * as ProtocolMod from '../../remote/protocol.ts';
import type * as LinkSocketMod from '../../remote/link-socket.ts';
import type * as LinkConnectMod from '../../remote/link-connect.ts';
import type * as ListenerMod from '../../remote/listener.ts';
import type * as TailscaleMod from '../../remote/tailscale.ts';
import type * as TransportsMod from '../../remote/transports/index.ts';
import type * as SshMod from '../../remote/transports/ssh.ts';

const LIB = path.join(import.meta.dirname, '..', '..');
const PLUGIN_ROOT: string = path.join(LIB, '..');
const BIN: string = path.join(PLUGIN_ROOT, 'scripts', 'sub-human');
const DOCTOR_HELLO_MS = 8000;
/** The modules doctor loads lazily (each check loads only what it reads), by their path under lib/: each one's type is
 * the namespace imported from that path (scripts/test/lazy.test.ts checks the pairs). */
interface Libs {
  'text.ts': typeof TextMod;
  'home.ts': typeof HomeMod;
  'io.ts': typeof IoMod;
  'cc/contract.ts': typeof ContractMod;
  'cc/env.ts': typeof EnvMod;
  'cc/bg.ts': typeof BgMod;
  'config.ts': typeof ConfigMod;
  'env.ts': typeof LibEnvMod;
  'identity.ts': typeof IdentityMod;
  'room/links.ts': typeof LinksMod;
  'room/link-state.ts': typeof LinkStateMod;
  'room/envelope.ts': typeof EnvelopeMod;
  'remote/shim.ts': typeof ShimMod;
  'remote/sshkeys.ts': typeof SshkeysMod;
  'remote/protocol.ts': typeof ProtocolMod;
  'remote/link-socket.ts': typeof LinkSocketMod;
  'remote/link-connect.ts': typeof LinkConnectMod;
  'remote/listener.ts': typeof ListenerMod;
  'remote/tailscale.ts': typeof TailscaleMod;
  'remote/transports/index.ts': typeof TransportsMod;
  'remote/transports/ssh.ts': typeof SshMod;
}
const lib = <K extends keyof Libs>(name: K): Libs[K] => loadAt<Libs[K]>(import.meta.url, path.join(LIB, name));
/** A fix only a shell can make: the CLI by its path (no `sub-human` is on PATH; lib/text.ts cliLine). */
const cli = (args: string): string => lib('text.ts').cliLine(args);

/** A check's verdict: id (stable, for the bundle), status, title (what was checked), detail (what was found) and fix. */
const check = ({ id, status, title, detail, fix }: { id: string; status: CheckStatus; title: string; detail: string; fix?: string | undefined }): Check => ({ id, status, title, detail, ...(fix ? { fix } : {}) });
const tilde = <P extends string | null | undefined>(p: P, h: string = os.homedir()): P | string => (p && h && (p === h || p.startsWith(h + path.sep)) ? '~' + p.slice(h.length) : p);
const isExec = (p: string): boolean => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
const readText = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const truthy = (v: unknown): boolean => v !== undefined && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';

export { lib, cli, check, tilde, isExec, readText, truthy, PLUGIN_ROOT, BIN, DOCTOR_HELLO_MS };
