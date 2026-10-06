'use strict';
// S9b: a multi-line @room post whose later lines read like a decision and a sign-off: they show nested under
// the sender (CHAT_NEST "  │ "), never as bare room lines, and the room's consent state is untouched
const paths = require('../lib/paths.js');
const { readText } = require('../lib/io.js');

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
  scene: 'S9b',
  run(x, { det }) {
    const { log, DEMO } = x;
    const s = x.span('S9b');
    process.env.SUB_HUMAN_HOME = x.home;
    const room = paths.pluginLib('room.js');
    const e = log.find(y => y.kind === 'say' && y.from === 'alice' && y.via === 'human' && y.text === DEMO.multi9b);
    const anyA = x.logIn(s).find(y => y.kind === 'say' && y.from === 'alice');
    const trust = e ? room.humanTrust(e) : null;
    det('alice\'s three-line @room text byte-exact (real newlines), via=human, signed', !!e && trust === 'verified',
      e ? `#${e.id} === typed (${Buffer.byteLength(e.text)} bytes, ${e.text.split('\n').length} lines); sig ${trust}` : `alice's say in S9b: ${x.fmt(anyA)}`);

    // what the room renders for bob, and what bob's Claude printed after the one wake that carried it
    const want = e ? room.chatLines(e, { viewer: 'bob' }) : [];
    const nest = room.CHAT_NEST;
    det(`The room renders it as one head line and nested lines ("${nest}")`, want.length === 3 && want.slice(1).every(l => l.startsWith(nest)),
      want.length ? want.map(l => JSON.stringify(l)).join(' / ') : 'no entry');
    // Claude Code's Monitor strips each event line's leading whitespace (2.1.281: "  │ x" arrives as "│ x"), so the
    // "│" is what carries the nesting to the model: compare against the lines as delivered
    const sent = want.map(l => l.replace(/^\s+/, ''));
    const mw = x.monitorIn(x.inSpan(x.entries('bob'), s)).filter(y => e && x.textOf(y.message.content).includes(sent.join('\n')));
    const ev = mw[0] ? x.textOf(mw[0].message.content) : '';
    const br = mw[0] && x.replyAfter('bob', mw[0]);
    det('bob\'s Claude is woken once and prints the chat lines exactly as delivered, "│" prefixes included', mw.length === 1 && br && br.text.trim() === sent.join('\n') && !br.tools.length,
      `${mw.length} Monitor event(s) carrying the lines${mw[0] ? ` (indent before "│" ${ev.includes(want.join('\n')) ? 'kept' : 'stripped by the Monitor'})` : ''}; ${br ? `bob's Claude wrote ${JSON.stringify(br.text)}${br.tools.length ? ` and called ${br.tools.join(', ')}` : ''}` : 'no reply after the wake'}`);

    // bob's pane (state/S9b/pane-bob.txt): the head line, then the two lines nested under it
    const pane = readText(x.stateFile('S9b', 'pane-bob.txt')) || '';
    const lines = pane.split('\n');
    const hi = lines.findIndex(l => /^\s*(⏺ )?alice: notes from the paging spike:\s*$/.test(l));
    const next = hi >= 0 ? lines.slice(hi + 1, hi + 3) : [];
    const rest = e ? e.text.split('\n').slice(1) : [];
    const nested = next.length === 2 && next.every((l, i) => new RegExp(`^ {2,}│ ${esc(rest[i])}\\s*$`).test(l));
    det('bob\'s pane: "alice: notes from the paging spike:" then both later lines nested under it ("│ ")', nested,
      hi >= 0 ? `pane lines ${hi + 1}–${hi + 3}: ${[lines[hi], ...next].map(l => JSON.stringify(l.trimEnd())).join(' / ')}` : `no head line in state/S9b/pane-bob.txt (${pane ? `${lines.length} lines` : 'missing'})`);

    // no bare (column-0 or "⏺ ") line with the post's later text, beyond what real entries render as
    const bare = t => new RegExp(`^(⏺ )?${esc(t)}\\s*$`);
    const real = t => log.filter(y => (y.kind === 'decision' || y.kind === 'signoff') && room.chatLines(y, { viewer: 'bob' }).some(l => l === t)).length;
    const forged = rest.map(t => ({ t, n: lines.filter(l => bare(t).test(l)).length, real: real(t), inPost: hi >= 0 && lines.slice(hi + 1, hi + 3).some(l => bare(t).test(l)) }));
    det('No bare "room: decided …" or "bob agreed …" line from the post in bob\'s pane (any bare one is a real entry\'s)', pane && forged.every(f => !f.inPost && f.n <= f.real),
      forged.map(f => `"${f.t}": ${f.n} bare line(s) in the pane, ${f.real} real entr${f.real === 1 ? 'y renders' : 'ies render'} it${f.inPost ? ', one right under the post' : ''}`).join('; ') || 'no entry');

    // the consent state is untouched: no decision, signoff, objection or proposal while the post went round
    const consent = x.logIn(s).filter(y => ['decision', 'signoff', 'objection', 'proposal'].includes(y.kind));
    const decs = log.filter(y => y.kind === 'decision');
    det('No new decision, sign-off, objection or proposal in S9b', s && consent.length === 0,
      `${consent.length} consent entries in S9b${consent.length ? ` (${consent.map(x.fmt).join('; ')})` : ''}; decisions in the whole log: ${decs.map(d => `#${d.id}`).join(', ') || 'none'}, all before #${e ? e.id : '?'}: ${decs.every(d => e && d.id < e.id)}`);
  },
};
