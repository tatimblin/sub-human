/**
 * plugin/sub-human/lib/env.ts: every SUB_HUMAN_* environment knob the runtime reads, in one typed table, and the readers.
 * Nothing else reads process.env.SUB_HUMAN_* (test/env.node-test.ts checks; the preload lib/cache-dir.js and the
 * hooks.json shell lines read SUB_HUMAN_HOME themselves). A reader reads the variable at the moment it is called (tests
 * set the env per child process, some per call). Zero dependencies but lib/config.ts (the defaults).
 *
 *   ENV                                      name -> {kind, default?, allowZero?, test?, does}
 *     kind ms     a timing override: envMs (testMs when test: honoured only under the test preload)
 *     kind num    a number read as Number(value) (NaN when unset): envNum; the caller keeps its own fallback
 *     kind flag   "1" turns it on: envFlag
 *     kind str    the value as set: envStr (undefined when unset; "" when set empty; any knob reads raw so). path: a
 *                 file or folder
 *   envMs(name, fallback = its default) -> number   a number of milliseconds, else fallback. Unset, empty,
 *       non-numeric, negative or infinite values give the fallback. 0 also gives the fallback, unless the knob is
 *       allowZero: only the waits where 0 means "do not wait" take it (the reaper and the rewake hook, which the tests
 *       run with no wait). Everywhere else 0 would mean a busy loop or an instant flush, so it is ignored.
 *   testMs(name, fallback?) -> number        envMs, honoured only under the test preload (SUB_HUMAN_TEST=1, test/helpers.ts):
 *       a timing the tests shorten that would weaken a guard if a person (or a steered model) set it
 *   parseMs(raw, fallback, {allowZero}?) -> number   envMs on a value
 *   envNum(name, env?) / envFlag(name, env?) / envStr(name, env?)
 *   segmentMaxBytes() -> number              config.SEGMENT_MAX_BYTES, or SUB_HUMAN_SEGMENT_BYTES (at least 256; tests
 *                                            rotate after a few lines), read at each append
 *   TIMING_ENV_RE                            the ms knobs' names (derived from ENV)
 *   timingEnv(src) -> {name: value}          the ms knobs set in src with a numeric value (lib/room-claude.ts passes
 *                                            them to the room's Claude, whose env the bg daemon would otherwise filter out)
 */

import * as config from './config.ts';

type Env = Record<string, string | undefined>;

interface MsKnob { kind: 'ms'; default: number; allowZero?: boolean; test?: boolean; does: string }
interface OtherKnob { kind: 'num' | 'flag' | 'str' | 'path'; does: string }
type Knob = MsKnob | OtherKnob;

