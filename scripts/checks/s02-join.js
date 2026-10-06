'use strict';
// S2: bob joins
const { panelRows } = require('../lib/panes.js');
const { readText, clip } = require('../lib/io.js');

module.exports = {
  scene: 'S2',
  run(x, { det, beh }, T) {
    const { code } = x;
    const j = x.byKind('member_joined', { from: 'bob' })[0];
    det('member_joined bob (via system)', j && j.via === 'system', x.fmt(j));
    const rc = /sub-human: joined ([a-z]+-\d{4}) as bob \(([^)]*)\)/.exec(x.cap('S2', 'bob') || '');
    det('bob\'s join line: "joined CODE as bob (alice, orch here)"', rc && rc[1] === code && /alice/.test(rc[2]) && /orch/.test(rc[2]), rc ? rc[0] : `not in ${x.capName('S2', 'bob')}`);
    const ha = x.st('S2', 1, 'holds-alice.json', {}), hb = x.st('S2', 1, 'holds-bob.json', {}), ho = x.st('S2', 1, 'holds-orch.json', {});
    det('Rows: bob nested in alice\'s room row, alice in bob\'s, both in the orch\'s', ha.room && (ha.members || []).includes('bob') && hb.room && (hb.members || []).includes('alice') && ['alice', 'bob'].every(n => (ho.members || []).includes(n)),
      `holds-alice ${JSON.stringify({ room: ha.room, members: ha.members })}; holds-bob ${JSON.stringify({ room: hb.room, members: hb.members })}; holds-orch ${JSON.stringify(ho.members)}`);
    const br = panelRows(x.cap('S2', 'bob'));
    const top = br.filter(r => !r.nested);
    det(`bob's panel: only the ${code} row at the top level (no stray participant row)`, top.length === 1 && top[0].label === code, br.map(r => r.line).join(' | ') || 'no rows');
    const orr = panelRows(x.cap('S2', 'orch'));
    det('The orch\'s panel lists alice and bob', ['alice', 'bob'].every(n => orr.some(r => r.label === n)), orr.map(r => r.line).join(' | ') || 'none');
    const n = x.orchTurns(x.span('S2'));
    beh(`The orch spent at most ${T.orchJoinCalls} model calls on the join (its row spawn)`, n, T.orchJoinCalls, `${n} orch assistant messages in S2`);
    // the join as a group-chat line in alice's pane: the monitor's "bob joined", printed by her Claude as is
    const jt = readText(x.stateFile('S2', 'notice-alice.txt')) || '';
    const jl = /^\s*(⏺ )?bob joined\s*$/m.exec(jt);
    const via = j && x.shownVia('alice', j.id);
    det('alice sees the chat line "bob joined" (a lasting line, no room code, no ids)', jl && via === 'monitor',
      `${jl ? `"${jl[0].trim()}" in alice's pane (state/S2/notice-alice.txt)` : 'not seen in alice\'s pane'}; rows/notices-alice.json: #${j ? j.id : '?'} shown via ${via || 'nothing'}`);
    const arow = panelRows(x.cap('S2', 'alice')).find(r => r.label === code);
    det('alice\'s room row reads "+bob joined"', !!(arow && /\+bob joined/.test(arow.text)), arow ? arow.line : `no ${code} row in ${x.capName('S2', 'alice')}`);
    const woke = j ? x.monitorIn(x.entries('alice')).filter(e => e.timestamp > j.at && e.timestamp <= (x.span('S2') || {}).to && /bob joined/.test(x.textOf(e.message && e.message.content))) : [];
    const rep = woke[0] && x.replyAfter('alice', woke[0]);
    det('The join woke alice\'s Claude once, and it printed only the chat line', woke.length === 1 && rep && rep.text.trim() === 'bob joined' && !rep.tools.length,
      `${woke.length} room wake(s) carrying the join; her Claude wrote ${rep ? JSON.stringify(clip(rep.text, 120)) : 'nothing'}${rep && rep.tools.length ? ` and called ${rep.tools.join(', ')}` : ''}`);
  },
};
