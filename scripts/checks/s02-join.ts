// S2: B joins (bob; --film: jess, from another machine over ssh: remoteJoin)
import fs from 'node:fs';
import path from 'node:path';
import * as paths from '../lib/paths.ts';
import { panelRows, joinNotices, hereNames } from '../lib/panes.ts';
import { isRoomRow } from './transcripts.ts';
import { readJson, readText, jsonl, esc } from '../lib/io.ts';
import type { Ctx, Det } from './context.ts';
import type { LogEntry } from './log.ts';
import type { TEntry } from '../metrics.ts';
import type { Envelope } from '../../plugin/sub-human/lib/room/types.ts';

export const scene = 'S2';

export function run(x: Ctx, { det }: { det: Det }): void {
  const { code, A, B } = x;
  const j = x.byKind('member_joined', { from: B })[0];
  det(`member_joined ${B} (via system)`, j && j.via === 'system', x.fmt(j));
  // since 0.5.0-beta.7 a join that works shows one dim notice from the hooks module (command.run), no hook frame
  const jn = joinNotices(x.cap('S2', B, 'last'));
  const want = new RegExp(`^⏺ sub-human: Joined ${code} as ${B} with ${A}$`);
  det(`${B}'s join shows one line, "sub-human: Joined CODE as ${B} with ${A}", and no "blocked by hook" frame`, jn.notices.length === 1 && want.test(jn.notices[0] ?? '') && !jn.frame,
    `${jn.notices.length} join line(s)${jn.notices.length ? `: ${jn.notices.map(l => `"${l}"`).join('; ')}` : ''}; hook frame ${jn.frame ? `"${jn.frame}"` : 'none'} in ${x.capName('S2', B, 'last')}`);
  const br = panelRows(x.cap('S2', B, 'last'));
  det(`${B}'s panel: one row, ${code}, and nothing nested in it`, br.length === 1 && br[0]?.label === code && !br[0]?.nested, br.map(r => r.line).join(' | ') || 'no rows');
  const ar = panelRows(x.cap('S2', A, 'last'));
  det(`${A}'s panel: one row, ${code}, and nothing nested in it`, ar.length === 1 && ar[0]?.label === code && !ar[0]?.nested, ar.map(r => r.line).join(' | ') || 'no rows');
  // 0.6.0: the room session spawns no rows and runs no rows turn on a join (it runs only its launch turn, S1)
  const n = x.roomClaudeTurns(x.span('S2'));
  det('The room\'s Claude runs no turn on the join (no rows turn: it runs only its launch)', n === 0, `${n} claude assistant message(s) in S2`);
  // each person's one row names who else is here (lib/rows.ts hereText, on the status line the demo turns on)
  for (const [who, other] of [[A, B], [B, A]] as const) {
    const row = panelRows(x.cap('S2', who, 'last')).find(r => r.label === code);
    const names = row ? hereNames(row.text) : null;
    det(`${who}'s room row names who else is here: ${other}`, !!names && names.includes(other) && !names.includes(who) && !names.includes('claude'),
      row ? `"${row.line}" (${names ? `names ${names.join(', ') || 'only you'}` : 'no "… here"'})` : `no ${code} row in ${x.capName('S2', who, 'last')}`);
  }
  // B's row is the hooks module's too: one sub-human:room agent in B's session holding the room, no participant row
  const s2 = x.span('S2');
  const bs = x.seatAgents(B).filter(s => s.session !== x.roomClaudeSid && !!s2 && s.first > s2.from && s.first <= s2.to);
  det(`${B}'s one room row: a sub-human:room agent holding ${code}, no participant row; ${A}'s session spawned no new row`,
    bs.filter(s => isRoomRow(s, code) && s.holds.some(h => h.room === code)).length === 1 && !bs.some(s => s.agentType === 'sub-human:participant')
      && !x.seatAgents(A).some(s => s.session !== x.roomClaudeSid && !!s2 && s.first > s2.from && s.first <= s2.to && (isRoomRow(s, code) || s.agentType === 'sub-human:participant')),
    bs.map(s => `${s.agentType || '?'} holds ${s.holds.map(h => h.room).join(',') || 'none'}`).join('; ') || `no subagent of ${B} in S2`);
  // the join as a group-chat line in A's pane: the hooks module's $.ui.log row "sub-human: B joined"
  const jt = readText(x.stateFile('S2', `notice-${A}.txt`)) || '';
  const jl = new RegExp(`^\\s*(⏺ )?(sub-human: )?${esc(B)} joined\\s*$`, 'm').exec(jt);
  const via = j && x.shownVia(A, j.id);
  det(`${A} sees the chat line "${B} joined" (a lasting line, no room code, no ids)`, jl && via === 'mod',
    `${jl ? `"${jl[0].trim()}" in ${A}'s pane (state/S2/notice-${A}.txt)` : `not seen in ${A}'s pane`}; ${A}'s session document: #${j ? j.id : '?'} shown via ${via || 'nothing'}`);
  const arow = panelRows(x.cap('S2', A, 'last')).find(r => r.label === code);
  det(`${A}'s room row reads "+${B} joined"`, !!(arow && arow.text.includes(`+${B} joined`)), arow ? arow.line : `no ${code} row in ${x.capName('S2', A, 'last')}`);
  // a join is group chat: the person sees the row, the model gets a copy, nothing wakes it
  const s2end = x.span('S2')?.to;
  const inS2 = (es: TEntry[]): TEntry[] => (j ? es.filter(e => e.timestamp !== undefined && e.timestamp > j.at && s2end !== undefined && e.timestamp <= s2end) : []);
  const notes = inS2(x.chatIn(x.entries(A))).filter(e => e.content === `sub-human: ${B} joined`);
  // the copy for A's Claude is held by the hooks module and rides as context beside A's next prompt (mod/deliver.ts
  // holdPullEvent, mod/prompt.ts: "room since your last turn"), so it lands at A's next turn, after S2 when A is idle;
  // an isMeta row is the fallback when it cannot be held
  const joinedLine = new RegExp(`^${esc(B)} joined$`, 'm');
  const afterJoin = (es: TEntry[]): TEntry[] => (j ? es.filter(e => e.timestamp !== undefined && e.timestamp > j.at) : []);
  const pulls = afterJoin(x.pullIn(x.entries(A))).filter(e => joinedLine.test(x.textOf(e.message && e.message.content)));
  const held = afterJoin(x.entries(A)).filter(e => e.attachment && e.attachment.type === 'hook_additional_context'
    && [e.attachment.content].flat().some(c => typeof c === 'string' && joinedLine.test(c)));
  const woke = inS2(x.wakeIn(x.entries(A))).filter(e => x.textOf(e.message && e.message.content).includes(`${B} joined`));
  const ct = notes[0] ? x.chatTurn(A, notes[0]) : null;
  det(`The join reached ${A} as one chat row and one copy for ${A}'s Claude, with no model turn`, notes.length === 1 && pulls.length + held.length === 1 && woke.length === 0 && ct && !ct.woke,
    `${notes.length} chat row(s) "sub-human: ${B} joined"; ${held.length} held cop${held.length === 1 ? 'y' : 'ies'} (context on ${A}'s next prompt${held[0]?.timestamp ? `, ${held[0].timestamp.slice(11, 19)}` : ''}), ${pulls.length} isMeta; ${woke.length} wake(s) carrying it; ${ct ? ct.evidence : 'no chat row'}`);
  const rh = x.remote && x.remote[B];
  if (rh) remoteJoin(x, det, j, rh);
}

