// S9b: a multi-line @room post whose later lines read like a decision and a sign-off: they show nested under
// the sender (CHAT_NEST "  │ "), never as bare room lines, and the room's consent state is untouched
import * as paths from '../lib/paths.ts';
import { readText, esc } from '../lib/io.ts';
import type { Ctx, Det } from './context.ts';

export const scene = 'S9b';

export function run(x: Ctx, { det }: { det: Det }): void {
  const { log, DEMO } = x;
  const s = x.span('S9b');
  process.env.SUB_HUMAN_HOME = x.home;
  const room = paths.pluginLib('room.ts');
  const e = log.find(y => y.kind === 'say' && y.from === 'alice' && y.via === 'human' && y.text === DEMO.multi9b);
  const anyA = x.logIn(s).find(y => y.kind === 'say' && y.from === 'alice');
  const trust = e ? room.trustOf(e) : null;
  det('alice\'s three-line @room text byte-exact (real newlines), via=human, signed', !!e && trust === 'verified',
    e ? `#${e.id} === typed (${Buffer.byteLength(String(e.text))} bytes, ${String(e.text).split('\n').length} lines); sig ${trust}` : `alice's say in S9b: ${x.fmt(anyA)}`);

  // what the room renders for bob, and how it reached him: the hooks module's chat row ($.ui.log) and the isMeta
  // copy for his Claude, both carrying the lines as rendered, "│" nesting included; chat starts no model turn
  const want = e ? room.chatLines(e, { viewer: 'bob' }) : [];
  const nest = room.CHAT_NEST;
  det(`The room renders it as one head line and nested lines ("${nest}")`, want.length === 3 && want.slice(1).every(l => l.startsWith(nest)),
    want.length ? want.map(l => JSON.stringify(l)).join(' / ') : 'no entry');
  const bes = x.inSpan(x.entries('bob'), s);
  // one $.ui.log row per line (a notice is one line: a newline in one would be drawn as U+FFFD)
  const all = x.chatIn(bes);
  const notes = e ? all.filter((_y, i) => want.every((l, k) => all[i + k]?.content === `sub-human: ${l}`)) : [];
  const copies = x.pullIn(bes).filter(y => e && x.textOf(y.message?.content).includes(want.join('\n')));
  const ct = notes[0] ? x.chatTurn('bob', notes[0]) : null;
  det('bob gets the lines once as a chat row and once as his Claude\'s copy, "│" prefixes included, with no model turn', notes.length === 1 && copies.length === 1 && ct && !ct.woke,
    `${notes.length} run(s) of three chat rows and ${copies.length} isMeta copy(ies) carrying the rendered lines verbatim${notes.length ? '' : `; chat rows seen: ${all.filter(y => /notes from the paging spike/.test(String(y.content))).map(y => JSON.stringify(y.content)).join(' / ') || 'none'}`}; ${ct ? ct.evidence : 'no chat row'}`);

  // bob's pane (state/S9b/pane-bob.txt): the head line, then the two lines nested under it
  const pane = readText(x.stateFile('S9b', 'pane-bob.txt')) || '';
  const lines = pane.split('\n');
  const hi = lines.findIndex(l => /^\s*(⏺ )?(sub-human: )?alice: notes from the paging spike:\s*$/.test(l));
  // the two lines after the head, past the blank spacer the engine draws between rows (nothing else in between)
  const after = hi >= 0 ? lines.slice(hi + 1).map((l, k) => ({ l, k: hi + 1 + k })).filter(y => y.l.trim()).slice(0, 2) : [];
  const next = after.map(y => y.l);
  const span2 = after.at(-1)?.k ?? hi;
  const rest = e ? String(e.text).split('\n').slice(1) : [];
  // each later line its own chat row, still under the "│" ("⏺ sub-human:   │ …"), or a plain continuation line
  const nested = next.length === 2 && next.every((l, i) => rest[i] !== undefined && new RegExp(`^(\\s*(⏺ )?sub-human: +| {2,})│ ${esc(rest[i])}\\s*$`).test(l));
  det('bob\'s pane: "alice: notes from the paging spike:" then both later lines nested under it ("│ ")', nested,
    hi >= 0 ? `pane lines ${hi + 1}–${span2 + 1}: ${[lines[hi] ?? '', ...next].map(l => JSON.stringify(l.trimEnd())).join(' / ')}` : `no head line in state/S9b/pane-bob.txt (${pane ? `${lines.length} lines` : 'missing'})`);

  // no bare (column-0 or "⏺ ") line with the post's later text, beyond what real entries render as
  const bare = (t: string): RegExp => new RegExp(`^(⏺ )?${esc(t)}\\s*$`);
  const real = (t: string): number => log.filter(y => (y.kind === 'decision' || y.kind === 'signoff') && room.chatLines(y, { viewer: 'bob' }).some(l => l === t)).length;
  const forged = rest.map(t => ({ t, n: lines.filter(l => bare(t).test(l)).length, real: real(t), inPost: hi >= 0 && lines.slice(hi + 1, span2 + 1).some(l => bare(t).test(l)) }));
  det('No bare "room: decided …" or "bob agreed …" line from the post in bob\'s pane (any bare one is a real entry\'s)', pane && forged.every(f => !f.inPost && f.n <= f.real),
    forged.map(f => `"${f.t}": ${f.n} bare line(s) in the pane, ${f.real} real entr${f.real === 1 ? 'y renders' : 'ies render'} it${f.inPost ? ', one right under the post' : ''}`).join('; ') || 'no entry');

  // the consent state is untouched: no decision, signoff, objection or proposal while the post went round
  const consent = x.logIn(s).filter(y => ['decision', 'signoff', 'objection', 'proposal'].includes(y.kind));
  const decs = log.filter(y => y.kind === 'decision');
  det('No new decision, sign-off, objection or proposal in S9b', s && consent.length === 0,
    `${consent.length} consent entries in S9b${consent.length ? ` (${consent.map(x.fmt).join('; ')})` : ''}; decisions in the whole log: ${decs.map(d => `#${d.id}`).join(', ') || 'none'}, all before #${e ? e.id : '?'}: ${decs.every(d => e && d.id < e.id)}`);
}
