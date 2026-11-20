// S4: B's own Claude drafts the room plan: an edit in plan mode the hooks store as v1 (the receipt, no approval
// dialog); B checks it first in her own plan view (0.5.0-beta.24), her Yes sends it out, and A reads v1 in his
import fs from 'node:fs';
import path from 'node:path';
import { readText, esc } from '../lib/io.ts';
import { toolResults } from './transcripts.ts';
import { isRed } from '../metrics.ts';
import type { Ctx, Det } from './context.ts';
import type { Step } from './captures.ts';

export const scene = 'S4';

/**
 * The red "Error:" lines a plan save drew in seat's pane (the store's receipt is the save's deny; 0.6.0's ui.render
 * pass hides its red result row, mod/core/quiet.ts): in the pane saved at the save (state/SCENE/save-SEAT.txt and
 * .ansi) and in the seat's captures of the scene. A line counts when it reads "Error:" and is drawn red (the .ansi),
 * or, with no .ansi, when it is a tool result row "⎿ Error: …". {lines, read}: the hits and the files read.
 */
export function saveErrors(x: Ctx, sc: string, seat: string): { lines: string[], read: string[] } {
  const plain = (l: string): string => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const files = [x.stateFile(sc, `save-${seat}.txt`), ...x.caps(sc, seat).map(r => path.join(x.screens, r.txt))];
  const lines: string[] = [], read: string[] = [];
  for (const f of files) {
    const txt = readText(f);
    if (txt == null) continue;
    read.push(path.basename(f));
    const ansi = readText(f.replace(/\.txt$/, '.ansi'));
    const hits = ansi != null
      ? ansi.split('\n').filter(l => /Error:/.test(plain(l)) && isRed(l)).map(plain)
      : txt.split('\n').filter(l => /^\s*⎿\s+Error:/.test(l));
    for (const h of hits) lines.push(`${path.basename(f)}: ${h.trim().slice(0, 100)}`);
  }
  return { lines, read };
}

