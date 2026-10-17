/**
 * plugin/sub-human/test/support/plan.ts: a sign-off request on a room plan version in one call, for the consent tests
 * (what the propose tool did before plans).
 *
 *   propose(me, {text, approvers?, plan?}) -> {hash, approvers, plan, version, entry, again, path (the blob's file)}
 *     text stored as the next version of plan (default: a fresh name p1, p2, ... per call, so each call is its own
 *     plan, as each proposal was its own), written as the host's plan.put writes it but without its open-plan cap,
 *     then asked for sign-off (lib/proposal.ts ask). Same plan, new text: a new version, which retires the request
 *     on the older one.
 *   version(me, plan, text) -> PlanVersion   only the version, no request
 */
import * as room from '../../lib/room.ts';
import * as proposal from '../../lib/proposal.ts';
import * as plans from '../../lib/plans.ts';
import { planHash } from '../../lib/text.ts';
import type { PlanVersion } from '../../lib/room/types.ts';
import type { Identity } from '../../lib/identity.ts';

type Me = Pick<Identity, 'code' | 'name'>;
let n = 0;

/** text as the next version of plan (via agent from me, system: as lib/plans.ts put appends it). */
export function version(me: Me, plan: string, text: string, summary = ''): PlanVersion {
  const r = room.open(me.code);
  const buf = Buffer.from(text, 'utf8');
  const hash = planHash(buf);
  const ref = plans.refOf(hash);
  if (!r.store.blobs.has(ref)) r.store.blobs.put(ref, buf);
  const cur = r.fold().plans.get(plan)?.current;
  const v = (cur ? cur.version : 0) + 1;
  r.append({ kind: 'plan', text: `plan ${plan} v${v}${summary ? `: ${summary}` : ''}`, hash, path: ref, plan, version: v, base: v - 1, for: me.name,
    ...(summary ? { summary } : {}) }, { via: 'agent', from: me.name, system: true });
  const got = r.fold().plans.get(plan)?.current;
  if (!got || got.version !== v) throw new Error(`plan ${plan} v${v} not folded`);
  return got;
}

/** A new version of plan (default a fresh name) with text, and a sign-off request on it. */
export function propose(me: Me, { text, approvers, plan }: { text: string; approvers?: string[]; plan?: string }): ReturnType<typeof proposal.ask> & { path: string } {
  const name = plan ?? `p${++n}`;
  const cur = room.open(me.code).fold().plans.get(name)?.current;
  if (!cur || cur.hash !== planHash(Buffer.from(text, 'utf8'))) version(me, name, text);
  const r = proposal.ask(me, { plan: name, ...(approvers ? { approvers } : {}) });
  const ref = plans.refOf(r.hash);
  return { ...r, path: room.open(me.code).store.blobs.localPath(ref) || ref };
}
