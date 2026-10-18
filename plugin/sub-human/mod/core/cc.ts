/**
 * plugin/sub-human/mod/core/cc.ts: what a Claude Code version's verdict (lib/cc/verdict.ts) turns off, and the one line
 * that tells the person, as pure values the module and node share (lib/cc/verdict.ts imports them from here).
 *
 *   isCcVersion(v)            a Claude Code version as $.session.version spells it ("2.1.296", "2.1.300-dev"): safe in
 *                             a file name (<home>/cc/<version>.json)
 *   GATED                     the features a verdict can turn to their fallback (a failed entry of any other feature
 *                             only makes the version unverified)
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

export const GATED = ['room-session', 'tasks', 'plan-edit', 'sign-off'] as const;
export type Gated = typeof GATED[number];
export type Cc = NonNullable<Hello['cc']>;

export const isGated = (v: unknown): v is Gated => GATED.some(g => g === v);

export function closeOff(features: readonly unknown[]): Gated[] {
  const on = new Set(features.filter(isGated));
  if (on.has('sign-off')) on.add('plan-edit');
  return GATED.filter(f => on.has(f));
}

export const FALLBACK: Readonly<Record<Gated, string>> = Object.freeze({
  'room-session': 'the room session may not start (the room keeps its tasks)',
  tasks: 'the room task list is off (tasks are kept in the room)',
  'plan-edit': 'plan edits use the plan tool',
  'sign-off': 'sign-off is a question Claude Code asks you, not the plan view',
});

export function parseCc(v: unknown): Cc | null {
  const o: { version?: unknown; verified?: unknown; off?: unknown } | null = v && typeof v === 'object' ? v : null;
  if (!o || !isCcVersion(o.version)) return null;
  return {
    version: o.version,
    verified: typeof o.verified === 'boolean' ? o.verified : null,
    off: closeOff(Array.isArray(o.off) ? o.off : []),
  };
}

export function ccNotice(cc: Cc | null | undefined): string | null {
  if (!cc || !cc.off.length) return null;
  const what = cc.off.map(f => FALLBACK[f]).join(', ');
  if (cc.verified === true) return `SUB_HUMAN_CC_OFF: ${what}.`;
  return `Claude Code ${cc.version} isn't verified with sub-human yet: ${what}. sub-human doctor has details.`;
}