export function run(x: Ctx, { det }: { det: Det }): void {
  const { log, roomDir, props, drafts, A, B } = x;
  // the first plan, by the name its heading gave it (0.6.0; before, `room`)
  const v1 = log.find(e => e.kind === 'plan' && e.version === 1);
  det(`${B}'s Claude stores room plan v1: a plan entry from ${B} for ${B}, base 0, its text stored by hash`,
    v1 && v1.from === B && v1.via === 'agent' && v1.for === B && v1.base === 0 && fs.existsSync(path.join(roomDir, 'plans', `${v1.hash}.md`)),
    v1 ? `${x.fmt(v1)}; plans/${v1.hash}.md ${fs.existsSync(path.join(roomDir, 'plans', `${v1.hash}.md`)) ? 'present' : 'missing'}` : 'no plan entry');
  // the edit's ExitPlanMode came back with the store's receipt (a deny: no approval dialog), and nothing was answered
  const s4 = x.span('S4');
  const es = x.inSpan(x.entries(B), s4);
  const receipt = toolResults(es).find(t => /plan \S+ v1 saved[,;] |saved as room plan \S+ v1, not (agreed|sent out) yet/.test(t));
  det(`${B}'s Claude was told the receipt ("plan NAME v1 saved; you review it …"), no approval dialog`, !!receipt, receipt ? receipt.slice(0, 120) : 'no receipt in its transcript');
  // release gate: the save draws no red "Error:" (the receipt is a deny; the person never sees it as one)
  const se = saveErrors(x, 'S4', B);
  det(`No red "Error:" in ${B}'s pane on the save of v1`, se.read.includes(`save-${B}.txt`) && se.lines.length === 0,
    se.lines.length ? se.lines.slice(0, 3).join(' | ') : se.read.includes(`save-${B}.txt`) ? `none in ${se.read.length} pane(s)` : `state/S4/save-${B}.txt not saved`);
  const d1 = drafts[0];
  const answered = log.filter(e => (e.kind === 'signoff' || e.kind === 'objection') && v1 && e.proposal_hash === v1.hash && e.id < (d1?.id ?? Infinity));
  det('The edit recorded no answer (an edit is never a sign-off)', answered.length === 0, answered.map(x.fmt).join('; ') || 'none');
  const p1 = props[0];
  det(`${B} checks v1 first: a request to ${B} alone, before anyone else is asked`,
    d1 && v1 && d1.from === B && d1.to === B && d1.hash === v1.hash && (d1.approvers || []).join() === B && (!p1 || d1.id < p1.id),
    d1 ? `${x.fmt(d1)} to ${d1.to} approvers ${d1.approvers?.join(',')}` : 'no check for the author');
  const own = v1 && log.find(e => e.kind === 'signoff' && e.from === B && e.proposal_hash === v1.hash);
  det(`${B}'s Yes on her check is her sign-off (via=human) and sends v1 out: a request from ${B} naming ${A}`,
    own && own.via === 'human' && p1 && v1 && p1.from === B && p1.hash === v1.hash && p1.plan === v1.plan && p1.version === 1 && (p1.approvers || []).includes(A) && own.id < p1.id,
    `${x.fmt(own)}; ${p1 ? `${x.fmt(p1)} approvers ${p1.approvers?.join(',')}` : 'no sign-off request'}`);
  // the request opens in the native plan dialog (scrollable, hooks/consent.ts); the card is the fallback
  let title = '';
  if (p1) try { title = (fs.readFileSync(path.join(roomDir, 'plans', `${p1.hash}.md`), 'utf8').split('\n').map(l => l.replace(/^\s*(#{1,6}\s+|[-*+>]\s+)/, '').replace(/[*_`]/g, '').trim()).find(Boolean) || '').slice(0, 40); } catch { /* none */ }
  // B's first view is her own check of v1; A's is the request her Yes sent out
  const firstPage = (seat: string): Step => x.caps('S4', seat).find(r => r.caption?.startsWith(seat === B ? `${B}'s Claude stores v1` : 'The sign-off request opens'))?.step ?? 'last';
  for (const seat of [A, B]) {
    const st4 = firstPage(seat);
    const t = x.cap('S4', seat, st4) || '';
    const view = /Would you like to proceed\?/.test(t) && /Tell Claude what to change|No, keep planning/.test(t) && !!title && t.includes(title);
    const m = new RegExp(`Agree to proposal (${p1 ? esc(p1.hash) : '[0-9a-f]{12}'})\\?`).exec(t);
    const opts = /1\. Not yet/.test(t) && /2\. Agree/.test(t) && /3\. Object/.test(t);
    det(`${seat} reads v1 in the native plan view (Yes / Tell Claude what to change), or on the fallback card`, view || (m && opts && /Consent/.test(t)),
      view ? `plan view showing "${title}" (${x.capName('S4', seat, st4)})` : m ? `card ${m[0]}; options ${opts ? 'Not yet/Agree/Object' : 'missing'} (${x.capName('S4', seat, st4)})` : `no plan view or card in ${x.capName('S4', seat, st4)}`);
  }
  // A pages through the whole plan (PgDn) to its end: the hook's ask under it, which names the request
  // (lib/consent/review.ts requestName: "sign-off on plan NAME vN", or "room proposal HASH" for one with no plan)
  const pages = x.caps('S4', A).filter(r => /reads the whole proposal/.test(String(r.caption)));
  const lastPage = pages.at(-1);
  const endT = lastPage ? readText(path.join(x.screens, lastPage.txt)) || '' : x.cap('S4', A, firstPage(A)) || '';
  const endLine = p1 ? (typeof p1.plan === 'string' && typeof p1.version === 'number' ? `sign-off on plan ${p1.plan} v${p1.version}` : `room proposal ${p1.hash}`) : null;
  const endOk = !!endLine && new RegExp(`${esc(endLine)}\\b`).test(endT);
  det(`${A} reads the whole plan: PgDn pages through the plan view to its end (the hook's "sign-off on plan NAME vN" line)`, endOk && /Would you like to proceed\?/.test(endT),
    `${pages.length} PgDn page capture(s) (${pages.map(r => r.txt).join(', ') || 'none'}); last shows ${endOk ? `"${endLine}"` : `no end line${endLine ? ` ("${endLine}")` : ''}`}`);
}
