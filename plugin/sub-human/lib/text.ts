/**
 * plugin/sub-human/lib/text.ts: the string helpers and name patterns every module shares. Zero dependencies beyond
 * mod/core/seat.ts, which owns the patterns.
 *
 *   clip(s, n) -> string     at most n code points; a longer string keeps n - 1 and ends in "…". Counting code
 *                            points (not UTF-16 units) never splits a surrogate pair, so an emoji is never halved.
 *   oneLine(s) -> string     whitespace runs collapsed to one space, trimmed; null / undefined -> ''
 *   NAME_RE                  a seat name: letters, digits, . _ -, 1-32
 *   CODE_RE                  a room code: "otter-4821"
 *   SID_SAFE                 a session id safe to use in a file name
 *   HASH_RE                  a proposal's hash: 12 lowercase hex (sha256/12 of the plan bytes, lib/proposal.ts)
 *   MACHINE_RE, isMachineId(v)   a machine id: this home's 16 hex (lib/home.ts), a machine key's k + 15 hex
 *                            (lib/remote/machine-key.ts), a peer's word; the guard makes the MachineId brand
 *   hash12(data) -> string   the first 12 hex of sha256(data): a proposal's hash, and the log's prev chain
 *   isProposalHash(v), planHash(data) -> ProposalHash   the brand's guard (HASH_RE) and hash12 as one (lib/brand.ts);
 *                            isSeatName, isRoomCode, isSessionId, seatName, roomCode, sessionId: mod/core/seat.ts's
 *   cliLine(args) -> string  the shell line that runs this plugin's CLI, `node <plugin root>/scripts/sub-human ARGS`
 *                            (~ for the home folder): what a message prints when only a shell can do it, since no
 *                            `sub-human` is on PATH. With a sub-human folder other than ~/.sub-human (SUB_HUMAN_HOME)
 *                            the line starts `SUB_HUMAN_HOME=<folder> `, so a terminal acts on this folder, not the
 *                            default one (verify12 remote/05a); {elsewhere: true} for a line another machine runs
 *                            (a handoff's demote line), whose folder this one does not know
 *   homePrefix(home, userHome) -> string   that prefix ('' for the default folder or none known); mod/core/guard.ts
 *                            homeEnv is the same rule for its doctor line (the module loads no node: modules)
 *   cliCmd(args) -> string   the same CLI as a Bash tool command, `<plugin root>/scripts/sub-human ARGS` (absolute, the
 *                            shim runs itself): what a session's Claude is told to run; the store guard's read-only
 *                            CLI rule (mod/core/guard.ts READ_CLI) allows that spelling
 *   localHm(iso) -> "21:40"  an ISO time as this machine's local hours and minutes ('' when it is no time): every
 *                            "until" a person reads (an invite, a handoff's card, a join request) is local
 */
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';

// owned by mod/core/seat.ts (the hooks module parses names and codes too)
import { NAME_RE, CODE_RE, SID_SAFE, homeOf, isSeatName, isRoomCode, isSessionId, seatName, roomCode, sessionId } from '../mod/core/seat.ts';
import { envStr } from './env.ts';
import type { MachineId, ProposalHash } from './brand.ts';

const HASH_RE = /^[0-9a-f]{12}$/;
const MACHINE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isMachineId = (v: unknown): v is MachineId => typeof v === 'string' && MACHINE_RE.test(v);
const hash12 = (data: crypto.BinaryLike): string => crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);
const isProposalHash = (v: unknown): v is ProposalHash => typeof v === 'string' && HASH_RE.test(v);
/** hash12(data) as a proposal's hash. */
function planHash(data: crypto.BinaryLike): ProposalHash {
  const h = hash12(data);
  if (!isProposalHash(h)) throw new Error('hash12 is 12 hex');
  return h;
}

function clip(s: unknown, n: number): string {
  const str = String(s);
  // Fast path: a string no longer than n UTF-16 units has at most n code points.
  if (str.length <= n) return str;
  const cps = Array.from(str);
  return cps.length > n ? cps.slice(0, Math.max(0, n - 1)).join('') + '…' : str;
}

const oneLine = (s: unknown): string => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();

/** A word as the shell reads it: as is when it needs no quoting, else in single quotes. */
const shellWord = (w: string): string => (/[^\w@%+=:,./~-]/.test(w) ? `'${w.replace(/'/g, "'\\''")}'` : w);

function homePrefix(home: unknown, userHome: unknown): string {
  if (typeof home !== 'string' || !home) return '';
  const dflt = homeOf(undefined, userHome);
  const abs = path.resolve(home);
  return dflt && abs === path.resolve(dflt) ? '' : `SUB_HUMAN_HOME=${shellWord(abs)} `;
}

function cliLine(args = '', { elsewhere = false }: { elsewhere?: boolean } = {}): string {
  const root = process.env.CLAUDE_PLUGIN_ROOT || path.join(import.meta.dirname, '..');
  const home = os.homedir();
  const shown = home && (root === home || root.startsWith(home + path.sep)) ? `~${root.slice(home.length)}` : root;
  const q = /[^\w@%+=:,./~-]/.test(shown) ? shellWord(root) : shown;
  const set = envStr('SUB_HUMAN_HOME');
  const env = set && !elsewhere ? homePrefix(set, home) : '';
  return `${env}node ${q}/scripts/sub-human${args ? ` ${args}` : ''}`;
}

function cliCmd(args = ''): string {
  const shim = path.join(process.env.CLAUDE_PLUGIN_ROOT || path.join(import.meta.dirname, '..'), 'scripts', 'sub-human');
  const q = /[^\w@%+=:,./~-]/.test(shim) ? `'${shim.replace(/'/g, "'\\''")}'` : shim;
  return `${q}${args ? ` ${args}` : ''}`;
}

const localHm = (iso: unknown): string => { const d = new Date(String(iso)); return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5); };

export {
  clip, oneLine, cliLine, cliCmd, homePrefix, localHm, NAME_RE, CODE_RE, SID_SAFE, HASH_RE, MACHINE_RE, hash12, isProposalHash, planHash,
  isMachineId,
  isSeatName, isRoomCode, isSessionId, seatName, roomCode, sessionId,
};
