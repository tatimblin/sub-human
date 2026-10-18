// S2: B joins (bob; --film: jess, from another machine over ssh: remoteJoin)
import fs from 'node:fs';
import path from 'node:path';
import * as paths from '../lib/paths.ts';
import { panelRows, joinNotices } from '../lib/panes.ts';
import { readJson, readText, jsonl, esc } from '../lib/io.ts';
import type { Ctx, Det, Beh } from './context.ts';
import type { LogEntry } from './log.ts';
import type { TEntry } from '../metrics.ts';
import type { Envelope } from '../../plugin/sub-human/lib/room/types.ts';
import type { Thresholds } from '../metrics.ts';

export const scene = 'S2';

export function run(x: Ctx, { det, beh }: { det: Det, beh: Beh }, T: Thresholds): void {
  const { code, A, B } = x;
  const j = x.byKind('member_joined', { from: B })[0];
  det(`member_joined ${B} (via system)`, j && j.via === 'system', x.fmt(j));
  // since 0.5.0-beta.7 a join that works shows one dim notice from the hooks module (command.run), no hook frame
  const jn = joinNotices(x.cap('S2', B, 'last'));
  const want = new RegExp(`^⏺ sub-human: joined ${code} as ${B}, with ${A} · @room to talk; your Claude can message other Claudes, edit the room plan and the task list`);
  det(`${B}'s join shows one line, "sub-human: joined CODE as ${B}, with ${A} · …", and no "blocked by hook" frame`, jn.notices.length === 1 && want.test(jn.notices[0] ?? '') && !jn.frame,
    `${jn.notices.length} join line(s)${jn.notices.length ? `: ${jn.notices.map(l => `"${l}"`).join('; ')}` : ''}; hook frame ${jn.frame ? `"${jn.frame}"` : 'none'} in ${x.capName('S2', B, 'last')}`);
  const ha = x.holdsAt('S2', 'last', A), hb = x.holdsAt('S2', 'last', B), ho = x.holdsAt('S2', 'last', 'claude');
  det(`Rows: ${B} nested in ${A}'s room row, ${A} in ${B}'s, both in the room's Claude's`, ha.room && (ha.members || []).includes(B) && hb.room && (hb.members || []).includes(A) && [A, B].every(n => (ho.members || []).includes(n)),
    `holds-${A} ${JSON.stringify({ room: ha.room, members: ha.members })}; holds-${B} ${JSON.stringify({ room: hb.room, members: hb.members })}; holds-claude ${JSON.stringify(ho.members)}`);
  const br = panelRows(x.cap('S2', B, 'last'));
  const top = br.filter(r => !r.nested);
  det(`${B}'s panel: only the ${code} row at the top level (no stray participant row)`, top.length === 1 && top[0]?.label === code, br.map(r => r.line).join(' | ') || 'no rows');
  const orr = panelRows(x.cap('S2', 'claude', 'last'));
  det(`The room's Claude's panel lists ${A} and ${B}`, [A, B].every(n => orr.some(r => r.label === n)), orr.map(r => r.line).join(' | ') || 'none');
  const n = x.roomClaudeTurns(x.span('S2'));
  beh(`The room's Claude spent at most ${T.roomClaudeJoinCalls} model calls on the join (its row spawn)`, n, T.roomClaudeJoinCalls, `${n} claude assistant messages in S2`);
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
  const pulls = inS2(x.pullIn(x.entries(A))).filter(e => new RegExp(`^${esc(B)} joined$`, 'm').test(x.textOf(e.message && e.message.content)));
  const woke = inS2(x.wakeIn(x.entries(A))).filter(e => x.textOf(e.message && e.message.content).includes(`${B} joined`));
  const ct = notes[0] ? x.chatTurn(A, notes[0]) : null;
  det(`The join reached ${A} as one chat row and one copy for ${A}'s Claude, with no model turn`, notes.length === 1 && pulls.length === 1 && woke.length === 0 && ct && !ct.woke,
    `${notes.length} chat row(s) "sub-human: ${B} joined"; ${pulls.length} isMeta copy(ies); ${woke.length} wake(s) carrying it; ${ct ? ct.evidence : 'no chat row'}`);
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
  // signature), and the room says who joined, from which machine, its check and the kick that undoes a stranger
  const recs = Object.values(readJson<Record<string, Admission | null> | null>(path.join(x.roomDir, 'remote', 'invites.json'), {}) || {}).filter((r): r is Admission => !!(r && r.admission && r.name === B));
  const rec = recs.at(-1);
  const linked = log.find(e => e.kind === 'status' && e.from === 'room' && typeof e.text === 'string' && e.text.startsWith(`${B} joined from `));
  const lineOk = !!linked && /\(check [0-9a-f]{4}-[0-9a-f]{4}/.test(String(linked.text)) && String(linked.text).includes(`not them? /sub-human kick ${B}`);
  const carded = log.find(e => e.kind === 'status' && e.from === 'room' && typeof e.text === 'string' && e.text.startsWith(`${A} let ${B} (`));
  det(`The right PIN let ${B}'s machine in with no card: the admission (ssh) is "let-in" by the PIN, signed by no one, and the room line "${B} joined from … (check …) · not them? /sub-human kick ${B}"`,
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
