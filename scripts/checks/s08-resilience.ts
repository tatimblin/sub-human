// S8: resilience: /clear keeps rows; /exit + --continue brings the row back with no prompt; the room still reaches bob
import * as metrics from '../metrics.ts';
import { panelRows } from '../lib/panes.ts';
import { esc } from '../lib/io.ts';
import type { Ctx, Det } from './context.ts';
import type { Members } from '../../plugin/sub-human/lib/room/types.ts';

export const scene = 'S8';

export function run(x: Ctx, { det }: { det: Det }): void {
  const { code, log } = x;
  const s = x.span('S8');
  const a1 = panelRows(x.cap('S8', 'alice', 1));
  const ms1 = x.st<Members>('S8', 1, 'members.json', {}), ms0 = x.st<Members | null>('S7', 'last', 'members.json', null) || x.st<Members>('S6', 'last', 'members.json', {});
  const leftA = x.logIn(s).filter(e => e.kind === 'member_left' && e.from === 'alice');
  det(`/clear in alice: new session id, same seat, still one ${code} row, no member_left`, ms1.alice && ms0.alice && ms1.alice.session_id !== ms0.alice.session_id && a1.filter(r => r.label === code).length === 1 && !leftA.length && new RegExp(`alice\\.${esc(code)}`).test(x.cap('S8', 'alice', 1) || ''),
    `session ${ms0.alice ? ms0.alice.session_id?.slice(0, 8) : '?'} → ${ms1.alice ? ms1.alice.session_id?.slice(0, 8) : '?'}; rows ${a1.map(r => r.line).join(' | ')}; member_left ${leftA.length}`);
  const left = x.logIn(s).find(e => e.kind === 'member_left' && e.from === 'bob');
  const back = left && log.find(e => e.kind === 'member_joined' && e.from === 'bob' && e.id > left.id);
  det('bob /exit + --continue: member_left then "rejoined (resumed)"', left && back && /resumed/.test(String(back.text)), `${x.fmt(left)} → ${x.fmt(back)}`);
  const b2 = panelRows(x.cap('S8', 'bob', 2));
  const bcap = x.caps('S8', 'bob')[1];
  let ev = 'no capture', ok = false;
  if (left && bcap) {
    const es = x.entries('bob').filter(e => e.timestamp !== undefined && e.timestamp > left.at && e.timestamp <= bcap.time && !e.isSidechain);
    const prompts = es.filter(e => e.type === 'user' && !e.isMeta && !metrics.trigger(e) && !(e.origin && e.origin.kind === 'task-notification') && !(Array.isArray(e.message && e.message.content) && metrics.blocksOf(e).every(c => c && c.type === 'tool_result')));
    const wake = es.find(e => metrics.trigger(e) === 'rewake');
    const call = wake && es.find(e => e.type === 'assistant' && e.timestamp !== undefined && wake.timestamp !== undefined && e.timestamp >= wake.timestamp && JSON.stringify(e.message?.content ?? null).includes('"Agent"'));
    ok = !!wake && !!call && prompts.length === 0 && b2.filter(r => r.label === code).length === 1 && b2.filter(r => !r.nested).length === 1;
    ev = `${wake ? `row-rewake wake ${wake.timestamp?.slice(11, 19)}` : 'no row-rewake wake'}; ${call ? `Agent call ${call.timestamp?.slice(11, 19)}` : 'no Agent call'}; ${prompts.length} prompt(s) from bob; rows ${b2.map(r => r.line).join(' | ') || 'none'}`;
  }
  det('bob\'s room row is back with no prompt (row-rewake), no duplicate rows', ok, ev);
  const say = log.find(e => e.kind === 'say' && e.from === 'alice' && e.via === 'human' && back && e.id > back.id);
  // the tail child came back with the resumed session: alice's words reach bob (a chat row and his Claude's copy)
  const after = say ? x.entries('bob').filter(e => e.timestamp !== undefined && e.timestamp > say.at) : [];
  const rows = after.filter(e => metrics.isChatNotice(e) && e.content === `sub-human: alice: ${say?.text}`);
  const copies = after.filter(e => metrics.isPull(e) && x.textOf(e.message?.content).includes(String(say?.text)));
  det('The room still reaches bob after the resume (his tail child is back)', rows.length >= 1 && copies.length >= 1,
    say ? `${x.fmt(say)} → ${rows.length} chat row(s) and ${copies.length} isMeta copy(ies) in bob's transcript` : 'no alice @room after the resume');
}