export const ENV = {
  // ----- timings (envMs) -----
  SUB_HUMAN_SETTLE_MS: { kind: 'ms', default: config.SETTLE_MS, does: 'the tail: quiet before a batch of events goes out' },
  SUB_HUMAN_SETTLE_MAX_MS: { kind: 'ms', default: config.SETTLE_MAX_MS, does: 'the tail: the longest a batch waits' },
  SUB_HUMAN_LEAVE_MS: { kind: 'ms', default: config.LEAVE_SETTLE_MS, does: 'a leave settles (tail, notices, rows, hold)' },
  SUB_HUMAN_UNSEATED_MS: { kind: 'ms', default: config.UNSEATED_MS, does: 'the tail: no seat yet, look it up this rarely' },
  SUB_HUMAN_RESOLVE_MS: { kind: 'ms', default: config.RESOLVE_MS, does: 'the tail: seated, re-resolve the seat this often' },
  SUB_HUMAN_POLL_MS: { kind: 'ms', default: config.TAIL_POLL_MS, does: 'the tail\'s log poll' },
  SUB_HUMAN_TAIL_HEALTH_MS: { kind: 'ms', default: config.TAIL_HEALTH_MS, does: 'the tail\'s health check' },
  SUB_HUMAN_ROOM_CLAUDE_ORPHAN_MS: { kind: 'ms', default: config.ROOM_CLAUDE_ORPHAN_MS, does: 'the room\'s Claude with no human' },
  SUB_HUMAN_REAP_STOP_MS: { kind: 'ms', default: config.REAP_STOP_MS, allowZero: true, does: 'after `claude stop`, the wait for the process' },
  SUB_HUMAN_REAP_GRACE_MS: { kind: 'ms', default: config.REAP_GRACE_MS, allowZero: true, does: 'a quick rejoin cancels the reap' },
  SUB_HUMAN_REAP_WAIT_MS: { kind: 'ms', default: config.REAP_WAIT_MS, allowZero: true, does: 'wait for task 1 before `claude stop`' },
  SUB_HUMAN_REWAKE_WAIT_MS: { kind: 'ms', default: config.REWAKE_WAIT_MS, allowZero: true, does: 'row-rewake waits for the seat' },
  SUB_HUMAN_ROOM_GC_MS: { kind: 'ms', default: config.ROOM_GC_MS, does: 'an idle room is set aside after this' },
  SUB_HUMAN_EXIT_INPUT_WAIT_MS: { kind: 'ms', default: config.EXIT_INPUT_WAIT_MS, does: 'consent: the wait for ExitPlanMode\'s input' },
  SUB_HUMAN_FORK_WAIT_MS: { kind: 'ms', default: config.FORK_RECORD_WAIT_MS, does: 'session-restore: the fork\'s continued-in record' },
  SUB_HUMAN_HOLD_BEAT_MS: { kind: 'ms', default: config.HOLD_BEAT_MS, does: 'the hold: progress re-sent' },
  SUB_HUMAN_HOLD_POLL_MS: { kind: 'ms', default: config.HOLD_POLL_MS, does: 'the hold\'s poll' },
  SUB_HUMAN_HOLD_GRACE_MS: { kind: 'ms', default: config.HOLD_GRACE_MS, does: 'the hold: a name is announced only after this' },
  SUB_HUMAN_HOLD_RESPAWN_MS: { kind: 'ms', default: config.HOLD_RESPAWN_MS, does: 'the hold\'s respawn' },
  SUB_HUMAN_HOLD_WHO_MS: { kind: 'ms', default: config.HOLD_WHO_MS, does: 'the hold: `me` re-resolved' },
  SUB_HUMAN_HOLD_ROOM_GAP_MS: { kind: 'ms', default: config.HOLD_ROOM_GAP_MS, does: 'the hold: a returned room hold still counts' },
  SUB_HUMAN_LINK_RETRY_MS: { kind: 'ms', default: config.LINK_RETRY_MS, does: 'the link daemon\'s first retry' },
  SUB_HUMAN_LINK_RETRY_MAX_MS: { kind: 'ms', default: config.LINK_RETRY_MAX_MS, does: 'the link daemon\'s longest retry' },
  SUB_HUMAN_LINK_PING_MS: { kind: 'ms', default: config.LINK_PING_MS, does: 'the link\'s ping' },
  SUB_HUMAN_LINK_PONG_MS: { kind: 'ms', default: config.LINK_PONG_MS, does: 'the link: the wait for a pong' },
  SUB_HUMAN_LINK_DEAD_MS: { kind: 'ms', default: config.LINK_DEAD_MS, does: 'the link: silence before it is dead' },
  SUB_HUMAN_LINK_WAKE_TICK_MS: { kind: 'ms', default: config.LINK_WAKE_TICK_MS, does: 'the link\'s sleep detector tick' },
  SUB_HUMAN_LINK_WAKE_GAP_MS: { kind: 'ms', default: config.LINK_WAKE_GAP_MS, does: 'the link: a gap that means the machine slept' },
  SUB_HUMAN_LINK_IDLE_MS: { kind: 'ms', default: config.LINK_IDLE_MS, does: 'the link daemon with no seat stops' },
  SUB_HUMAN_WS_CONNECT_MS: { kind: 'ms', default: config.WS_CONNECT_MS, does: 'a web link\'s connect' },
  SUB_HUMAN_YES_GUARD_MS: { kind: 'ms', default: config.YES_GUARD_MS, test: true, does: 'consent: a plan-view Yes this soon records nothing' },
  SUB_HUMAN_PIN_BACKOFF_MS: { kind: 'ms', default: config.PIN_BACKOFF_MS, test: true, does: 'the wait after a wrong PIN' },
  SUB_HUMAN_ADMIT_TTL_MS: { kind: 'ms', default: config.ADMIT_TTL_MS, test: true, does: 'a held join waits for the host\'s card' },
  // ----- numbers (envNum: Number(value); the caller's fallback) -----
  SUB_HUMAN_LISTEN_CHECK_MS: { kind: 'num', does: 'the listener: how often it checks for closed rooms' },
  SUB_HUMAN_LISTEN_PORT: { kind: 'num', does: 'the web listener\'s port' },
  SUB_HUMAN_SEGMENT_BYTES: { kind: 'num', does: 'the log segment size (tests rotate after a few lines): segmentMaxBytes' },
  // ----- flags (envFlag: "1") -----
  SUB_HUMAN_TEST: { kind: 'flag', does: 'the test preload (test/helpers.ts): testMs knobs are honoured' },
  SUB_HUMAN_ALLOW_TMP_ROOT: { kind: 'flag', does: 'a plugin root under a temp folder is used' },
  SUB_HUMAN_SHIM: { kind: 'flag', does: 'consent runs as the hooks module\'s shim' },
  SUB_HUMAN_DEBUG: { kind: 'flag', does: 'the room MCP server logs' },
  // ----- strings and paths (envStr: the value as set) -----
  SUB_HUMAN_HOME: { kind: 'path', does: 'the store (default ~/.sub-human)' },
  SUB_HUMAN_ROOM: { kind: 'str', does: 'the room a room\'s Claude was started for' },
  SUB_HUMAN_VIA: { kind: 'str', does: '"module": a hook run by the hooks module (mod/core/shim.ts)' },
  SUB_HUMAN_CLAUDE: { kind: 'path', does: 'the claude binary (default claude)' },
  SUB_HUMAN_PLUGIN_DIR: { kind: 'path', does: 'the room\'s Claude\'s --plugin-dir ("" for none)' },
  SUB_HUMAN_SSH_ADDR: { kind: 'str', does: 'the address an invite names (default you@this-host)' },
  SUB_HUMAN_SSH_OPTS: { kind: 'str', does: 'extra ssh options, space separated' },
  SUB_HUMAN_REMOTE_LOGIN: { kind: 'str', does: 'force (1) or forbid (0) the login join' },
  SUB_HUMAN_AUTHORIZED_KEYS: { kind: 'path', does: 'the authorized_keys file (default ~/.ssh/authorized_keys)' },
  SUB_HUMAN_TAILSCALE: { kind: 'path', does: 'the tailscale binary' },
  SUB_HUMAN_TAILSCALE_WARM: { kind: 'str', does: '"0": no warm-up request to a Tailscale URL' },
  SUB_HUMAN_MACHINE_LABEL: { kind: 'str', does: 'this machine\'s short name (default the host name)' },
} as const satisfies Record<`SUB_HUMAN_${string}`, Knob>;

