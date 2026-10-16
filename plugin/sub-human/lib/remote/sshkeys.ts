/**
 * plugin/sub-human/lib/remote/sshkeys.ts: the lines an older sub-human wrote to authorized_keys, found and removed;
 * nothing here writes one. Before protocol 3 a host's admit let a joiner's own ssh key in with a forced-command line
 * (`command="SUB_HUMAN_HOME=… …/bin/serve --stdio CODE --link ID",restrict KEY sub-human:CODE:ID`), and an open ssh invite
 * kept an enrollment door (`… --enroll CODE --kind ssh",restrict KEY sub-human-enroll:CODE`). Since protocol 3 an ssh
 * joiner reaches the host through their own ssh login (lib/remote/transports/ssh.ts loginSpec), so the plugin adds no
 * line; a link made through such a line keeps working until it is kicked, which takes its line out, and doctor names
 * the doors left over (lib/cli/doctor/ssh.ts; --fix removes them). Zero dependencies beyond node:fs and lib/io.ts.
 *
 *   authorizedKeysFile() -> string            SUB_HUMAN_AUTHORIZED_KEYS, else ~/.ssh/authorized_keys
 *   removeAuthorized(file, code, id) -> n     drop every line that ends "sub-human:CODE:ID" (a kicked link's); the count
 *   removeTagged(file, tag) -> n              drop every line that ends " TAG" (a leftover door: sub-human-enroll:CODE)
 *   ENROLL_TAG(code) -> 'sub-human-enroll:CODE'
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as io from '../io.ts';
import { envStr } from '../env.ts';

const authorizedKeysFile = (): string => envStr('SUB_HUMAN_AUTHORIZED_KEYS') || path.join(os.homedir(), '.ssh', 'authorized_keys');
const ENROLL_TAG = (code: string): string => `sub-human-enroll:${code}`;

function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
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

const removeAuthorized = (file: string, code: string, id: string): number => removeTagged(file, `sub-human:${code}:${id}`);

export { authorizedKeysFile, removeAuthorized, removeTagged, ENROLL_TAG };
