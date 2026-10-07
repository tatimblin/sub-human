'use strict';
// S3: pairing with no plan: @room both ways, then Claude-to-Claude SendMessage
const { clip } = require('../lib/io.js');

module.exports = {
  scene: 'S3',
  run(x, { det }) {
    const { code, log, DEMO } = x;
    const s = x.span('S3');
    const e = log.find(y => y.kind === 'say' && y.from === 'alice' && y.via === 'human' && y.text === DEMO.alice3);
    const anyA = log.find(y => y.kind === 'say' && y.from === 'alice' && y.via === 'human');
    det('alice\'s @room text byte-exact, via=human', !!e, e ? `#${e.id} === typed (${Buffer.byteLength(e.text)} bytes)` : `first alice say: ${x.fmt(anyA)}`);
    const t = x.cap('S3', 'alice') || '';
    const rc = e && /Operation stopped by hook: ✓ sent\s*$/m.test(t);
    det('One receipt line "Operation stopped by hook: ✓ sent" (no room code, no id); no "blocked by hook"', rc && !/blocked by hook/.test(t) && !/✓ posted|as #\d/.test(t), rc ? `receipt for #${e.id} in ${x.capName('S3', 'alice')}` : `no receipt in ${x.capName('S3', 'alice')}`);
    const turn = x.noModelTurn('alice', e);
    det('alice\'s @room ran no model turn', turn.pass, turn.evidence);
    // a person's words to the room are group chat: bob sees them as a row, his Claude gets a copy, no wake
    const want = e ? `alice: ${e.text}` : '';
    const bes = x.inSpan(x.entries('bob'), s);
    const notes = x.chatIn(bes).filter(y => e && y.content === `sub-human: ${want}`);
    const pulls = x.pullIn(bes).filter(y => e && x.textOf(y.message.content).split('\n').includes(want));
    det('bob gets alice\'s exact words once: a chat row "alice: <her words>" for him, one copy for his Claude', notes.length === 1 && pulls.length === 1,
      `${notes.length} chat row(s) and ${pulls.length} isMeta copy(ies) in bob's transcript carrying "${clip(want, 70)}" verbatim`);
    const woke = x.wakeIn(bes).filter(y => e && x.textOf(y.message.content).includes(e.text));
    const ct = notes[0] ? x.chatTurn('bob', notes[0]) : null;
    det('alice\'s words cost bob\'s Claude no model turn (no wake, nothing to repeat)', woke.length === 0 && ct && !ct.woke,
      `${woke.length} wake(s) carrying #${e ? e.id : '?'}; ${ct ? ct.evidence : 'no chat row'}`);
    const sm = x.toolUses(x.inSpan(x.entries('bob'), s), 'SendMessage').filter(c => String((c.input || {}).to || '') === `alice.${code}`);
    det(`bob's Claude calls SendMessage to alice.${code}`, sm.length >= 1, sm.length ? `SendMessage {to: "${sm[0].input.to}", message: "${clip(sm[0].input.message || sm[0].input.content, 80)}"}` : 'no SendMessage to alice');
    const pe = x.peerIn(x.inSpan(x.entries('alice'), s), 'bob');
    det('alice\'s Claude receives it as a peer message from bob (origin.kind peer)', pe.length >= 1, pe.length ? `origin {kind: peer, name: ${pe[0].origin.name}, verifiedPeerPid: ${pe[0].origin.verifiedPeerPid}}: "${clip(pe[0].origin.body, 80)}"` : 'no peer entry from bob');
    // a reply goes to bob.CODE, or to the peer socket the incoming message came from ("uds:…", Claude Code's reply address)
    const back = x.toolUses(x.inSpan(x.entries('alice'), s), 'SendMessage').filter(c => { const to = String((c.input || {}).to || ''); return to === `bob.${code}` || /^uds:/.test(to); });
    const pb = x.peerIn(x.inSpan(x.entries('bob'), s), 'alice');
    det('alice\'s Claude answers natively (SendMessage back; bob receives it)', back.length >= 1 && pb.length >= 1, `alice SendMessage back (bob.${code} or the uds: reply address): ${back.length}${back[0] ? ` (to ${back[0].input.to})` : ''}; peer entries from alice in bob's transcript: ${pb.length}${pb[0] ? ` ("${clip(pb[0].origin.body, 70)}")` : ''}`);
    const cards = ['alice', 'bob'].flatMap(seat => x.toolUses(x.inSpan(x.entries(seat), s), 'AskUserQuestion'));
    det('No card and no proposal', cards.length === 0 && !x.logIn(s).some(y => y.kind === 'proposal'), `${cards.length} AskUserQuestion calls; proposals in S3: ${x.logIn(s).filter(y => y.kind === 'proposal').length}`);
    // zero is the contract (the orch wakes only when addressed), not a budget: deterministic
    const n = x.orchTurns(s);
    det('The orch was not woken', n === 0, `${n} orch assistant messages in S3 (${s ? s.from.slice(11, 19) + '–' + s.to.slice(11, 19) : 'no window'})`);
  },
};
