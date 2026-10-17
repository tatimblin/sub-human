// S4: B's own Claude drafts the room plan: an edit in plan mode the hooks store as v1 (the receipt, no approval
// dialog); then B asks both to sign off, and each reads v1 in the plan view
import fs from 'node:fs';
import path from 'node:path';
import { readText, esc } from '../lib/io.ts';
import { toolResults } from './transcripts.ts';
import type { Ctx, Det } from './context.ts';
import type { Step } from './captures.ts';

export const scene = 'S4';

export function run(x: Ctx, { det }: { det: Det }): void {
  const { log, roomDir, props, A, B } = x;
  const v1 = log.find(e => e.kind === 'plan' && e.plan === 'room' && e.version === 1);
  det(`${B}'s Claude stores room plan v1: a plan entry from ${B} for ${B}, base 0, its text stored by hash`,
    v1 && v1.from === B && v1.via === 'agent' && v1.for === B && v1.base === 0 && fs.existsSync(path.join(roomDir, 'plans', `${v1.hash}.md`)),
    v1 ? `${x.fmt(v1)}; plans/${v1.hash}.md ${fs.existsSync(path.join(roomDir, 'plans', `${v1.hash}.md`)) ? 'present' : 'missing'}` : 'no plan entry');
  // the edit's ExitPlanMode came back with the store's receipt (a deny: no approval dialog), and nothing was answered
  const s4 = x.span('S4');
  const es = x.inSpan(x.entries(B), s4);
  const receipt = toolResults(es).find(t => /stored as room plan room v1\. Not agreed/.test(t));
  det(`${B}'s Claude was told the receipt ("stored as room plan room v1. Not agreed …"), no approval dialog`, !!receipt, receipt ? receipt.slice(0, 120) : 'no receipt in its transcript');
  const answered = log.filter(e => (e.kind === 'signoff' || e.kind === 'objection') && v1 && e.proposal_hash === v1.hash && e.id < (props[0]?.id ?? Infinity));
  det('The edit recorded no answer (an edit is never a sign-off)', answered.length === 0, answered.map(x.fmt).join('; ') || 'none');
  const p1 = props[0];
  det(`${B}'s Claude asks ${A} and ${B} to sign off on v1: a proposal on v1's hash naming both`,
    p1 && v1 && p1.from === B && p1.hash === v1.hash && p1.plan === 'room' && p1.version === 1 && [A, B].every(n => (p1.approvers || []).includes(n)),
    p1 ? `${x.fmt(p1)} approvers ${p1.approvers?.join(',')}` : 'no sign-off request');
  // the request opens in the native plan dialog (scrollable, hooks/consent.ts); the card is the fallback
  let title = '';
  if (p1) try { title = (fs.readFileSync(path.join(roomDir, 'plans', `${p1.hash}.md`), 'utf8').split('\n').map(l => l.replace(/^\s*(#{1,6}\s+|[-*+>]\s+)/, '').replace(/[*_`]/g, '').trim()).find(Boolean) || '').slice(0, 40); } catch { /* none */ }
  const firstPage = (seat: string): Step => x.caps('S4', seat).find(r => r.caption?.startsWith('The sign-off request opens'))?.step ?? 'last';
  for (const seat of [A, B]) {
    const st4 = firstPage(seat);
    const t = x.cap('S4', seat, st4) || '';
    const view = /Would you like to proceed\?/.test(t) && /Tell Claude what to change|No, keep planning/.test(t) && !!title && t.includes(title);
    const m = new RegExp(`Agree to proposal (${p1 ? esc(p1.hash) : '[0-9a-f]{12}'})\\?`).exec(t);
    const opts = /1\. Not yet/.test(t) && /2\. Agree/.test(t) && /3\. Object/.test(t);
    det(`${seat} reads v1 in the native plan view (Yes / Tell Claude what to change), or on the fallback card`, view || (m && opts && /Consent/.test(t)),
      view ? `plan view showing "${title}" (${x.capName('S4', seat, st4)})` : m ? `card ${m[0]}; options ${opts ? 'Not yet/Agree/Object' : 'missing'} (${x.capName('S4', seat, st4)})` : `no plan view or card in ${x.capName('S4', seat, st4)}`);
  }
  // A pages through the whole plan (PgDn) to its end: the hook's "room proposal HASH" line under it
  const pages = x.caps('S4', A).filter(r => /reads the whole proposal/.test(String(r.caption)));
  const lastPage = pages.at(-1);
  const endT = lastPage ? readText(path.join(x.screens, lastPage.txt)) || '' : x.cap('S4', A, firstPage(A)) || '';
  const endOk = p1 && new RegExp(`room proposal ${esc(p1.hash)}`).test(endT);
  det(`${A} reads the whole plan: PgDn pages through the plan view to its end (the "room proposal HASH" line)`, endOk && /Would you like to proceed\?/.test(endT),
    `${pages.length} PgDn page capture(s) (${pages.map(r => r.txt).join(', ') || 'none'}); last shows ${endOk ? `"room proposal ${p1.hash}"` : 'no end line'}`);
}
