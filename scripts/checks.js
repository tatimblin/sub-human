#!/usr/bin/env node
'use strict';
/**
 * checks: compute docs/rebuild/checks.json from the evidence a scripts/demo.sh run (slim build) left behind.
 *
 *   node scripts/checks.js [--screens DIR] [--out FILE] [--home DIR] [--room CODE] [--note TEXT]
 *
 * Evidence only, nothing assumed: the room log ($SUB_HUMAN_HOME/rooms/CODE/log.jsonl), members.json, tasks.json,
 * plans/, the per-step state demo.sh saved (screens/state/SCENE/N: members.json, rows/, tasks.json,
 * `claude agents --json`, `sub-human tasks`, the orch's native task files; S6/gate-bob.json, S9/synthetic-prompt.json),
 * the pane captures (screens/index.json + *.txt; the orch's pane is `claude logs <job>`) and the seats' Claude Code
 * transcripts (read-only; the orch's is the file named after its session id). A check whose evidence is missing
 * fails and says so. Output: {scene: [{check, pass, evidence}], _meta: {cost, run, note}, _metrics}.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const metrics = require('./metrics.js');

const REPO = path.resolve(__dirname, '..');
const DEMO = {
  alice3: "bob, can you take the parser tests? handler's in src/server.js",
  bob4: "@orch let's plan cursor paging for GET /tasks: ?limit&after, opaque cursor, newest first",
  note5: 'add a test for a cursor past the end — `after=zzz` must 400, not 500',
  viewer9: "hi orch, what's next?",
};
const TARGET = { wakes: 12 };

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[++i];
  return o;
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const jsonl = f => (readText(f) || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const clip = (s, n = 160) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && (x.text || (typeof x.content === 'string' ? x.content : ''))) || '').join('\n') : '');

/** Panel rows of a capture: the lines below the prompt box that start with ⏺/◯/● (agent panel). */
function panelRows(txt) {
  if (!txt) return [];
  const lines = txt.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*(❯\s*)?[⏺●◯]\s+main\b/.test(lines[i])) start = i;
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(\s*)(❯\s*)?(└\s*)?(◯|●|⏺)\s+(\S+)\s*(.*)$/.exec(lines[i]);
    if (m) out.push({ indent: m[1].length, selected: !!m[2], nested: !!m[3], label: m[5], text: m[6].trim(), line: lines[i].trim() });
  }
  return out;
}
/** Status line under the prompt (the ⬡ line between the prompt box and the panel). */
function statusLine(txt) {
  const l = (txt || '').split('\n').filter(x => /^\s*⬡\s/.test(x)).at(-1);
  return l ? l.trim() : '';
}

