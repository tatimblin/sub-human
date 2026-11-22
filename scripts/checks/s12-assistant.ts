// S12 (room-chat on): your Claude is your assistant (0.8.0 Phase 2). alice asks bob in her room row. A fact: bob's main
// Claude is woken (at its turn's end) and answers for him in one line, drawn in alice's row as "bob's Claude: …". An
// opinion: his Claude leaves it for him; it waits in his row ("1 new" on his status line), and bob answers it in his row
// himself, drawn in alice's row as "bob: …". Whether his Claude answered the fact and stayed quiet on the opinion is
// the model's judgement: behavioural. Where the lines land, who is woken, and that no row runs a model step: deterministic.
import { clip, readText } from '../lib/io.ts';
import { roomStatus } from '../lib/panes.ts';
import { drawnIn, isChatRow } from './transcripts.ts';
import type { Ctx, Det, Beh } from './context.ts';
import type { LogEntry } from './log.ts';

export const scene = 'S12';

export function run(x: Ctx, { det, beh }: { det: Det, beh: Beh }): void {
  const { code, DEMO } = x;
  const s = x.span('S12');
  const inS = x.logIn(s);
  const mine = (from: string, via: string, text: string): LogEntry | undefined => inS.find(e => e.kind === 'say' && e.from === from && e.via === via && e.text === text);
  const fact = mine('alice', 'human', DEMO.fact12), opinion = mine('alice', 'human', DEMO.opinion12), answer = mine('bob', 'human', DEMO.answer12);
  det('alice\'s two questions typed into her row and bob\'s answer typed into his are posted with their exact bytes, via=human', !!fact && !!opinion && !!answer,
    `fact ${x.fmt(fact)}; opinion ${x.fmt(opinion)}; bob's answer ${x.fmt(answer)}`);
  const agents = (n: string) => x.seatAgents(n).filter(a => a.first >= x.runStart);
  const rowsOf = (n: string) => agents(n).filter(a => isChatRow(a, code));
  const drawn = (n: string) => drawnIn(agents(n), code).filter(l => !s || l.at >= s.from);
  const has = (n: string, line: string, after?: string) => drawn(n).find(l => l.text.trim() === line && (!after || l.at >= after));
  // an answer bob's Claude addressed to alice (its post's `for`) is drawn "bob's Claude (to you): …" (lib/room/render.ts)
  const hasClaude = (n: string, text: string, after: string) => drawn(n).find(l => l.at >= after && [`bob's Claude: ${text}`, `bob's Claude (to you): ${text}`].includes(l.text.trim()));

  // the wake: each question names bob, so it wakes bob's main Claude (its prompt carries the line) and no one else's
  const wakes = (n: string, text: string) => x.wakeIn(x.inSpan(x.entries(n), s)).filter(e => x.textOf(e.message && e.message.content).includes(text));
  for (const [what, q] of [['fact', DEMO.fact12], ['opinion', DEMO.opinion12]] as const) {
    const b = wakes('bob', q), a = wakes('alice', q);
    det(`The ${what} question wakes bob's Claude, and only his`, b.length === 1 && a.length === 0,
      `${b.length} wake(s) in bob's main${b[0] ? ` (${b[0].timestamp?.slice(11, 19)})` : ''}; ${a.length} in alice's`);
  }

  // bob's Claude's answer to the fact: a say of his via=agent after the fact, drawn in alice's row as "bob's Claude: …"
  const said = fact ? inS.filter(e => e.kind === 'say' && e.from === 'bob' && e.via === 'agent' && e.id > fact.id && (!opinion || e.id < opinion.id)) : [];
  const first = said[0];
  const asClaude = first ? hasClaude('alice', String(first.text).split('\n')[0] ?? '', first.at) : undefined;
  det('bob\'s Claude\'s answer, when it gives one, is drawn in alice\'s row as "bob\'s Claude: …" (its author, no ids)', !first || !!asClaude,
    first ? `${x.fmt(first)} "${clip(first.text, 80)}"; ${asClaude ? `drawn in alice's row ${asClaude.at.slice(11, 19)}` : 'not drawn in alice\'s row'}` : 'no answer from bob\'s Claude (see the behavioural check)');
  beh('bob\'s Claude answers the fact for him in one line (3000, from src/server.js)', first && said.length === 1 && /\b3000\b/.test(String(first.text)) ? 0 : 1, 0,
    said.length ? said.map(e => `"${clip(e.text, 90)}"`).join('; ') : 'bob\'s Claude posted nothing after the fact question');

  // the opinion: left for bob. It waits in his row (drawn there, his status line counting it: state/S12/status-bob),
  // his open row view shows it (state/S12/row-bob), and his own answer reaches alice's row as "bob: …"
  const q = opinion ? has('bob', `alice: ${DEMO.opinion12}`, opinion.at) : undefined;
  const status = roomStatus(readText(x.stateFile('S12', 'status-bob.txt')), code);
  const unread = /(?:^|· )(\d+) new\b/.exec(status ?? '');
  const view = (readText(x.stateFile('S12', 'row-bob.txt')) || '').split('\n').some(l => l.trim() === `alice: ${DEMO.opinion12}`);
  det('The opinion question waits in bob\'s row: drawn there as "alice: …", "1 new" on his status line, shown when he opens the row', !!q && unread?.[1] === '1' && view,
    `${q ? `drawn ${q.at.slice(11, 19)}` : 'not drawn in bob\'s row'}; status line "${status ?? 'none'}" (state/S12/status-bob.txt); ${view ? 'shown' : 'not shown'} in his open row view (state/S12/row-bob.txt)`);
  const quiet = opinion ? inS.filter(e => e.kind === 'say' && e.from === 'bob' && e.via === 'agent' && e.id > opinion.id && (!answer || e.id < answer.id)) : [];
  beh('bob\'s Claude leaves the opinion for bob (posts nothing for it)', opinion ? quiet.length : null, 0,
    quiet.length ? quiet.map(e => `"${clip(e.text, 90)}"`).join('; ') : 'nothing posted by bob\'s Claude between the question and bob\'s own answer');
  const own = answer ? has('alice', `bob: ${DEMO.answer12}`, answer.at) : undefined;
  const aView = (readText(x.stateFile('S12', 'row-alice.txt')) || '').split('\n').map(l => l.trim());
  det('bob\'s own answer is drawn in alice\'s row as "bob: …" (and in her open row view, with the whole exchange)', !!own && aView.includes(`bob: ${DEMO.answer12}`) && aView.includes(`you: ${DEMO.fact12}`) && aView.includes(`you: ${DEMO.opinion12}`),
    `${own ? `drawn ${own.at.slice(11, 19)}` : 'not drawn in alice\'s row'}; alice's open row view (state/S12/row-alice.txt): ${['bob: ', 'you: '].map(p => `${aView.filter(l => l.startsWith(p)).length} "${p}…"`).join(', ')}`);

  // no model step in either row: every line they show is the module's answer
  const wrote = ['alice', 'bob'].flatMap(n => rowsOf(n).filter(r => r.modelText.length).map(r => `${n}: "${clip(r.modelText[0], 80)}" (${r.file})`));
  det('No model step in either room row (all their lines are the module\'s)', rowsOf('alice').length > 0 && rowsOf('bob').length > 0 && wrote.length === 0,
    wrote.length ? wrote.join('; ') : `${rowsOf('alice').length + rowsOf('bob').length} chat row(s): no text of a model's`);
}
