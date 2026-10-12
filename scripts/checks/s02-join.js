'use strict';
// S2: B joins (bob; --film: jess, from another machine over ssh: remoteJoin)
const fs = require('node:fs');
const path = require('node:path');
const paths = require('../lib/paths.js');
const { panelRows, joinNotices } = require('../lib/panes.js');
const { readJson, readText, jsonl, esc } = require('../lib/io.js');

module.exports = {
  scene: 'S2',
  run(x, { det, beh }, T) {
    const { code, A, B } = x;
    const j = x.byKind('member_joined', { from: B })[0];
    det(`member_joined ${B} (via system)`, j && j.via === 'system', x.fmt(j));
    // since 0.5.0-beta.7 a join that works shows one dim notice from the hooks module (command.run), no hook frame
    const jn = joinNotices(x.cap('S2', B, 'last'));
    const want = new RegExp(`^⏺ sub-human: joined ${code} as ${B}, with ${A} · @room to talk, @claude to ask the room's Claude`);
    det(`${B}'s join shows one line, "sub-human: joined CODE as ${B}, with ${A} · …", and no "blocked by hook" frame`, jn.notices.length === 1 && want.test(jn.notices[0]) && !jn.frame,
      `${jn.notices.length} join line(s)${jn.notices.length ? `: ${jn.notices.map(l => `"${l}"`).join('; ')}` : ''}; hook frame ${jn.frame ? `"${jn.frame}"` : 'none'} in ${x.capName('S2', B, 'last')}`);
    const ha = x.st('S2', 'last', `holds-${A}.json`, {}), hb = x.st('S2', 'last', `holds-${B}.json`, {}), ho = x.st('S2', 'last', 'holds-claude.json', {});
    det(`Rows: ${B} nested in ${A}'s room row, ${A} in ${B}'s, both in the room's Claude's`, ha.room && (ha.members || []).includes(B) && hb.room && (hb.members || []).includes(A) && [A, B].every(n => (ho.members || []).includes(n)),
      `holds-${A} ${JSON.stringify({ room: ha.room, members: ha.members })}; holds-${B} ${JSON.stringify({ room: hb.room, members: hb.members })}; holds-claude ${JSON.stringify(ho.members)}`);
    const br = panelRows(x.cap('S2', B, 'last'));
    const top = br.filter(r => !r.nested);
    det(`${B}'s panel: only the ${code} row at the top level (no stray participant row)`, top.length === 1 && top[0].label === code, br.map(r => r.line).join(' | ') || 'no rows');
    const orr = panelRows(x.cap('S2', 'claude', 'last'));
    det(`The room's Claude's panel lists ${A} and ${B}`, [A, B].every(n => orr.some(r => r.label === n)), orr.map(r => r.line).join(' | ') || 'none');
    const n = x.roomClaudeTurns(x.span('S2'));
    beh(`The room's Claude spent at most ${T.roomClaudeJoinCalls} model calls on the join (its row spawn)`, n, T.roomClaudeJoinCalls, `${n} claude assistant messages in S2`);
    // the join as a group-chat line in A's pane: the hooks module's $.ui.log row "sub-human: B joined"
    const jt = readText(x.stateFile('S2', `notice-${A}.txt`)) || '';
    const jl = new RegExp(`^\\s*(⏺ )?(sub-human: )?${esc(B)} joined\\s*$`, 'm').exec(jt);
    const via = j && x.shownVia(A, j.id);
    det(`${A} sees the chat line "${B} joined" (a lasting line, no room code, no ids)`, jl && via === 'mod',
      `${jl ? `"${jl[0].trim()}" in ${A}'s pane (state/S2/notice-${A}.txt)` : `not seen in ${A}'s pane`}; rows/notices-${A}.json: #${j ? j.id : '?'} shown via ${via || 'nothing'}`);
    const arow = panelRows(x.cap('S2', A, 'last')).find(r => r.label === code);
    det(`${A}'s room row reads "+${B} joined"`, !!(arow && arow.text.includes(`+${B} joined`)), arow ? arow.line : `no ${code} row in ${x.capName('S2', A, 'last')}`);
    // a join is group chat: the person sees the row, the model gets a copy, nothing wakes it
    const inS2 = es => (j ? es.filter(e => e.timestamp > j.at && e.timestamp <= (x.span('S2') || {}).to) : []);
    const notes = inS2(x.chatIn(x.entries(A))).filter(e => e.content === `sub-human: ${B} joined`);
    const pulls = inS2(x.pullIn(x.entries(A))).filter(e => new RegExp(`^${esc(B)} joined$`, 'm').test(x.textOf(e.message && e.message.content)));
    const woke = inS2(x.wakeIn(x.entries(A))).filter(e => x.textOf(e.message && e.message.content).includes(`${B} joined`));
    const ct = notes[0] ? x.chatTurn(A, notes[0]) : null;
    det(`The join reached ${A} as one chat row and one copy for ${A}'s Claude, with no model turn`, notes.length === 1 && pulls.length === 1 && woke.length === 0 && ct && !ct.woke,
      `${notes.length} chat row(s) "sub-human: ${B} joined"; ${pulls.length} isMeta copy(ies); ${woke.length} wake(s) carrying it; ${ct ? ct.evidence : 'no chat row'}`);
    if (x.remote && x.remote[B]) remoteJoin(x, det, j);
  },
};

/**
 * --film: B joined from another machine (her own sub-human home, x.remote[B]) over ssh to the private sshd
 * (scripts/devbox.sh, in DEVBOX next to her machine's dir): the link, the card, her seat over the link, the PIN.
 */