function main() {
  const o = args();
  const screens = path.resolve(o.screens || path.join(REPO, 'docs/rebuild/screens'));
  const out = path.resolve(o.out || path.join(REPO, 'docs/rebuild/checks.json'));
  const home = path.resolve(o.home || process.env.SUB_HUMAN_HOME || '/tmp/sh-demo/home');
  const index = readJson(path.join(screens, 'index.json'), []);
  const code = o.room || (index.find(r => r.room) || {}).room || (fs.readdirSync(path.join(home, 'rooms')).sort().at(-1));
  const roomDir = path.join(home, 'rooms', code);
  const log = jsonl(path.join(roomDir, 'log.jsonl'));
  const members = readJson(path.join(roomDir, 'members.json'), {});
  const orchSid = members.orch && members.orch.session_id;
  const job = members.orch && members.orch.job;
  const projects = path.join(os.homedir(), '.claude', 'projects');

  // ---- captures and per-step state
  const caps = (scene, seat) => index.filter(r => r.scene === scene && r.session === `sh-${seat}`);
  const cap = (scene, seat, step = 1) => { const rs = caps(scene, seat); const r = step === 'last' ? rs.at(-1) : rs.find(x => x.step === step); return r ? readText(path.join(screens, r.txt)) : null; };
  const capName = (scene, seat, step = 1) => { const rs = caps(scene, seat); const r = step === 'last' ? rs.at(-1) : rs.find(x => x.step === step); return r ? r.txt : `(no ${scene} step ${step} capture of sh-${seat})`; };
  const win = scene => { const rs = index.filter(r => r.scene === scene); return rs.length ? { from: rs.map(r => r.time).sort()[0], to: rs.map(r => r.time).sort().at(-1) } : null; };
  // a scene's window runs from the previous scene's last capture to its own last capture
  const sceneOrder = [...new Set(index.map(r => r.scene))];
  const span = scene => {
    const w = win(scene); if (!w) return null;
    const i = sceneOrder.indexOf(scene);
    const prev = i > 0 ? win(sceneOrder[i - 1]) : null;
    return { from: prev ? prev.to : new Date(Date.parse(w.from) - 180_000).toISOString(), to: w.to };
  };
  const stateDir = (scene, step) => {
    const d = path.join(screens, 'state', scene);
    let steps = [];
    try { steps = fs.readdirSync(d).filter(x => /^\d+$/.test(x)).map(Number).sort((a, b) => a - b); } catch { /* none */ }
    const s = step === 'last' ? steps.at(-1) : step;
    return s ? path.join(d, String(s)) : null;
  };
  const st = (scene, step, file, d) => { const dir = stateDir(scene, step); return dir ? readJson(path.join(dir, file), d) : d; };
  const stText = (scene, step, file) => { const dir = stateDir(scene, step); return dir ? readText(path.join(dir, file)) : null; };
  const nativeTasks = (scene, step) => { const dir = stateDir(scene, step); const d = dir && path.join(dir, 'native-tasks'); try { return fs.readdirSync(d).map(f => readJson(path.join(d, f), null)).filter(Boolean); } catch { return []; } };

  // ---- transcripts
  const seatFiles = seat => {
    if (seat === 'orch') { const f = []; try { for (const d of fs.readdirSync(projects)) { const p = path.join(projects, d, `${orchSid}.jsonl`); if (orchSid && fs.existsSync(p)) f.push(p); } } catch { /* none */ } return f; }
    const dir = path.join(projects, `-private-tmp-sh-demo-${seat}`);
    try { return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && f !== `${orchSid}.jsonl`).map(f => path.join(dir, f)); } catch { return []; }
  };
  const tcache = {};
  const entries = seat => (tcache[seat] = tcache[seat] || seatFiles(seat).flatMap(f => jsonl(f).map(e => ({ ...e, _file: path.basename(f) }))).filter(e => e.agentSetting !== 'sub-human:orchestrator' || seat === 'orch'));
  const inSpan = (es, s) => (s ? es.filter(e => e.timestamp && e.timestamp > s.from && e.timestamp <= s.to) : []);
  const toolUses = (es, name) => es.filter(e => e.type === 'assistant' && !e.isSidechain).flatMap(e => (e.message.content || []).filter(c => c && c.type === 'tool_use' && (!name || c.name === name || new RegExp(name).test(c.name))).map(c => ({ ...c, at: e.timestamp })));
  const assistantIds = es => new Set(es.filter(e => e.type === 'assistant' && !e.isSidechain).map(e => e.message.id || e.uuid));
  const peerIn = (es, from) => es.filter(e => e.type === 'user' && e.origin && e.origin.kind === 'peer' && (!from || String(e.origin.name || '').startsWith(from + '.')));
  const monitorIn = es => es.filter(e => metrics.trigger(e) === 'monitor');

  const C = {};
  const add = (scene, check, pass, evidence) => { (C[scene] = C[scene] || []).push({ check, pass: !!pass, evidence: clip(evidence, 420) }); };
  const byKind = (k, f = {}) => log.filter(e => e.kind === k && Object.entries(f).every(([a, b]) => e[a] === b));
  const fmt = e => (e ? `#${e.id} ${e.from} ${e.via} ${e.kind}${e.hash ? ' ' + e.hash.slice(0, 6) : ''}${e.proposal_hash ? ' ' + e.proposal_hash.slice(0, 6) : ''}: ${clip(e.text, 90)}` : 'none');
  const logIn = s => (s ? log.filter(e => e.at > s.from && e.at <= s.to) : []);
  const orchTurns = s => assistantIds(inSpan(entries('orch'), s)).size;

  // ---- S1: alice joins, no room open
  {
    const s = span('S1');
    const ms = st('S1', 1, 'members.json', members);
    add('S1', 'Room created: log, members.json with alice (member) and the orch (job id)', fs.existsSync(path.join(roomDir, 'log.jsonl')) && ms.alice && ms.alice.role === 'member' && ms.orch && ms.orch.job,
      `${roomDir}: alice ${ms.alice ? ms.alice.role : 'missing'}, orch job ${ms.orch ? ms.orch.job : 'missing'}`);
    const ag = st('S1', 1, 'agents.json', []);
    const a = ag.find(x => x.id === job || x.sessionId === orchSid);
    add('S1', `The orch is a background job titled orch.${code} (claude agents --json), not a tmux seat`, a && a.kind === 'background' && a.name === `orch.${code}`,
      a ? `id ${a.id} kind ${a.kind} name ${a.name} state ${a.state} cwd ${a.cwd}` : `no agent with id ${job} in state/S1/1/agents.json`);
    const oc = cap('S1', 'orch') || '';
    add('S1', 'The orch bound itself as orch of the room (agent sub-human:orchestrator, pid, session id)', ms.orch && ms.orch.role === 'orch' && ms.orch.pid && ms.orch.session_id && /@sub-human:orchestrator/.test(oc),
      `members.json orch role=${ms.orch && ms.orch.role} pid=${ms.orch && ms.orch.pid}; "${(/UserPromptExpansion says: [^\n]*/.exec(oc) || ['no join line'])[0]}" in ${capName('S1', 'orch')} (claude logs ${job})`);
    const rcpt = /sub-human: opened room ([a-z]+-\d{4}) as alice · others: \/sub-human NAME/.exec(cap('S1', 'alice') || '');
    add('S1', 'alice\'s join line: "opened room CODE as alice · others: /sub-human NAME"', rcpt && rcpt[1] === code, rcpt ? rcpt[0] : `not in ${capName('S1', 'alice')}`);
    const ar = panelRows(cap('S1', 'alice'));
    add('S1', `alice's panel: one ${code} row`, ar.filter(r => !r.nested).length === 1 && ar[0].label === code, ar.map(r => r.line).join(' | ') || 'no rows');
    const orr = panelRows(oc);
    const holds = st('S1', 1, 'holds-orch.json', {});
    add('S1', 'The orch\'s panel lists alice', orr.some(r => r.label === 'alice') && (holds.members || []).includes('alice'),
      `orch rows: ${orr.map(r => r.line).join(' | ') || 'none'}; rows/holds-orch.json members ${JSON.stringify(holds.members || [])}`);
    const t1 = nativeTasks('S1', 1).find(t => t.id === '1');
    add('S1', `Room task #1 "room ${code} open" on the orch's native list (in_progress, owner room)`, t1 && t1.subject === `room ${code} open` && t1.status === 'in_progress' && t1.owner === 'room',
      t1 ? `~/.claude/tasks/sh-${code}/1.json: "${t1.subject}" ${t1.status} owner ${t1.owner}` : 'no 1.json in the S1 copy of the native list');
    const j = entries('alice').filter(e => e.attachment && e.attachment.type === 'hook_additional_context' && e.attachment.hookEvent === 'UserPromptExpansion').map(e => [].concat(e.attachment.content).join('\n'))[0] || '';
    const fillLen = j.split('\n\nROWS\n')[0].length;
    add('S1', 'Member join block small: text ≤ 900 chars, with ROWS ≤ 1,200', j && fillLen <= 900 && j.length <= 1200, `alice's join additionalContext ${j.length} chars (mechanics text ${fillLen}, ROWS ${j.length - fillLen})`);
    void s;
  }

  // ---- S2: bob joins
  {
    const j = byKind('member_joined', { from: 'bob' })[0];
    add('S2', 'member_joined bob (via system)', j && j.via === 'system', fmt(j));
    const rc = /sub-human: joined ([a-z]+-\d{4}) as bob \(([^)]*)\)/.exec(cap('S2', 'bob') || '');
    add('S2', 'bob\'s join line: "joined CODE as bob (alice, orch here)"', rc && rc[1] === code && /alice/.test(rc[2]) && /orch/.test(rc[2]), rc ? rc[0] : `not in ${capName('S2', 'bob')}`);
    const ha = st('S2', 1, 'holds-alice.json', {}), hb = st('S2', 1, 'holds-bob.json', {}), ho = st('S2', 1, 'holds-orch.json', {});
    add('S2', 'Rows: bob nested in alice\'s room row, alice in bob\'s, both in the orch\'s', ha.room && (ha.members || []).includes('bob') && hb.room && (hb.members || []).includes('alice') && ['alice', 'bob'].every(n => (ho.members || []).includes(n)),
      `holds-alice ${JSON.stringify({ room: ha.room, members: ha.members })}; holds-bob ${JSON.stringify({ room: hb.room, members: hb.members })}; holds-orch ${JSON.stringify(ho.members)}`);
    const br = panelRows(cap('S2', 'bob'));
    const top = br.filter(r => !r.nested);
    add('S2', `bob's panel: only the ${code} row at the top level (no stray participant row)`, top.length === 1 && top[0].label === code, br.map(r => r.line).join(' | ') || 'no rows');
    const orr = panelRows(cap('S2', 'orch'));
    add('S2', 'The orch\'s panel lists alice and bob', ['alice', 'bob'].every(n => orr.some(r => r.label === n)), orr.map(r => r.line).join(' | ') || 'none');
    const n = orchTurns(span('S2'));
    add('S2', 'The orch spent at most 2 model calls on the join (its row spawn)', n <= 2, `${n} orch assistant messages in S2`);
  }

  // ---- S3: pairing, no plan
  {
    const s = span('S3');
    const e = log.find(x => x.kind === 'say' && x.from === 'alice' && x.via === 'human' && x.text === DEMO.alice3);
    const anyA = log.find(x => x.kind === 'say' && x.from === 'alice' && x.via === 'human');
    add('S3', 'alice\'s @room text byte-exact, via=human', !!e, e ? `#${e.id} === typed (${Buffer.byteLength(e.text)} bytes)` : `first alice say: ${fmt(anyA)}`);
    const t = cap('S3', 'alice') || '';
    const rc = e && new RegExp(`Operation stopped by hook: ✓ posted to ${esc(code)} as #${e.id}`).test(t);
    add('S3', 'One receipt line "Operation stopped by hook: ✓ posted to CODE as #N"; no "blocked by hook"', rc && !/blocked by hook/.test(t), rc ? `receipt for #${e.id} in ${capName('S3', 'alice')}` : `no receipt in ${capName('S3', 'alice')}`);
    const turn = noModelTurn('alice', e);
    add('S3', 'alice\'s @room ran no model turn', turn.pass, turn.evidence);
    const mw = monitorIn(inSpan(entries('bob'), s)).filter(x => e && textOf(x.message.content).includes(e.text));
    add('S3', 'bob\'s Claude is woken once with alice\'s exact words', mw.length === 1, `${mw.length} Monitor event(s) in bob's transcript carrying #${e ? e.id : '?'} verbatim`);
    const sm = toolUses(inSpan(entries('bob'), s), 'SendMessage').filter(c => String((c.input || {}).to || '') === `alice.${code}`);
    add('S3', `bob's Claude calls SendMessage to alice.${code}`, sm.length >= 1, sm.length ? `SendMessage {to: "${sm[0].input.to}", message: "${clip(sm[0].input.message || sm[0].input.content, 80)}"}` : 'no SendMessage to alice');
    const pe = peerIn(inSpan(entries('alice'), s), 'bob');
    add('S3', 'alice\'s Claude receives it as a peer message from bob (origin.kind peer)', pe.length >= 1, pe.length ? `origin {kind: peer, name: ${pe[0].origin.name}, verifiedPeerPid: ${pe[0].origin.verifiedPeerPid}}: "${clip(pe[0].origin.body, 80)}"` : 'no peer entry from bob');
    const back = toolUses(inSpan(entries('alice'), s), 'SendMessage').filter(c => String((c.input || {}).to || '') === `bob.${code}`);
    const pb = peerIn(inSpan(entries('bob'), s), 'alice');
    add('S3', 'alice\'s Claude answers natively (SendMessage back; bob receives it)', back.length >= 1 && pb.length >= 1, `alice SendMessage to bob: ${back.length}; peer entries from alice in bob's transcript: ${pb.length}${pb[0] ? ` ("${clip(pb[0].origin.body, 70)}")` : ''}`);
    const cards = ['alice', 'bob'].flatMap(x => toolUses(inSpan(entries(x), s), 'AskUserQuestion'));
    add('S3', 'No card and no proposal', cards.length === 0 && !logIn(s).some(x => x.kind === 'proposal'), `${cards.length} AskUserQuestion calls; proposals in S3: ${logIn(s).filter(x => x.kind === 'proposal').length}`);
    const n = orchTurns(s);
    add('S3', 'The orch was not woken', n === 0, `${n} orch assistant messages in S3 (${s ? s.from.slice(11, 19) + '–' + s.to.slice(11, 19) : 'no window'})`);
  }

  // ---- S4: let's plan
  const props = log.filter(e => e.kind === 'proposal' && e.hash);
  {
    const s = span('S4');
    const ask = log.find(e => e.kind === 'say' && e.from === 'bob' && e.via === 'human' && e.text === DEMO.bob4);
    add('S4', 'bob\'s "@room @orch let\'s plan …" byte-exact, via=human', !!ask, ask ? `#${ask.id}` : 'not logged verbatim');
    const p1 = props[0];
    add('S4', 'The orch proposes: proposal from orch naming alice and bob, plan stored by hash', p1 && p1.from === 'orch' && ['alice', 'bob'].every(n => (p1.approvers || []).includes(n)) && fs.existsSync(path.join(roomDir, 'plans', `${p1.hash}.md`)),
      p1 ? `${fmt(p1)} approvers ${p1.approvers.join(',')}; plans/${p1.hash}.md ${fs.existsSync(path.join(roomDir, 'plans', `${p1.hash}.md`)) ? 'present' : 'missing'}` : 'no proposal');
    const ow = ask && entries('orch').find(e => e.timestamp > ask.at && metrics.trigger(e));
    add('S4', 'The orch is woken by bob\'s @orch line', !!ow, ow ? `${metrics.trigger(ow)} at ${ow.timestamp.slice(11, 19)}` : 'no orch wake after it');
    for (const seat of ['alice', 'bob']) {
      const t = cap('S4', seat, 'last') || '';
      const m = new RegExp(`Agree to proposal (${p1 ? esc(p1.hash) : '[0-9a-f]{12}'})\\?`).exec(t);
      const opts = /1\. Not yet/.test(t) && /2\. Agree/.test(t) && /3\. Object/.test(t);
      add('S4', `${seat}'s native card: "Agree to proposal HASH?" with Not yet / Agree / Object and the plan beside it`, m && opts && /Consent/.test(t), m ? `${m[0]}; options ${opts ? 'Not yet/Agree/Object' : 'missing'} (${capName('S4', seat, 'last')})` : `no card in ${capName('S4', seat, 'last')}`);
    }
  }

  // ---- S5: object with a note, revise, both agree
  {
    const p1 = props[0], p2 = props[1];
    const ob = p1 && log.find(e => e.kind === 'objection' && e.from === 'bob' && e.proposal_hash === p1.hash);
    add('S5', 'bob\'s objection via=human; the note byte-exact', ob && ob.via === 'human' && ob.text === DEMO.note5, ob ? `${fmt(ob)} (${ob.text === DEMO.note5 ? '===' : '!=='} typed)` : 'no objection');
    const sa = p1 && log.find(e => e.kind === 'signoff' && e.from === 'alice' && e.proposal_hash === p1.hash);
    add('S5', 'alice\'s agreement on the first proposal via=human', sa && sa.via === 'human', fmt(sa));
    add('S5', 'The orch revised: a second proposal with a new hash', p2 && p2.from === 'orch' && p2.hash !== p1.hash, p2 ? `${p1.hash.slice(0, 6)} → ${p2.hash.slice(0, 6)} (#${p2.id})` : 'no revision');
    const sig = p2 ? ['alice', 'bob'].map(n => log.find(e => e.kind === 'signoff' && e.via === 'human' && e.from === n && e.proposal_hash === p2.hash)) : [];
    const d = p2 && log.find(e => e.kind === 'decision' && e.proposal_hash === p2.hash);
    add('S5', 'Both agree on the revision; the decision cites both answers', sig.length === 2 && sig.every(Boolean) && d && sig.every(x => (d.refs || []).includes(x.id)) && /^agreed: /.test(d.text),
      d ? `${fmt(d)} refs [${(d.refs || []).join(',')}]` : `signoffs ${sig.map(x => (x ? '#' + x.id : 'missing')).join(', ')}; no decision`);
    const late = p2 ? log.filter(e => (e.kind === 'signoff' || e.kind === 'objection') && e.proposal_hash === p1.hash && e.id > p2.id) : [];
    add('S5', 'No answer recorded on the old hash after the revision', late.length === 0, late.length ? late.map(fmt).join('; ') : `none after #${p2 ? p2.id : '?'}`);
    const human = ['alice', 'bob'].map(n => log.filter(e => e.from === n && (e.kind === 'signoff' || e.kind === 'objection') && e.via !== 'human').length);
    add('S5', 'Every answer came from a card (via=human); no Claude answered', human.every(x => x === 0), `non-human answers: alice ${human[0]}, bob ${human[1]}`);
    { const ch = chainOk(home, code); add('S5', 'Hash chain valid', ch.ok, ch.evidence); }
  }

  // ---- S6: shared tasks
  {
    const s = span('S6');
    const reqA = log.find(e => e.kind === 'task_req' && e.from === 'alice' && (e.op === 'add' || e.op === 'claim') && e.at > (s ? s.from : ''));
    add('S6', 'alice\'s Claude calls task (add/claim): a task_req via=agent', reqA && reqA.via === 'agent', fmt(reqA));
    const l1 = st('S6', 1, 'tasks.json', []);
    const t = l1.find(x => x.owner === 'alice' && x.status === 'in_progress');
    add('S6', 'The orch applies it natively: tasks.json has it, owner alice, in_progress', !!t, t ? `#${t.id} "${t.subject}" ${t.status} ${t.owner} (state/S6/1/tasks.json)` : `tasks.json at S6 step 1: ${JSON.stringify(l1)}`);
    const tc = toolUses(inSpan(entries('orch'), s), '^Task(Create|Update)$');
    add('S6', 'The orch used native TaskCreate/TaskUpdate', tc.some(c => c.name === 'TaskCreate') && tc.some(c => c.name === 'TaskUpdate'), tc.map(c => `${c.name}(${clip(JSON.stringify(c.input), 70)})`).slice(0, 4).join('; ') || 'none');
    const tid = t && t.id;
    const ar = panelRows(cap('S6', 'alice', 1)).find(r => r.label === code);
    add('S6', 'alice\'s room row shows the task summary', !!(ar && /tasks? \d+ open|#\d+ you/.test(ar.text)), ar ? ar.line : 'no room row');
    const cli = stText('S6', 1, 'sub-human-tasks.txt') || '';
    add('S6', '`sub-human tasks` lists it', !!tid && new RegExp(`#${tid}\\b.*in_progress.*alice`).test(cli), clip(cli, 200) || 'no output saved');
    const reqB = log.find(e => e.kind === 'task_req' && e.from === 'bob' && e.op === 'done' && String(e.task_id || e.id_) === String(tid));
    const reqB2 = reqB || log.find(e => e.kind === 'task_req' && e.from === 'bob' && e.op === 'done');
    const l2 = st('S6', 2, 'tasks.json', []);
    const t2 = l2.find(x => String(x.id) === String(tid));
    const gate = readJson(path.join(screens, 'state', 'S6', 'gate-bob.json'), null);
    const liveGate = (() => {
      const es = inSpan(entries('orch'), span('S6')).filter(e => reqB2 && e.timestamp > reqB2.at);
      const hit = es.find(e => /TaskCompleted hook|only alice may complete/.test(JSON.stringify(e.message || e.attachment || '')));
      return hit ? 'the live gate refused the orch\'s TaskUpdate' : 'the orch did not attempt it (no completing TaskUpdate after bob\'s request)';
    })();
    const synthetic = !/live gate/.test(liveGate);
    add('S6', `A non-owner done (bob on alice's task) is refused: the gate says only alice may complete it; the task stays in progress${synthetic ? ' [gate: SYNTHETIC — run by demo-lib over the real log; the orch itself declined before reaching it]' : ' [gate: live]'}`,
      reqB2 && t2 && t2.status === 'in_progress' && gate && gate.status === 2 && /only alice may complete/.test(gate.stderr),
      `${fmt(reqB2)}; after it: #${tid} ${t2 ? t2.status : '?'} (state/S6/2); gate over the real log: exit ${gate ? gate.status : '?'} "${gate ? gate.stderr : ''}"; ${liveGate}`);
    const reqA2 = log.find(e => e.kind === 'task_req' && e.from === 'alice' && e.op === 'done');
    const done = reqA2 && log.find(e => e.kind === 'task' && e.op === 'done' && String(e.task_id) === String(tid) && e.req === reqA2.id);
    const l3 = st('S6', 3, 'tasks.json', []);
    add('S6', 'The owner\'s done with evidence completes it; the task entry cites her request', done && (l3.find(x => String(x.id) === String(tid)) || {}).status === 'completed',
      `${fmt(reqA2)} evidence "${reqA2 ? reqA2.evidence : ''}"; ${fmt(done)}`);
    const wakesS6 = assistantIds(inSpan(entries('orch'), s)).size;
    add('S6', 'The orch\'s task work stayed small (≤ 14 model calls for the four requests)', wakesS6 <= 14, `${wakesS6} orch assistant messages in S6`);
  }

  // ---- S7: stray typing in a row view
  {
    const s = span('S7');
    const t = cap('S7', 'alice') || '';
    const viewing = new RegExp(`─ ${esc(code)} ─`).test(t);
    const hint = /read-only · talk in main \(@room\)/.test(t);
    add('S7', 'alice\'s room row view shows the read-only hint where she typed', viewing && hint && /❯ x\b/.test(t), `${viewing ? `viewing ${code}` : 'not in the row view'}; hint ${hint ? 'shown' : 'missing'}; typed x ${/❯ x\b/.test(t) ? 'shown' : 'missing'} (${capName('S7', 'alice')})`);
    const posted = logIn(s).filter(e => e.from === 'alice');
    add('S7', 'Nothing is posted', posted.length === 0, posted.length ? posted.map(fmt).join('; ') : 'no alice entries in S7');
    // A row is a subagent blocked in its hold call: text typed into its view is queued and reaches the row's
    // model only when that hold returns (a join, rejoin or stop). So the true check is: if the text reached the
    // row, its answer is the one-line read-only reply (and nothing else); if it never did, nothing answered it.
    const since = s ? s.from : '';
    const got = rowUserText('alice', since, /^\s*x\s*$/);
    const reply = rowReply('alice', since);
    add('S7', 'The stray text gets the one-line read-only reply when the row\'s hold next returns, or no answer at all (it never reached the row)',
      got ? !!reply : !reply,
      got ? (reply ? `"x" reached row ${got.file} at ${got.at.slice(11, 19)}; reply ${reply.at.slice(11, 19)} "${clip(reply.text, 80)}"` : `"x" reached row ${got.file} at ${got.at.slice(11, 19)} but no read-only reply`)
        : (reply ? `a read-only reply with no "x" delivered: ${clip(reply.text, 80)}` : 'the "x" never reached alice\'s row model by the end of the run (its hold did not return); no reply, nothing posted'));
  }

  // ---- S8: resilience
  {
    const s = span('S8');
    const a1 = panelRows(cap('S8', 'alice', 1));
    const ms1 = st('S8', 1, 'members.json', {}), ms0 = st('S7', 'last', 'members.json', null) || st('S6', 'last', 'members.json', {});
    const leftA = logIn(s).filter(e => e.kind === 'member_left' && e.from === 'alice');
    add('S8', `/clear in alice: new session id, same seat, still one ${code} row, no member_left`, ms1.alice && ms0.alice && ms1.alice.session_id !== ms0.alice.session_id && a1.filter(r => r.label === code).length === 1 && !leftA.length && new RegExp(`alice\\.${esc(code)}`).test(cap('S8', 'alice', 1) || ''),
      `session ${ms0.alice ? ms0.alice.session_id.slice(0, 8) : '?'} → ${ms1.alice ? ms1.alice.session_id.slice(0, 8) : '?'}; rows ${a1.map(r => r.line).join(' | ')}; member_left ${leftA.length}`);
    const left = logIn(s).find(e => e.kind === 'member_left' && e.from === 'bob');
    const back = left && log.find(e => e.kind === 'member_joined' && e.from === 'bob' && e.id > left.id);
    add('S8', 'bob /exit + --continue: member_left then "rejoined (resumed)"', left && back && /resumed/.test(back.text), `${fmt(left)} → ${fmt(back)}`);
    const b2 = panelRows(cap('S8', 'bob', 2));
    const bcap = caps('S8', 'bob')[1];
    let ev = 'no capture', ok = false;
    if (left && bcap) {
      const es = entries('bob').filter(e => e.timestamp > left.at && e.timestamp <= bcap.time && !e.isSidechain);
      const prompts = es.filter(e => e.type === 'user' && !e.isMeta && !metrics.trigger(e) && !(e.origin && e.origin.kind === 'task-notification') && !(Array.isArray(e.message && e.message.content) && e.message.content.every(c => c && c.type === 'tool_result')));
      const wake = es.find(e => metrics.trigger(e) === 'rewake');
      const call = wake && es.find(e => e.type === 'assistant' && e.timestamp >= wake.timestamp && JSON.stringify(e.message.content).includes('"Agent"'));
      ok = !!wake && !!call && prompts.length === 0 && b2.filter(r => r.label === code).length === 1 && b2.filter(r => !r.nested).length === 1;
      ev = `${wake ? `row-rewake wake ${wake.timestamp.slice(11, 19)}` : 'no row-rewake wake'}; ${call ? `Agent call ${call.timestamp.slice(11, 19)}` : 'no Agent call'}; ${prompts.length} prompt(s) from bob; rows ${b2.map(r => r.line).join(' | ') || 'none'}`;
    }
    add('S8', 'bob\'s room row is back with no prompt (row-rewake), no duplicate rows', ok, ev);
    const say = log.find(e => e.kind === 'say' && e.from === 'alice' && e.via === 'human' && back && e.id > back.id);
    const mw = say && entries('bob').filter(e => e.timestamp > say.at && metrics.trigger(e) === 'monitor' && textOf(e.message.content).includes(say.text));
    add('S8', 'The monitor still wakes bob after the resume', mw && mw.length >= 1, say ? `${fmt(say)} → ${mw.length} Monitor event(s) in bob's transcript with it` : 'no alice @room after the resume');
  }

  // ---- S9: the orch refuses typed input
  {
    const s = span('S9');
    const v = cap('S9', 'viewer') || '';
    add('S9', 'A viewer attached with claude attach and typed: the prompt is refused with the hint', /the orch takes no typed input; use @room or ask your Claude to message orch\./.test(v),
      (/the orch takes no typed input[^\n]*/.exec(v) || [`no refusal in ${capName('S9', 'viewer')}`])[0]);
    const typed = entries('orch').filter(e => e.type === 'user' && textOf(e.message && e.message.content).includes(DEMO.viewer9));
    const n = orchTurns(s);
    add('S9', 'The typed text never reached the orch\'s model; no orch turn', typed.length === 0 && n === 0, `${typed.length} transcript entries with the typed text; ${n} orch assistant messages in S9`);
    const syn = readJson(path.join(screens, 'state', 'S9', 'synthetic-prompt.json'), null);
    const so = syn && (() => { try { return JSON.parse(syn.stdout); } catch { return null; } })();
    add('S9', 'The orch\'s UserPromptSubmit hook blocks a typed prompt (synthetic payload as the orch)', so && so.decision === 'block' && /takes no typed input/.test(so.reason),
      so ? `decision ${so.decision}: "${so.reason}" (session ${syn.input.session_id.slice(0, 8)}, pid ${syn.input.pid})` : 'no synthetic run saved');
  }

  // ---- S10: leave
  {
    const s = span('S10');
    const la = logIn(s).find(e => e.kind === 'member_left' && e.from === 'alice'), lb = logIn(s).find(e => e.kind === 'member_left' && e.from === 'bob');
    add('S10', 'Both leave: member_left alice and bob', la && lb, `${fmt(la)}; ${fmt(lb)}`);
    const cl = log.find(e => e.kind === 'status' && e.to === 'orch' && e.via === 'system' && /room closed/.test(e.text));
    add('S10', 'The reaper marks the room closing and tells the orch "room closed: complete task 1"', cl && members.orch && members.orch.closing, `${fmt(cl)}; members.json orch.closing ${members.orch && members.orch.closing}`);
    const t1 = nativeTasks('S10', 'last').find(t => t.id === '1');
    const t1live = readJson(path.join(os.homedir(), '.claude', 'tasks', `sh-${code}`, '1.json'), null);
    const done1 = (t1 && t1.status === 'completed') || (t1live && t1live.status === 'completed');
    add('S10', 'The orch completes task 1 (the gate allows it while closing)', done1, `task 1: ${t1 ? t1.status : t1live ? t1live.status : 'no file'} (S10 copy) ${t1live ? `/ ${t1live.status} (live)` : ''}`);
    const ag = st('S10', 'last', 'agents.json', null);
    const running = ag && ag.find(x => x.id === job || x.sessionId === orchSid);
    add('S10', 'The orch is stopped: claude agents no longer lists it', members.orch && members.orch.stopped_at && ag && !running,
      `members.json orch.stopped_at ${members.orch && members.orch.stopped_at}; claude agents --json at the last S10 snap ${ag ? (running ? `still lists ${running.id} (${running.state})` : `has no ${job}`) : 'not saved'}`);
    const tj = readJson(path.join(roomDir, 'tasks.json'), null);
    add('S10', '<room>/tasks.json stays', Array.isArray(tj), tj ? `${tj.length} task(s) kept` : 'missing');
  }

  // ---- Metrics vs vole-8126 and Phase 0 (otter-0813)
  const M = metrics.measure({ screens, home, code });
  if (M.error) add('Metrics', 'Run metrics computed', false, M.error);
  else {
    const B = metrics.BASELINE, P = metrics.PHASE0;
    const per = x => `${x} ${M.seats[x].wakes.turns}`;
    add('Metrics', `Room-caused model wakes ≤ ${TARGET.wakes} (vole-8126 ${B.wakes.total}; Phase 0 ${P.wakes.total})`, M.total.wakes <= TARGET.wakes,
      `${M.total.wakes} wakes (${['orch', 'alice', 'bob'].map(per).join(', ')}); Monitor events, peer deliveries and row-rewake that started a turn`);
    add('Metrics', 'Member join text small (report)', M.total.joinChars.every(n => n > 0 && n <= 1200), `alice ${M.seats.alice.injected.join}, bob ${M.seats.bob.injected.join} chars (vole-8126 ${B.joinChars.alice}/${B.joinChars.bob}; Phase 0 ${P.joinChars.alice}/${P.joinChars.bob})`);
    add('Metrics', `UI noise lines per capture ≤ 1.4 (vole-8126 ${B.noise.perCapture}; Phase 0 ${P.noise.perCapture})`, M.total.noise.perCapture <= 1.4,
      `${M.total.noise.lines} lines / ${M.total.noise.captures} captures = ${M.total.noise.perCapture} (excl. "Waiting for": ${M.total.noise.perCaptureExWaiting})`);
    add('Metrics', 'No red or "hook error" lines in any capture', M.total.noise.red === 0 && M.total.noise.hookError === 0, `red lines ${M.total.noise.red}, "hook error" lines ${M.total.noise.hookError}`);
    add('Metrics', 'Model calls per card ≤ 3 on the approver\'s model (report)', M.total.cards.count > 0 && M.total.cards.perCard <= 3,
      `${M.total.cards.count} cards: ${M.total.cards.toCard} call(s) to open, ${M.total.cards.after} after the answer (avg ${M.total.cards.perCard})`);
  }

  const order = ['Metrics', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'];
  const res = {};
  for (const k of order) if (C[k]) res[k] = C[k];
  res._meta = { cost: cost(), run: `room ${code}, ${log.length} log entries, ${index.length} captures, orch job ${job}`, note: o.note || '' };
  if (!M.error) res._metrics = { run: { room: code, ...M }, baseline: metrics.BASELINE, phase0: metrics.PHASE0, target: TARGET };
  fs.writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
  let p = 0, f = 0;
  for (const k of order) for (const c of res[k] || []) { c.pass ? p++ : f++; process.stdout.write(`${c.pass ? 'PASS' : 'FAIL'} ${k} ${c.check}${c.pass ? '' : ' — ' + c.evidence}\n`); }
  process.stdout.write(`checks: ${p} pass / ${f} fail -> ${path.relative(process.cwd(), out)} (${res._meta.cost})\n`);

  // ---------- helpers that need the run's context ----------
  function noModelTurn(seat, e) {
    if (!e) return { pass: false, evidence: 'no entry' };
    for (const f of seatFiles(seat)) {
      const es = jsonl(f);
      const q = es.find(x => x.type === 'queue-operation' && x.operation === 'remove' && x.reason === 'dropped_by_hook' && typeof x.content === 'string' && x.content.endsWith(e.text));
      if (q) return { pass: true, evidence: `${path.basename(f).slice(0, 8)}…: queued prompt removed by the hook (#${e.id}); it never reached the model` };
      const i = es.findIndex(x => x.type === 'system' && typeof x.content === 'string' && x.content.includes(`posted to ${code} as #${e.id}`));
      if (i < 0) continue;
      for (let j = i + 1; j < es.length; j++) {
        const x = es[j];
        if (x.type === 'user' && !x.isMeta) return { pass: true, evidence: `${path.basename(f).slice(0, 8)}…: hook receipt for #${e.id}, no assistant message before the next prompt or notice` };
        if (x.type === 'assistant') return { pass: false, evidence: `assistant message right after the receipt for #${e.id}` };
      }
      return { pass: true, evidence: `${path.basename(f).slice(0, 8)}…: hook receipt for #${e.id} is the last turn activity` };
    }
    return { pass: false, evidence: `no hook receipt for #${e.id} in ${seat}'s transcripts` };
  }
  /** A user message matching re delivered to one of a seat's row subagents after `since`. */
  function rowUserText(seat, since, re) {
    const dir = path.join(projects, `-private-tmp-sh-demo-${seat}`);
    let ds = [];
    try { ds = fs.readdirSync(dir).filter(d => fs.existsSync(path.join(dir, d, 'subagents'))); } catch { return null; }
    for (const d of ds) for (const f of fs.readdirSync(path.join(dir, d, 'subagents')).filter(x => x.endsWith('.jsonl'))) {
      for (const e of jsonl(path.join(dir, d, 'subagents', f))) {
        if (e.type !== 'user' || !e.timestamp || e.timestamp < since) continue;
        const c = e.message && e.message.content;
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join('\n') : '';
        if (re.test(t)) return { at: e.timestamp, file: f };
      }
    }
    return null;
  }
  /** A row subagent's "read-only row" text in a seat's subagent transcripts after `since`. */
  function rowReply(seat, since) {
    const dir = path.join(projects, `-private-tmp-sh-demo-${seat}`);
    let ds = [];
    try { ds = fs.readdirSync(dir).filter(d => fs.existsSync(path.join(dir, d, 'subagents'))); } catch { return null; }
    for (const d of ds) for (const f of fs.readdirSync(path.join(dir, d, 'subagents')).filter(x => x.endsWith('.jsonl'))) {
      for (const e of jsonl(path.join(dir, d, 'subagents', f))) {
        if (e.type !== 'assistant' || !e.timestamp || e.timestamp < since) continue;
        const tx = (e.message.content || []).find(c => c && c.type === 'text' && /read-only row/.test(c.text));
        if (tx) return { at: e.timestamp, text: tx.text, file: f };
      }
    }
    return null;
  }
  function cost() {
    // Approximate: tokens from every transcript (main + subagents) of the seats and the orch, at list prices.
    const price = m => (/haiku/.test(m) ? [1, 5, 1.25, 0.1] : /sonnet/.test(m) ? [3, 15, 3.75, 0.3] : [5, 25, 6.25, 0.5]);
    let usd = 0;
    const since = index.length ? new Date(Date.parse(index.map(r => r.time).sort()[0]) - 180_000).toISOString() : '';
    const until = index.length ? new Date(Date.parse(index.map(r => r.time).sort().at(-1)) + 60_000).toISOString() : ''; // not later runs
    const seen = new Set();
    const byModel = {};
    const walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of es) { const p = path.join(d, x.name); if (x.isDirectory()) walk(p); else if (x.name.endsWith('.jsonl')) { for (const e of jsonl(p)) { const u = e.message && e.message.usage; if (!u || e.type !== 'assistant' || (since && e.timestamp < since) || (until && e.timestamp > until)) continue; const id = e.message.id || e.uuid; if (seen.has(id)) continue; seen.add(id); const m = e.message.model || ''; const [i, o2, cw, cr] = price(m); const c = ((u.input_tokens || 0) * i + (u.output_tokens || 0) * o2 + (u.cache_creation_input_tokens || 0) * cw + (u.cache_read_input_tokens || 0) * cr) / 1e6; usd += c; byModel[m] = (byModel[m] || 0) + c; } } } };
    for (const seat of ['alice', 'bob']) walk(path.join(projects, `-private-tmp-sh-demo-${seat}`)); // the orch's transcript is in alice's folder
    return `≈ $${usd.toFixed(2)} (${Object.entries(byModel).map(([m, c]) => `${m.replace(/^claude-/, '')} $${c.toFixed(2)}`).join(', ')}; list-price estimate from transcript token usage within the run)`;
  }
}

function chainOk(home, code) {
  process.env.SUB_HUMAN_HOME = home;
  const room = require(path.join(REPO, 'plugin/sub-human/lib/room.js'));
  room.bind(code);
  const r = room.validateChain();
  return { ok: !!r.ok, evidence: r.ok ? `validateChain ok over ${r.count} entries` : `chain breaks at #${r.badAt} (${r.count} entries)` };
}

if (require.main === module) main();
module.exports = { panelRows, statusLine };
