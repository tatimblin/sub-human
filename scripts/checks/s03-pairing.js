'use strict';
// S3: pairing with no plan: @room both ways, then Claude-to-Claude SendMessage
const { clip } = require('../lib/io.js');

module.exports = {
  scene: 'S3',
  run(x, { det }) {
    const { code, log, DEMO, A, B } = x;
    const s = x.span('S3');
    const e = log.find(y => y.kind === 'say' && y.from === A && y.via === 'human' && y.text === DEMO.say3);
    const anyA = log.find(y => y.kind === 'say' && y.from === A && y.via === 'human');
    det(`${A}'s @room text byte-exact, via=human`, !!e, e ? `#${e.id} === typed (${Buffer.byteLength(e.text)} bytes)` : `first ${A} say: ${x.fmt(anyA)}`);
    const t = x.cap('S3', A) || '';
    const receipt = `⏺ ✓ sent to room ${code} (Claude wasn't asked)`;
    const rc = e && t.split('\n').some(l => l.trimEnd() === receipt);
    det(`One receipt line "${receipt}" (no id); no "Operation stopped by hook", no "blocked by hook"`, rc && !/stopped by hook|blocked by hook/.test(t) && !/✓ posted|as #\d/.test(t), rc ? `receipt for #${e.id} in ${x.capName('S3', A)}` : `no receipt in ${x.capName('S3', A)}`);
    const turn = x.noModelTurn(A, e);
    det(`${A}'s @room ran no model turn`, turn.pass, turn.evidence);
    // a person's words to the room are group chat: bob sees them as a row, his Claude gets a copy, no wake
    const want = e ? `${A}: ${e.text}` : '';
    const bes = x.inSpan(x.entries(B), s);
    const notes = x.chatIn(bes).filter(y => e && y.content === `sub-human: ${want}`);
    const pulls = x.pullIn(bes).filter(y => e && x.textOf(y.message.content).split('\n').includes(want));
    det(`${B} gets ${A}'s exact words once: a chat row "${A}: <the words>" for ${B}, one copy for ${B}'s Claude`, notes.length === 1 && pulls.length === 1,
      `${notes.length} chat row(s) and ${pulls.length} isMeta copy(ies) in ${B}'s transcript carrying "${clip(want, 70)}" verbatim`);
    const woke = x.wakeIn(bes).filter(y => e && x.textOf(y.message.content).includes(e.text));
    const ct = notes[0] ? x.chatTurn(B, notes[0]) : null;
    det(`${A}'s words cost ${B}'s Claude no model turn (no wake, nothing to repeat)`, woke.length === 0 && ct && !ct.woke,
      `${woke.length} wake(s) carrying #${e ? e.id : '?'}; ${ct ? ct.evidence : 'no chat row'}`);
    const sm = x.toolUses(x.inSpan(x.entries(B), s), 'SendMessage').filter(c => String((c.input || {}).to || '') === `${A}.${code}`);
    det(`${B}'s Claude calls SendMessage to ${A}.${code}`, sm.length >= 1, sm.length ? `SendMessage {to: "${sm[0].input.to}", message: "${clip(sm[0].input.message || sm[0].input.content, 80)}"}` : `no SendMessage to ${A}`);
    const pe = x.peerIn(x.inSpan(x.entries(A), s), B);
    det(`${A}'s Claude receives it as a peer message from ${B} (origin.kind peer)`, pe.length >= 1, pe.length ? `origin {kind: peer, name: ${pe[0].origin.name}, verifiedPeerPid: ${pe[0].origin.verifiedPeerPid}}: "${clip(pe[0].origin.body, 80)}"` : `no peer entry from ${B}`);
    // a reply goes to bob.CODE, or to the peer socket the incoming message came from ("uds:…", Claude Code's reply address)
    const back = x.toolUses(x.inSpan(x.entries(A), s), 'SendMessage').filter(c => { const to = String((c.input || {}).to || ''); return to === `${B}.${code}` || /^uds:/.test(to); });
    const pb = x.peerIn(x.inSpan(x.entries(B), s), A);
    det(`${A}'s Claude answers natively (SendMessage back; ${B} receives it)`, back.length >= 1 && pb.length >= 1, `${A} SendMessage back (${B}.${code} or the uds: reply address): ${back.length}${back[0] ? ` (to ${back[0].input.to})` : ''}; peer entries from ${A} in ${B}'s transcript: ${pb.length}${pb[0] ? ` ("${clip(pb[0].origin.body, 70)}")` : ''}`);
    const cards = [A, B].flatMap(seat => x.toolUses(x.inSpan(x.entries(seat), s), 'AskUserQuestion'));
    det('No card and no proposal', cards.length === 0 && !x.logIn(s).some(y => y.kind === 'proposal'), `${cards.length} AskUserQuestion calls; proposals in S3: ${x.logIn(s).filter(y => y.kind === 'proposal').length}`);
    // zero is the contract (the room's Claude wakes only when addressed), not a budget: deterministic
    const n = x.roomClaudeTurns(s);
    det('The room\'s Claude was not woken', n === 0, `${n} claude assistant messages in S3 (${s ? s.from.slice(11, 19) + '–' + s.to.slice(11, 19) : 'no window'})`);
  },
};
