/**
 * plugin/sub-human/mod/core/cc.ts: what a Claude Code version's verdict (lib/cc/verdict.ts) turns off, and the one line
 * that tells the person, as pure values the module and node share (lib/cc/verdict.ts imports them from here).
 *
 *   isCcVersion(v)            a Claude Code version as $.session.version spells it ("2.1.296", "2.1.300-dev"): safe in
 *                             a file name (<home>/cc/<version>.json)
 *   GATED                     the features a verdict can turn to their fallback (types/index.d.ts SubHumanGated; a
 *                             failed entry of any other feature only makes the version unverified):
 *                               tasks       the room session's native task list
 *                               plan-edit   a room plan edit in plan mode
 *                               sign-off    a sign-off in the plan view
 *                               reap-rm     a closed room's session deleted with `claude rm`, not only stopped
 *                               quiet-plan  sub-human's own plan-mode rows drawn as nothing (mod/core/quiet.ts)
 *                               keep-mode   a review's closing call keeps the person's mode
 *                               room-row    the one room row, spawned by the module (mod/deliver.ts roomRow)
 *   isGated(v)                v is one of them
 *   closeOff(features) -> Gated[]   features, deduplicated in GATED order, with what each implies: sign-off implies
 *                             plan-edit (a room plan edit goes through plan mode too)
 *   FALLBACK                  gated feature -> what runs instead, in the person's words
 *   parseCc(v) -> cc | null   a hello's `cc` (types/index.d.ts SubHumanCc), each field checked
 *   ccNotice(cc) -> string | null   the one $.ui.log line for a version with features off (mod/deliver.ts says it once
 *                             per version and module process, once the session holds a seat); null when none is off
 */
import type { Hello } from './types.ts';

export const isCcVersion = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,40}$/.test(v) && !v.includes('..');

/** types/index.d.ts SubHumanGated, the one list's type (a hello's cc.off). */
export type Gated = NonNullable<Hello['cc']>['off'][number];
/** Every Gated, in the order closeOff keeps (FALLBACK, a Record over Gated, holds each one too). */
export const GATED: readonly Gated[] = ['tasks', 'plan-edit', 'sign-off', 'reap-rm', 'quiet-plan', 'keep-mode', 'room-row'];
export type Cc = NonNullable<Hello['cc']>;

export const isGated = (v: unknown): v is Gated => GATED.some(g => g === v);

export function closeOff(features: readonly unknown[]): Gated[] {
  const on = new Set(features.filter(isGated));
  if (on.has('sign-off')) on.add('plan-edit');
  return GATED.filter(f => on.has(f));
}

export const FALLBACK: Readonly<Record<Gated, string>> = Object.freeze({
  tasks: 'the room task list is off (tasks are kept in the room)',
  'plan-edit': 'plan edits use the plan tool',
  'sign-off': 'sign-off is a question Claude Code asks you, not the plan view',
  'reap-rm': 'a closed room\'s session is stopped, not deleted',
  'quiet-plan': 'plan mode draws its own rows for a room review and a plan save',
  'keep-mode': 'asking for changes on a room plan returns you to manual mode',
  'room-row': 'the agent panel shows no room row (@room and messages to other Claudes still work)',
});

export function parseCc(v: unknown): Cc | null {
  const o: { version?: unknown; verified?: unknown; off?: unknown; forced?: unknown } | null = v && typeof v === 'object' ? v : null;
  if (!o || !isCcVersion(o.version)) return null;
  const forced = closeOff(Array.isArray(o.forced) ? o.forced : []);
  return {
    version: o.version,
    verified: typeof o.verified === 'boolean' ? o.verified : null,
    off: closeOff(Array.isArray(o.off) ? o.off : []),
    ...(forced.length ? { forced } : {}),
  };
}

export function ccNotice(cc: Cc | null | undefined): string | null {
  if (!cc || !cc.off.length) return null;
  const what = cc.off.map(f => FALLBACK[f]).join(', ');
  // only what SUB_HUMAN_CC_OFF forced: the version is not to blame
  if (cc.verified === true || cc.off.every(f => cc.forced?.includes(f))) return `SUB_HUMAN_CC_OFF: ${what}.`;
  return `Claude Code ${cc.version} isn't verified with sub-human yet: ${what}. sub-human doctor has details.`;
}
