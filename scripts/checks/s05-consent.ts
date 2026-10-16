// S5: B objects with a note, A agrees; the room's Claude revises; both agree -> decision
import crypto from 'node:crypto';
import path from 'node:path';
import { readText } from '../lib/io.ts';
import type { Ctx, Det } from './context.ts';
import { blocksOf } from '../metrics.ts';
import type { Block, TEntry } from '../metrics.ts';

const hash12 = (t: string): string => crypto.createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex').slice(0, 12);

/**
 * A room review: an ExitPlanMode call that showed a room proposal in the plan dialog. Its recorded plan is the
 * model's "proposal <hash>" stub, or, when the hooks wrote the proposal into the plan file before the call (a later
 * review: the file's path is known from the first), the proposal's own text, which Claude Code records in its place
 * (hash12 of it is the proposal's hash). The no-dialog close after an objection ("approved exiting plan mode") is not one.
 */
export function isReview(call: Block, es: TEntry[], hashes: Set<string>): boolean {
  const plan = String((call.input || {}).plan || '');
  const stub = /^proposal ([0-9a-f]{12})\b/.exec(plan);
  if (!(stub ? hashes.has(stub[1]) : hashes.has(hash12(plan)))) return false;
  const res = es.flatMap(e => (e.type === 'user' ? blocksOf(e) : [])).find(r => r && r.type === 'tool_result' && r.tool_use_id === call.id);
  const t = res ? (typeof res.content === 'string' ? res.content : JSON.stringify(res.content)) : '';
  return !/^User has approved exiting plan mode/.test(t);
}

const MODE: Record<string, RegExp> = { auto: /auto mode on/, acceptEdits: /accept edits on/, plan: /plan mode on/, default: /^(?![\s\S]*(auto mode on|accept edits on|plan mode on))/ };

export const scene = 'S5';

export function run(x: Ctx, { det }: { det: Det }): void {
  const { log, props, DEMO, A, B } = x;
  const p1 = props[0], p2 = props[1];
  const ob = p1 && log.find(e => e.kind === 'objection' && e.from === B && e.proposal_hash === p1.hash);
  det(`${B}'s objection via=human; the note byte-exact`, ob && ob.via === 'human' && ob.text === DEMO.note5, ob ? `${x.fmt(ob)} (${ob.text === DEMO.note5 ? '===' : '!=='} typed)` : 'no objection');
  const sa = p1 && log.find(e => e.kind === 'signoff' && e.from === A && e.proposal_hash === p1.hash);
  det(`${A}'s agreement on the first proposal via=human`, sa && sa.via === 'human', x.fmt(sa));
  det('The room\'s Claude revised: a second proposal with a new hash', p2 && p2.from === 'claude' && p2.hash !== p1.hash, p2 ? `${p1.hash.slice(0, 6)} → ${p2.hash.slice(0, 6)} (#${p2.id})` : 'no revision');
  const sig = p2 ? [A, B].map(n => log.find(e => e.kind === 'signoff' && e.via === 'human' && e.from === n && e.proposal_hash === p2.hash)) : [];
  const d = p2 && log.find(e => e.kind === 'decision' && e.proposal_hash === p2.hash);
  det('Both agree on the revision; the decision cites both answers', sig.length === 2 && sig.every(Boolean) && d && sig.every(y => y && (d.refs || []).includes(y.id)) && /^agreed: /.test(String(d.text)),
    d ? `${x.fmt(d)} refs [${(d.refs || []).join(',')}]` : `signoffs ${sig.map(y => (y ? '#' + y.id : 'missing')).join(', ')}; no decision`);
  const late = p2 ? log.filter(e => (e.kind === 'signoff' || e.kind === 'objection') && e.proposal_hash === p1.hash && e.id > p2.id) : [];
  det('No answer recorded on the old hash after the revision', late.length === 0, late.length ? late.map(x.fmt).join('; ') : `none after #${p2 ? p2.id : '?'}`);
  const human = [A, B].map(n => log.filter(e => e.from === n && (e.kind === 'signoff' || e.kind === 'objection') && e.via !== 'human').length);
  det('Every answer came from a card (via=human); no Claude answered', human.every(n => n === 0), `non-human answers: ${A} ${human[0]}, ${B} ${human[1]}`);
  { const ch = x.chainOk(); det('Hash chain valid', ch.ok, ch.evidence); }
  // after each review the seat is back in its own permission mode, and its session plan file is restored
  // (put back as it was, or removed when it did not exist before: plans-before.txt vs the S5 last step's plans.txt)
  const before = new Set((readText(x.stateFile('plans-before.txt')) || '').split('\n').filter(Boolean));
  const after = x.stText('S5', 'last', 'plans.txt');
  const hashes = new Set(props.map(p => p.hash));
  for (const seat of [A, B]) {
    const s5to = x.span('S5')?.to;
    const es = x.entries(seat).filter(e => !e.isSidechain && e.timestamp && e.timestamp >= x.runStart && s5to !== undefined && e.timestamp <= s5to); // this run's, up to S5's end
    const mode0 = (es.find(e => e.permissionMode) || {}).permissionMode;
    const reviews = x.toolUses(es, 'ExitPlanMode').filter(c => isReview(c, es, hashes));
    const enters = es.filter(e => e.attachment && e.attachment.type === 'plan_mode');
    const exits = es.filter(e => e.attachment && e.attachment.type === 'plan_mode_exit');
    const lastMode = (es.filter(e => e.permissionMode).at(-1) || {}).permissionMode;
    const foot = x.cap('S5', seat, 'last') || '';
    const files = [...new Set(enters.map(e => e.attachment?.planFilePath).filter((f): f is string => !!f))];
    const left = after == null ? null : files.filter(f => after.split('\n').includes(path.basename(f)) && !before.has(path.basename(f)));
    const ok = mode0 && reviews.length >= 2 && exits.length >= enters.length && lastMode === mode0 && MODE[mode0] && MODE[mode0].test(foot) && left && left.length === 0;
    det(`${seat}: after each review, back in the original permission mode and the session plan file restored`, ok,
      `${reviews.length} reviews (${enters.length} plan_mode, ${exits.length} plan_mode_exit); mode ${mode0} → last ${lastMode}; footer ${(/⏵⏵ [a-z ]+ on|⏸ plan mode on/.exec(foot) || ['(no mode label)'])[0]} in ${x.capName('S5', seat, 'last')}; plan file ${files.map(f => path.basename(f)).join(', ') || 'none'}: ${left == null ? 'no plans.txt saved' : left.length ? 'still has the proposal' : before.size && files.some(f => before.has(path.basename(f))) ? 'restored' : 'removed (did not exist before)'}`);
  }
}