function remoteJoin(x, det, j) {
  const { code, A, B, log } = x;
  const rh = x.remote[B];
  const devbox = path.join(path.dirname(path.dirname(rh)), 'devbox');
  const lf = readJson(path.join(rh, 'links', `${code}.json`), null);
  const t = (lf && lf.transport) || {};
  const pinned = readText(t.knownHosts || '') || '';
  const hostKey = (readText(path.join(devbox, 'ssh_host_ed25519_key.pub')) || '').trim().split(/\s+/).slice(0, 2).join(' ');
  det(`${B}'s machine is linked over ssh: her links registry holds an ssh link to devbox, let in (a token, no PIN), pinned to devbox's sshd host key`,
    t.kind === 'ssh' && t.host === 'devbox' && lf && typeof lf.token === 'string' && !lf.enroll && !!hostKey && pinned.trim() === `${t.alias} ${hostKey}`,
    lf ? `transport ${t.kind} to ${t.host}${t.port ? `:${t.port}` : ''}; token ${typeof lf.token === 'string' ? 'yes' : 'no'}; PIN ${lf.enroll ? 'still in the file' : 'dropped'}; known_hosts ${pinned.trim() === `${t.alias} ${hostKey}` ? 'pins devbox\'s host key' : hostKey ? 'does NOT pin devbox\'s host key' : `(no ${devbox}/ssh_host_ed25519_key.pub)`}`
      : `no ${path.join(rh, 'links', `${code}.json`)}`);

  // the card: only the host person's own answer on it lets a machine in (hooks/consent.ts postAdmit), signed with A's seat key
  const envelope = paths.pluginLib('room/envelope.ts');
  const recs = Object.values(readJson(path.join(x.roomDir, 'remote', 'invites.json'), {}) || {}).filter(r => r && r.admission && r.name === B);
  const rec = recs.at(-1);
  const key = envelope.pinnedKeys(log).get(A);
  const signed = !!(rec && rec.admit_sig && key && envelope.verify(rec.admit_sig, key) && rec.admit_sig.from === A && rec.admit_sig.kind === 'admit');
  const line = log.find(e => e.kind === 'status' && e.from === 'room' && typeof e.text === 'string' && e.text.startsWith(`${A} let ${B} (`));
  det(`${A}'s card let ${B}'s machine in: the admission (ssh) is "let-in" by ${A}, signed with ${A}'s seat key (the card's answer, via=human), and the room says so`,
    rec && rec.kind === 'ssh' && rec.admit === 'let-in' && rec.admitted_by === A && signed && !!line,
    rec ? `admission ${rec.kind} ${rec.admit} by ${rec.admitted_by}, label ${rec.label}; signature ${signed ? `verified against ${A}'s pinned key` : 'missing or not verified'}; ${x.fmt(line)}` : `no admission record for ${B} in remote/invites.json`);

  const host = (readJson(x.stateFile('S2', 'machine-host.json'), {}) || {}).id;
  const hers = (readJson(path.join(rh, 'machine.json'), {}) || {}).id;
  const linked = log.find(e => e.kind === 'status' && e.from === 'room' && typeof e.text === 'string' && e.text.startsWith(`${B}'s machine (`) && /joined the room/.test(e.text));
  det(`${B}'s seat arrived over the link: member_joined ${B} carries her machine's id (not the host's), after her machine's link joined the room`,
    j && hers && j.machine === hers && j.machine !== host && linked && linked.id < j.id,
    `${x.fmt(j)}; machine ${j ? j.machine : '?'} (hers ${hers || 'unknown'}, host ${host || 'not saved'}); ${x.fmt(linked)}`);

  // the PIN: the hook shows it to A and takes it from B; no Claude ever gets it. A's transcript keeps the invite's
  // lines as display rows (type system, the dim "sub-human: …" lines A saw; Claude Code never sends those to the
  // model); any other entry holding "ROOM PIN" (a prompt, a meta copy, an answer, a tool call) is a leak
  const shown = (readText(x.stateFile('S2', 'join-line.txt')) || '').trim();
  const pin = (/ (\d{4})$/.exec(shown) || [])[1];
  const needle = `${code} ${pin}`;
  const files = [...new Set([A, B].flatMap(s => jsonlUnder(paths.seatProjectDir(s))).concat(x.seatFiles('claude')))];
  let display = 0;
  const leaked = [];
  for (const f of pin ? files : []) {
    if (!(readText(f) || '').includes(needle)) continue;
    for (const e of jsonl(f)) {
      if (!JSON.stringify(e).includes(needle)) continue;
      if (e.type === 'system') display++; else leaked.push(`${path.basename(f)} ${e.type}${e.isMeta ? ' (meta)' : ''}`);
    }
  }
  det('The PIN reached no Claude: no model-bound entry in any transcript (either seat, their subagents, the room\'s Claude) holds the invite\'s "ROOM PIN"', !!pin && leaked.length === 0,
    pin ? `${files.length} transcript file(s) read; ${leaked.length ? `in ${leaked.slice(0, 4).join(', ')}` : 'in none'}; ${display} display-only row(s) (the invite ${A} saw)` : 'state/S2/join-line.txt not saved');
}

/** Every .jsonl under dir (a seat's transcripts and its subagents'). */
function jsonlUnder(dir) {
  try { return fs.readdirSync(dir, { recursive: true }).map(String).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)); } catch { return []; }
}
