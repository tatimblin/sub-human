/**
 * plugin/sub-human/mod/core/walk.ts: the question after a bare `/sub-human` opened a room (PLAN-SMOOTH 0.6.1 item 1),
 * as pure functions; mod/deliver.ts makes the $ calls.
 *
 *   1. /sub-human answered with a seat in a room it just opened (hooks/handlers/join.ts: the reply's `opened`), typed by
 *      a person (session.start isInteractive; never in a `-p` run), unless SUB_HUMAN_WALK=0: the module runs node
 *      hooks/run.ts walk at once, in the background (what this machine can offer: walkFacts), waits for the join's own
 *      turn and any seat-taking to end, then opens Claude Code's own dialog itself ($.ui.ask, no model turn):
 *      "Bring someone into CODE?", This machine · SSH · Tailscale (walkOptions: the likely one marked " (detected)",
 *      one that cannot work dropped), labels alone; the dialog's own free-text row takes an ssh address.
 *   2. walkAction reads the answer. Dismissed (Esc): nothing, no line. This machine: one line (HERE_LINE). SSH or
 *      Tailscale: the typed command's own invite (`invite --ssh [ADDR]` or `invite --web`) through the join shim, and its
 *      reply goes out as a typed invite's does (mod/deliver.ts showReply: the line and PIN pinned on the status line and
 *      held in module memory for the copy question, never a transcript row or anything the model reads).
 *
 *   WALK_HEADER, THIS_MACHINE, SSH, TAILSCALE, DETECTED, walkQuestion(code)   the dialog
 *   WalkFacts, walkFacts(v), NO_FACTS                                     what node walk found (unknown: null)
 *   walkOptions(facts) -> string[]                                        the labels, 2-3, in order
 *   walkAction(answer) -> WalkAction                                      what the answer does
 *   HERE_LINE                                                             This machine's one line
 */

/** The dialog's header chip (12 characters at most): the dialog has no plugin prefix, so it names the speaker. */
export const WALK_HEADER = 'sub-human';
export const THIS_MACHINE = 'This machine';
export const SSH = 'SSH';
export const TAILSCALE = 'Tailscale';
/** After the label of the way this machine looks set up for. */
export const DETECTED = ' (detected)';
export const walkQuestion = (code: string): string => `Bring someone into ${code}?`;
/** This machine's answer: the one line. */
export const HERE_LINE = 'In another session here, type /sub-human';

/**
 * What node walk (hooks/handlers/walk.ts) found here: tailnet `up` (Tailscale's CLI, and `tailscale status` naming this
 * machine online, as a bare invite checks it), `down` (the CLI, not online), `none` (no CLI: Tailscale cannot work);
 * ssh: Remote Login / an sshd, `on` or `off`; sshAddr: SUB_HUMAN_SSH_ADDR is set (a bare invite then stays on ssh).
 * null: not known (the run failed or took too long).
 */
export interface WalkFacts { tailnet: 'up' | 'down' | 'none' | null; ssh: 'on' | 'off' | null; sshAddr: boolean }
export const NO_FACTS: WalkFacts = Object.freeze({ tailnet: null, ssh: null, sshAddr: false });

/** node walk's report ({subHuman: {walk}}'s walk), read as it may be: anything else is not known. */
export function walkFacts(v: unknown): WalkFacts {
  if (!v || typeof v !== 'object') return NO_FACTS;
  const o: { tailnet?: unknown; ssh?: unknown; sshAddr?: unknown } = v;
  const tailnet = o.tailnet === 'up' || o.tailnet === 'down' || o.tailnet === 'none' ? o.tailnet : null;
  const ssh = o.ssh === 'on' || o.ssh === 'off' ? o.ssh : null;
  return { tailnet, ssh, sshAddr: o.sshAddr === true };
}

/**
 * The dialog's labels, in order This machine · SSH · Tailscale. Tailscale is dropped with no CLI here; SSH is dropped
 * when Remote Login is off (and no ssh address is set up) while Tailscale can still be offered, so at least two stay.
 * The likely one is marked: Tailscale when the tailnet is up (unless an ssh address is set up: a bare invite stays on
 * ssh then), else SSH when Remote Login is on or an address is set up; nothing when neither is known.
 */
export function walkOptions(f: WalkFacts): string[] {
  const tailscale = f.tailnet !== 'none';
  const ssh = !(f.ssh === 'off' && !f.sshAddr && tailscale);
  const likely = f.tailnet === 'up' && !f.sshAddr ? TAILSCALE : (f.ssh === 'on' || f.sshAddr) && ssh ? SSH : null;
  const mark = (l: string) => (l === likely ? `${l}${DETECTED}` : l);
  return [THIS_MACHINE, ...(ssh ? [mark(SSH)] : []), ...(tailscale ? [mark(TAILSCALE)] : [])];
}

/** What the answer does: nothing, the one line, or the invite to run (the typed command's own args). */
export type WalkAction = { kind: 'none' } | { kind: 'here' } | { kind: 'invite'; args: string; via: 'ssh' | 'tailscale' };

/** An ssh address typed under "Other": user@host or a bare host (an alias from their ssh config works too). */
const ADDRESS = /^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/;
/** Typed words that mean "not now", never a host called that. */
const NOT_NOW = new Set(['no', 'nope', 'none', 'nobody', 'skip', 'cancel', 'later', 'not now', 'nothing']);

/**
 * The answer $.ui.ask resolved to (a label, marked or not, or the text typed under Other; null: dismissed). Text shaped
 * like an ssh address (user@host, or a bare host) is SSH to that address; a label's name typed is that label; anything
 * else does nothing.
 */
export function walkAction(answer: string | null | undefined): WalkAction {
  const a = typeof answer === 'string' ? answer.trim() : '';
  if (!a) return { kind: 'none' };
  const label = (a.endsWith(DETECTED) ? a.slice(0, -DETECTED.length) : a).toLowerCase();
  if (label === THIS_MACHINE.toLowerCase()) return { kind: 'here' };
  if (label === SSH.toLowerCase()) return { kind: 'invite', args: 'invite --ssh', via: 'ssh' };
  if (label === TAILSCALE.toLowerCase()) return { kind: 'invite', args: 'invite --web', via: 'tailscale' };
  if (NOT_NOW.has(label) || !ADDRESS.test(a) || /^[0-9]+$/.test(a)) return { kind: 'none' };
  return { kind: 'invite', args: `invite --ssh ${a}`, via: 'ssh' };
}

/** How long node walk may take before the dialog opens without what it found. */
export const WALK_FACTS_MS = 4000;
/** How long the module waits for the join's own turn to start before it asks anyway (a join with no turn). */
export const WALK_TURN_WAIT_MS = 5000;