/**
 * --film: B joined from another machine (her own sub-human home, x.remote[B]) over ssh to the private sshd
 * (scripts/devbox.sh, in DEVBOX next to her machine's dir) through her own ssh login: the link, nothing of the
 * plugin's in authorized_keys, the PIN that let her in with no card, her seat taken on its own over the link, the SECRET
 * and the PIN kept from every Claude.
 */
/** A links registry file (<home>/links/CODE.json), the parts checked. */
interface LinkFile {
  transport?: { kind?: string, host?: string, port?: number, login?: boolean, key?: string, knownHosts?: string };
  token?: unknown;
  invite?: unknown;
  pin?: unknown;
  pin_wanted?: unknown;
}
/** An admission record (<room>/remote/invites.json). */
interface Admission { admission?: unknown, name?: string, kind?: string, admit?: string, admitted_by?: string, label?: string, admit_sig?: Partial<Envelope> & { kind?: string } }

/** rh: B's sub-human home on her machine. */
function remoteJoin(x: Ctx, det: Det, j: LogEntry | undefined, rh: string): void {
  const { code, A, B, log } = x;
  const devbox = path.join(path.dirname(path.dirname(rh)), 'devbox');
  const lf = readJson<LinkFile | null>(path.join(rh, 'links', `${code}.json`), null);
  const t: NonNullable<LinkFile['transport']> = (lf && lf.transport) || {};
  const own = t.kind === 'ssh' && t.login === true && !t.key && !t.knownHosts; // her own ssh login: nothing of the plugin's pinned or let in
  det(`${B}'s machine is linked over her own ssh login to devbox: her links registry holds a login link, let in (a token, no SECRET or PIN left), with no key or known_hosts of the plugin's`,
    t.kind === 'ssh' && t.host === 'devbox' && own && lf && typeof lf.token === 'string' && lf.invite === undefined && lf.pin === undefined && !lf.pin_wanted,
    lf ? `transport ${t.kind} to ${t.host}${t.port ? `:${t.port}` : ''} (${t.login === true ? 'her ssh login' : 'not a login link'}${t.key || t.knownHosts ? '; a key or known_hosts of the plugin\'s' : ''}); token ${typeof lf.token === 'string' ? 'yes' : 'no'}; SECRET ${lf.invite === undefined ? 'dropped' : 'still in the file'}; PIN ${lf.pin === undefined ? 'dropped' : 'still in the file'}`
      : `no ${path.join(rh, 'links', `${code}.json`)}`);
  const ak = readText(path.join(devbox, '.ssh', 'authorized_keys')) || '';
  det('Nothing of sub-human\'s in devbox\'s authorized_keys: no door, no forced command (her login key is the only line)',
    !/sub-human/.test(ak), `${ak.split('\n').filter(Boolean).length} line(s); ${/sub-human/.test(ak) ? 'a sub-human line' : 'none of sub-human\'s'}`);

  // the PIN typed on the line let her machine in with no card (lib/remote/invites.ts: admitted_by 'pin', no person's
  // signature), and the room says who joined and from which machine, in one short line (its check and the kick that
  // undoes a stranger are A's /sub-human who)
  const recs = Object.values(readJson<Record<string, Admission | null> | null>(path.join(x.roomDir, 'remote', 'invites.json'), {}) || {}).filter((r): r is Admission => !!(r && r.admission && r.name === B));
  const rec = recs.at(-1);
  const linked = log.find(e => e.kind === 'status' && e.from === 'room' && typeof e.text === 'string' && e.text.startsWith(`${B} joined (`));
  const lineOk = !!linked && new RegExp(`^${esc(B)} joined \\([^()\\n]*\\)$`).test(String(linked.text));
  const carded = log.find(e => e.kind === 'status' && e.from === 'room' && typeof e.text === 'string' && e.text.startsWith(`${A} let ${B} (`));
  det(`The right PIN let ${B}'s machine in with no card: the admission (ssh) is "let-in" by the PIN, signed by no one, and the room line "${B} joined (…)"`,
    rec && rec.kind === 'ssh' && rec.admit === 'let-in' && rec.admitted_by === 'pin' && !rec.admit_sig && lineOk && !carded,
    rec ? `admission ${rec.kind} ${rec.admit} by ${rec.admitted_by}, label ${rec.label}; signature ${rec.admit_sig ? 'set' : 'none'}; ${x.fmt(linked)}${carded ? `; a card's line too: ${x.fmt(carded)}` : ''}` : `no admission record for ${B} in remote/invites.json`);

  // no bare /sub-human: her hooks module took the seat in a turn of its own (mod/deliver.ts takeSeat)
  const take = readText(x.stateFile('S2', `take-${B}.txt`)) || '';
  const took = new RegExp(`You're in room ${esc(code)} as ${esc(B)}`).test(take);
  det(`${B}'s session took its seat on its own: "You're in room ${code} as ${B}" in her pane`, took,
    took ? `in state/S2/take-${B}.txt` : 'not in state/S2/take-B.txt (or not saved)');

  const host = (readJson<{ id?: string } | null>(x.stateFile('S2', 'machine-host.json'), {}) || {}).id;
  // her id in the room: the one the host derived from her home's machine key (machines.json), else her home's own
  const hers = ((readJson<Record<string, string> | null>(path.join(rh, 'machines.json'), {}) || {})[code]) || (readJson<{ id?: string } | null>(path.join(rh, 'machine.json'), {}) || {}).id;
  det(`${B}'s seat arrived over the link: member_joined ${B} carries her machine's id (not the host's), after her machine's link joined the room`,
    j && hers && j.machine === hers && j.machine !== host && linked && linked.id < j.id,
    `${x.fmt(j)}; machine ${j ? j.machine : '?'} (hers ${hers || 'unknown'}, host ${host || 'not saved'}); ${x.fmt(linked)}`);

  // the SECRET and the PIN: the hook shows them to A and takes them from B; no Claude ever gets either. A's transcript
  // keeps the invite's lines as display rows (type system, the dim "sub-human: …" lines A saw; Claude Code never sends
  // those to the model); any other entry holding the SECRET or the PIN (typed after the line, or as "PIN NNNN": a
  // prompt, a meta copy, an answer, a tool call) is a leak
  const shown = (readText(x.stateFile('S2', 'join-line.txt')) || '').trim();
  const secret = (/ ([0-9a-z]{39})(?: |$)/.exec(shown) || [])[1];
  const pin = (readText(x.stateFile('S2', 'join-pin.txt')) || '').trim();
  const needles = secret && /^\d{4}$/.test(pin) ? [secret, `PIN ${pin}`, `join ${pin}`] : [];
  const files = [...new Set([A, B].flatMap(s => jsonlUnder(paths.seatProjectDir(s))).concat(x.seatFiles('claude')))];
  let display = 0;
  const leaked: string[] = [];
  for (const f of needles.length ? files : []) {
    const text = readText(f) || '';
    if (!needles.some(n => text.includes(n))) continue;
    for (const e of jsonl<TEntry>(f)) {
      const j = JSON.stringify(e);
      if (!needles.some(n => j.includes(n))) continue;
      if (e.type === 'system') display++; else leaked.push(`${path.basename(f)} ${e.type}${e.isMeta ? ' (meta)' : ''}`);
    }
  }
  det('The SECRET and the PIN reached no Claude: no model-bound entry in any transcript (either seat, their subagents, the room\'s Claude) holds the line\'s SECRET or its PIN',needles.length > 0 && leaked.length === 0,
    needles.length ? `${files.length} transcript file(s) read; ${leaked.length ? `in ${leaked.slice(0, 4).join(', ')}` : 'in none'}; ${display} display-only row(s) (the invite ${A} saw)` : 'state/S2/join-line.txt or join-pin.txt not saved');
}

/** Every .jsonl under dir (a seat's transcripts and its subagents'). */
function jsonlUnder(dir: string): string[] {
  try { return fs.readdirSync(dir, { recursive: true }).map(String).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)); } catch { return []; }
}
