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
import { createRequire } from 'node:module';
import type { Check, CheckStatus } from '../types.ts';

const require = createRequire(import.meta.url);

const LIB = path.join(import.meta.dirname, '..', '..');
const PLUGIN_ROOT = path.join(LIB, '..');
const BIN = path.join(PLUGIN_ROOT, 'scripts', 'sub-human');
const DOCTOR_HELLO_MS = 8000;
/** The modules doctor loads lazily, by their path under lib/. */
interface Libs {
  'text.ts': typeof import('../../text.ts');
  'home.ts': typeof import('../../home.ts');
  'io.ts': typeof import('../../io.ts');
  'cc/contract.ts': typeof import('../../cc/contract.ts');
  'cc/env.ts': typeof import('../../cc/env.ts');
  'cc/bg.ts': typeof import('../../cc/bg.ts');
  'config.ts': typeof import('../../config.ts');
  'env.ts': typeof import('../../env.ts');
  'identity.ts': typeof import('../../identity.ts');
  'room/links.ts': typeof import('../../room/links.ts');
  'room/link-state.ts': typeof import('../../room/link-state.ts');
  'room/envelope.ts': typeof import('../../room/envelope.ts');
  'remote/shim.ts': typeof import('../../remote/shim.ts');
  'remote/sshkeys.ts': typeof import('../../remote/sshkeys.ts');
  'remote/protocol.ts': typeof import('../../remote/protocol.ts');
  'remote/link-socket.ts': typeof import('../../remote/link-socket.ts');
  'remote/link-connect.ts': typeof import('../../remote/link-connect.ts');
  'remote/listener.ts': typeof import('../../remote/listener.ts');
  'remote/tailscale.ts': typeof import('../../remote/tailscale.ts');
  'remote/transports/index.ts': typeof import('../../remote/transports/index.ts');
  'remote/transports/ssh.ts': typeof import('../../remote/transports/ssh.ts');
}
const lib = <K extends keyof Libs>(name: K): Libs[K] => require(path.join(LIB, name));
/** A fix only a shell can make: the CLI by its path (no `sub-human` is on PATH; lib/text.ts cliLine). */
const cli = (args: string): string => lib('text.ts').cliLine(args);

/** A check's verdict: id (stable, for the bundle), status, title (what was checked), detail (what was found) and fix. */
const check = ({ id, status, title, detail, fix }: { id: string; status: CheckStatus; title: string; detail: string; fix?: string | undefined }): Check => ({ id, status, title, detail, ...(fix ? { fix } : {}) });
const tilde = <P extends string | null | undefined>(p: P, h = os.homedir()): P | string => (p && h && (p === h || p.startsWith(h + path.sep)) ? '~' + p.slice(h.length) : p);
const isExec = (p: string) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
const readText = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const truthy = (v: unknown) => v !== undefined && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';

export { lib, cli, check, tilde, isExec, readText, truthy, PLUGIN_ROOT, BIN, DOCTOR_HELLO_MS };
