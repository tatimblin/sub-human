// S3: pairing with no plan: @room both ways, then Claude-to-Claude SendMessage. A's line names nobody and asks nothing
// (0.8.0 Phase 2: a line naming a person wakes their Claude; that is S12's), so it is plain group chat: drawn in B's
// room row (Phase 3; off, a chat row in B's main), one copy for B's Claude, no Claude woken
import { clip } from '../lib/io.ts';
import { drawnIn, isChatRow } from './transcripts.ts';
import type { Ctx, Det } from './context.ts';
import type { LogEntry } from './log.ts';

export const scene = 'S3';

export function run(x: Ctx, { det }: { det: Det }): void {
  const { code, log, DEMO, A, B } = x;
  const s = x.span('S3');
  const e = log.find(y => y.kind === 'say' && y.from === A && y.via === 'human' && y.text === DEMO.say3);
  const anyA = log.find(y => y.kind === 'say' && y.from === A && y.via === 'human');
  det(`${A}'s @room text byte-exact, via=human`, !!e, e ? `#${e.id} === typed (${Buffer.byteLength(String(e.text))} bytes)` : `first ${A} say: ${x.fmt(anyA)}`);
  const t = x.cap('S3', A) || '';
  // the quiet receipt: the person's own "❯ @room …" row is it (the stop row is drawn blank, its words go to the debug
  // log: mod/core/prompt.ts isSent); no hook frame, no id
  const own = !!e && t.split('\n').some(l => l.trim() === `❯ @room ${e.text}`);
  det(`${A}'s own "@room …" row is the receipt: no receipt text, no "Operation stopped by hook", no "blocked by hook", no id`, own && !/stopped by hook|blocked by hook/.test(t) && !/✓ posted|as #\d/.test(t),
    own ? `"❯ @room …" for #${e.id} in ${x.capName('S3', A)}, no frame` : `no "❯ @room ${clip(e?.text, 40)}" row in ${x.capName('S3', A)}`);
  const turn = x.noModelTurn(A, e);
  det(`${A}'s @room ran no model turn`, turn.pass, turn.evidence);
  // a person's words to the room are group chat, both ways: the other sees them once, their Claude gets one copy,
  // nothing wakes it
  const r = log.find(y => y.kind === 'say' && y.from === B && y.via === 'human' && y.text === DEMO.reply3);
  chatLine(x, det, A, B, e);
  chatLine(x, det, B, A, r);
  const sm = x.toolUses(x.inSpan(x.entries(B), s), 'SendMessage').filter(c => String((c.input || {}).to || '') === `${A}.${code}`);
  det(`${B}'s Claude calls SendMessage to ${A}.${code}`, sm.length >= 1, sm.length ? `SendMessage {to: "${sm[0]?.input?.to}", message: "${clip(sm[0]?.input?.message || sm[0]?.input?.content, 80)}"}` : `no SendMessage to ${A}`);
  const pe = x.peerIn(x.inSpan(x.entries(A), s), B);
  det(`${A}'s Claude receives it as a peer message from ${B} (origin.kind peer)`, pe.length >= 1, pe.length ? `origin {kind: peer, name: ${pe[0]?.origin?.name}, verifiedPeerPid: ${pe[0]?.origin?.verifiedPeerPid}}: "${clip(pe[0]?.origin?.body, 80)}"` : `no peer entry from ${B}`);
  // a reply goes to bob.CODE, or to the peer socket the incoming message came from ("uds:…", Claude Code's reply address)
  const back = x.toolUses(x.inSpan(x.entries(A), s), 'SendMessage').filter(c => { const to = String((c.input || {}).to || ''); return to === `${B}.${code}` || /^uds:/.test(to); });
  const pb = x.peerIn(x.inSpan(x.entries(B), s), A);
  det(`${A}'s Claude answers natively (SendMessage back; ${B} receives it)`, back.length >= 1 && pb.length >= 1, `${A} SendMessage back (${B}.${code} or the uds: reply address): ${back.length}${back[0] ? ` (to ${back[0].input?.to})` : ''}; peer entries from ${A} in ${B}'s transcript: ${pb.length}${pb[0] ? ` ("${clip(pb[0].origin?.body, 70)}")` : ''}`);
  const cards = [A, B].flatMap(seat => x.toolUses(x.inSpan(x.entries(seat), s), 'AskUserQuestion'));
  det('No card and no proposal', cards.length === 0 && !x.logIn(s).some(y => y.kind === 'proposal'), `${cards.length} AskUserQuestion calls; proposals in S3: ${x.logIn(s).filter(y => y.kind === 'proposal').length}`);
  // zero is the contract (the room's Claude wakes only when addressed), not a budget: deterministic
  const n = x.roomClaudeTurns(s);
  det('The room\'s Claude was not woken', n === 0, `${n} claude assistant messages in S3 (${s ? s.from.slice(11, 19) + '–' + s.to.slice(11, 19) : 'no window'})`);
}

/** `from`'s @room line `e` as `to` gets it: once as a chat line (room-chat on: drawn in to's room row; off: a chat row in
 * to's main), one copy for to's Claude, no wake and no model turn of to's for it. */
function chatLine(x: Ctx, det: Det, from: string, to: string, e: LogEntry | undefined): void {
  const s = x.span('S3');
  const want = e ? `${from}: ${e.text}` : '';
  const agents = x.seatAgents(to).filter(a => a.first >= x.runStart);
  const chat = agents.some(a => isChatRow(a, x.code));
  const tes = x.inSpan(x.entries(to), s);
  const mains = x.chatIn(tes).filter(y => e && y.content === `sub-human: ${want}`);
  const rows = chat ? drawnIn(agents, x.code).filter(l => e && l.text.trim() === want && l.at >= e.at) : [];
  const c = e ? x.copiesOf(to, want, e.at) : { pulls: 0, held: 0, prompted: false };
  const copies = c.pulls + c.held;
  const lineOk = chat ? rows.length === 1 && mains.length === 0 : mains.length === 1;
  det(`${to} gets ${from}'s exact words once: ${chat ? `drawn in ${to}'s room row` : `a chat row for ${to}`} "${from}: <the words>", one copy for ${to}'s Claude`,
    !!e && lineOk && (copies === 1 || (copies === 0 && !c.prompted)),
    `${chat ? `${rows.length} line(s) drawn in ${to}'s row, ${mains.length} chat row(s) in main` : `${mains.length} chat row(s)`} carrying "${clip(want, 70)}" verbatim; copies for ${to}'s Claude: ${c.pulls} isMeta, ${c.held} held${copies === 0 && !c.prompted ? ` (none yet: ${to} has had no prompt since, so a held copy has not ridden)` : ''}`);
  const woke = x.wakeIn(tes).filter(y => e && x.textOf(y.message?.content).includes(String(e.text)));
  const ct = !chat && mains[0] ? x.chatTurn(to, mains[0]) : null;
  det(`${from}'s words cost ${to}'s Claude no model turn (no wake, nothing to repeat)`, !!e && woke.length === 0 && (chat || (!!ct && !ct.woke)),
    `${woke.length} wake(s) carrying #${e ? e.id : '?'}${ct ? `; ${ct.evidence}` : chat ? '; drawn by the module in the row (no model)' : ''}`);
}