type Table = typeof ENV;
export type EnvName = keyof Table;
type Of<K extends Knob['kind']> = { [N in EnvName]: Table[N]['kind'] extends K ? N : never }[EnvName];
/** The ms knobs a person may set (envMs) and those honoured only under the tests (testMs). */
export type MsName = { [N in Of<'ms'>]: Table[N] extends { test: true } ? never : N }[Of<'ms'>];
export type TestMsName = Exclude<Of<'ms'>, MsName>;

function parseMs(raw: string | undefined, fallback: number, { allowZero = false }: { allowZero?: boolean } = {}): number {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n === 0 && !allowZero) return fallback;
  return n;
}

const knob = (name: Of<'ms'>): MsKnob => ENV[name];

function envMs(name: MsName, fallback: number = knob(name).default): number {
  return parseMs(process.env[name], fallback, { allowZero: knob(name).allowZero === true });
}

function testMs(name: TestMsName, fallback: number = knob(name).default): number {
  return envFlag('SUB_HUMAN_TEST') ? parseMs(process.env[name], fallback) : fallback;
}

const envNum = (name: Of<'num'>, env: Env = process.env): number => Number(env[name]);
const envFlag = (name: Of<'flag'>, env: Env = process.env): boolean => env[name] === '1';
const envStr = (name: EnvName, env: Env = process.env): string | undefined => env[name];

function segmentMaxBytes(): number {
  const n = envNum('SUB_HUMAN_SEGMENT_BYTES');
  return Number.isInteger(n) && n >= 256 ? n : config.SEGMENT_MAX_BYTES;
}

const MS_NAMES: readonly string[] = Object.keys(ENV).filter(n => /_MS$/.test(n));
/** The timing knobs' names: SUB_HUMAN_<WHAT>_MS, each one in ENV. */
const TIMING_ENV_RE = new RegExp(`^(?:${MS_NAMES.join('|')})$`);

function timingEnv(src: Env | null = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src || {})) {
    if (!TIMING_ENV_RE.test(k) || v == null || String(v).trim() === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[k] = String(v);
  }
  return out;
}

export { parseMs, envMs, testMs, envNum, envFlag, envStr, segmentMaxBytes, TIMING_ENV_RE, timingEnv };
