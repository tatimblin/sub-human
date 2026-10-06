#!/usr/bin/env node
'use strict';
/**
 * checks: compute docs/rebuild/checks.json from the evidence a scripts/demo.sh run left behind.
 *
 *   node scripts/checks.js [--screens DIR] [--out FILE] [--home DIR] [--room CODE]
 *
 * Evidence only, nothing assumed: the room log ($SUB_HUMAN_HOME/rooms/CODE/log.jsonl), members.json,
 * the rows/ files, $SUB_HUMAN_HOME/mcp-debug.log (SUB_HUMAN_DEBUG=1), the pane captures
 * (screens/index.json + *.txt) and the seats' Claude Code transcripts (read-only). A check whose
 * evidence is missing fails and says so. Output: {scene: [{check, pass, evidence}], _meta: {cost, run, note}}.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const metrics = require('./metrics.js');

const REPO = path.resolve(__dirname, '..');
const DEMO = {
  alice4: "let's add cursor paging to GET /tasks: ?limit&after, bare array, max 50",
  bob4: "I want to approve this. Keep `after` opaque, not a page number.",
  reason7: 'cap the page at 50 and say what happens past it — `limit=500` must clamp, not 400',
};

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
  const lines = (txt || '').split('\n');
  const l = lines.filter(x => /^\s*⬡\s/.test(x)).at(-1);
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
  const debug = (readText(path.join(home, 'mcp-debug.log')) || '').split('\n');
  const rowsDir = path.join(roomDir, 'rows');
  const rowMaps = {};
  try { for (const f of fs.readdirSync(rowsDir)) if (/^[0-9a-f-]{36}\.json$/.test(f)) rowMaps[f.slice(0, -5)] = (readJson(path.join(rowsDir, f), {}) || {}).byAgent || {}; } catch { /* none */ }

  // captures: cap(scene, seat, step) -> text; step 'last' = the scene's last step
  const cap = (scene, seat, step = 1) => {
    const rs = index.filter(r => r.scene === scene && r.session === `sh-${seat}`);
    const r = step === 'last' ? rs.at(-1) : rs.find(x => x.step === step);
    return r ? readText(path.join(screens, r.txt)) : null;
  };
  const capName = (scene, seat, step = 1) => { const r = index.filter(x => x.scene === scene && x.session === `sh-${seat}`); const x = step === 'last' ? r.at(-1) : r.find(y => y.step === step); return x ? x.txt : `(no ${scene} step ${step} capture of sh-${seat})`; };
  const sceneWindow = scene => { const rs = index.filter(r => r.scene === scene); return rs.length ? { from: Math.min(...rs.map(r => Date.parse(r.time))), to: Date.parse(rs.at(-1).time) } : null; }; // ms

  const C = {};
  const add = (scene, check, pass, evidence) => { (C[scene] = C[scene] || []).push({ check, pass: !!pass, evidence: clip(evidence, 400) }); };
  const byKind = (k, f = {}) => log.filter(e => e.kind === k && Object.entries(f).every(([a, b]) => e[a] === b));
  const fmt = e => (e ? `#${e.id} ${e.from} ${e.via} ${e.kind}${e.plan_hash ? ' ' + e.plan_hash.slice(0, 6) : ''}: ${clip(e.text, 90)}` : 'none');

  // ---- S1
  {
    const t = cap('S1', 'orch');
    add('S1', 'Room dir exists with a log and members.json', fs.existsSync(roomDir) && !!members.orch, `${roomDir}: members ${Object.keys(members).join(', ') || 'none'}`);
    const agent = t && /@sub-human:orchestrator/.test(t);
    add('S1', 'The orch session runs agent_type sub-human:orchestrator, registered as role orch', agent && members.orch && members.orch.role === 'orch',
      `pane header ${agent ? 'shows' : 'lacks'} "@sub-human:orchestrator"; members.json orch.role=${members.orch && members.orch.role}`);
    const banner = t && new RegExp(`room ${esc(code)} open`).test(t);
    const sl = statusLine(t);
    add('S1', `Invite banner and status line ⬡ ${code} · orch`, banner && sl.startsWith(`⬡ ${code} · orch`), `banner ${banner ? 'present' : 'missing'}; status line "${sl}" (${capName('S1', 'orch')})`);
  }

  // ---- S2 / S3
  // rows/ and members.json as demo.sh saved them at the scene's last snap (rows are forgotten when they end)
  const stateAt = scene => {
    const d = path.join(screens, 'state', scene);
    const ms = readJson(path.join(d, 'members.json'), null);
    const maps = {};
    try { for (const f of fs.readdirSync(d)) if (/^[0-9a-f-]{36}\.json$/.test(f)) maps[f.slice(0, -5)] = (readJson(path.join(d, f), {}) || {}).byAgent || {}; } catch { /* none */ }
    return ms ? { members: ms, rowMaps: maps } : { members, rowMaps };
  };
  const joinCheck = (scene, name) => {
    const j = byKind('member_joined', { from: name })[0];
    add(scene, `member_joined ${name}`, j && j.via === 'system', fmt(j));
    const { members: msAt, rowMaps: mapsAt } = stateAt(scene);
    const m = msAt[name];
    const map = m && mapsAt[m.session_id];
    const roomRow = map && Object.values(map).find(r => r.kind === 'room' && r.name === code);
    const orchMap = msAt.orch && mapsAt[msAt.orch.session_id];
    const pRow = orchMap && Object.entries(orchMap).find(([, r]) => r.kind === 'participant' && r.name === name);
    add(scene, `Row ids mapped: ${name}'s room row, the orch's ${name} row`, !!roomRow && !!pRow,
      `rows/${m ? m.session_id.slice(0, 8) : '?'}…json room row ${roomRow ? 'yes' : 'no'}; orch map ${name} → ${pRow ? pRow[0] : 'none'}`);
  };
  joinCheck('S2', 'alice');
  {
    const a = panelRows(cap('S2', 'alice')), oRows = panelRows(cap('S2', 'orch'));
    const sl = statusLine(cap('S2', 'alice'));
    add('S2', `alice's panel: one ${code} row and no status line`, a.length === 1 && a[0].label === code && !sl, `alice rows: ${a.map(r => r.line).join(' | ') || 'none'}; status line: ${sl || 'none'}`);
    add('S2', 'orch panel has an alice row', oRows.some(r => r.label === 'alice'), `orch rows: ${oRows.map(r => r.line).join(' | ') || 'none'}`);
  }
  joinCheck('S3', 'bob');
  {
    const oRows = panelRows(cap('S3', 'orch')), a = panelRows(cap('S3', 'alice')), b = panelRows(cap('S3', 'bob'));
    add('S3', 'orch: 2 rows (alice, bob)', oRows.length === 2 && oRows.some(r => r.label === 'alice') && oRows.some(r => r.label === 'bob'), `orch rows: ${oRows.map(r => r.line).join(' | ')}`);
    add('S3', `members: 1 row each (${code})`, a.length === 1 && b.length === 1 && a[0].label === code && b[0].label === code, `alice: ${a.map(r => r.line).join(' | ')}; bob: ${b.map(r => r.line).join(' | ')}`);
  }

  // ---- S4
  {
    for (const [seat, text] of [['alice', DEMO.alice4], ['bob', DEMO.bob4]]) {
      const e = log.find(x => x.kind === 'say' && x.from === seat && x.via === 'human');
      add('S4', `${seat}'s @room text identical byte for byte, via=human`, e && e.text === text, e ? `#${e.id} via=${e.via} text ${e.text === text ? '===' : '!=='} typed (${Buffer.byteLength(e.text)} bytes)` : 'no say via=human');
      const turn = noModelTurn(seat, e);
      add('S4', `${seat}'s @room ran 0 model turns`, turn.pass, turn.evidence);
    }
    const e = log.find(x => x.kind === 'say' && x.from === 'alice' && x.via === 'human');
    const t = cap('S4', 'alice');
    // Phase 0 (0.5): success is continue:false + stopReason: one "Operation stopped by hook: ✓ posted to CODE as #N"
    // line under the human's own ❯ @room row, and no "blocked by hook" header
    const rc = e && t && new RegExp(`Operation stopped by hook: ✓ posted to ${esc(code)} as #${e.id}`).test(t);
    add('S4', 'Receipt "Operation stopped by hook: ✓ posted to CODE as #N" in alice\'s pane', rc, rc ? `"Operation stopped by hook: ✓ posted to ${code} as #${e.id}" (${capName('S4', 'alice')})` : `not found in ${capName('S4', 'alice')}`);
    for (const seat of ['alice', 'bob']) {
      const caps = index.filter(r => r.scene === 'S4' && r.session === `sh-${seat}`);
      const hits = caps.map(r => [r.txt, (readText(path.join(screens, r.txt)) || '').split('\n').filter(l => /blocked by hook/i.test(l)).length]).filter(([, n]) => n);
      add('S4', `No "blocked by hook" header in ${seat}'s S4 panes`, caps.length > 0 && hits.length === 0,
        caps.length ? (hits.length ? hits.map(([f, n]) => `${f}: ${n}`).join(', ') : `0 lines in ${caps.length} captures`) : 'no S4 captures');
    }
    const oRows = panelRows(cap('S4', 'orch'));
    const ar = oRows.find(r => r.label === 'alice');
    add('S4', 'The orch\'s alice row updates with her post', !!(ar && e && ar.text.includes(`#${e.id}`)), `orch alice row: ${ar ? ar.line : 'none'}`);
  }

  // ---- S5 (no checks in the plan; record what the screen shows)
  {
    const sl = statusLine(cap('S5', 'orch'));
    add('S5', 'The orch\'s own status line is shown', sl.startsWith(`⬡ ${code} · orch`), `status line: "${sl}"`);
  }

  // ---- S6
  const revs = log.filter(e => e.kind === 'plan_rev' && e.plan_hash);
  {
    const r1 = revs[0];
    add('S6', 'plan_rev published', !!r1, fmt(r1) + (r1 ? ` approvers ${r1.approvers.join(',')}` : ''));
    if (r1) {
      const offers = debug.map(l => /^(\S+) (\d+) signoff: offer (?:\S+ )*?(sh-\S+) (\w+)$/.exec(l)).filter(m => m && m[4] === r1.plan_hash);
      const t0 = Date.parse(r1.at);
      const firstByPid = new Map();
      for (const m of offers) if (!firstByPid.has(m[2])) firstByPid.set(m[2], Date.parse(m[1]) - t0);
      const lags = [...firstByPid.values()];
      add('S6', 'Form sent to each approver within 1 s', lags.length >= r1.approvers.length && lags.every(x => x >= 0 && x < 1000),
        `elicitation/create offers after plan_rev #${r1.id}: ${lags.map(x => x + ' ms').join(', ') || 'none'} (${lags.length} servers, ${r1.approvers.length} approvers; mcp-debug.log)`);
      for (const seat of ['alice', 'bob']) {
        const t = cap('S6', seat) || '';
        const ok = /requests your input/.test(t) && t.includes(`plan ${r1.plan_hash.slice(0, 6)}`) && /full plan: \S+\.md/i.test(t) && /Approve this plan\?/.test(t) && /Object/.test(t);
        add('S6', `${seat}'s pane shows the form: room/plan line, summary, path, Approve/Object`, ok, ok ? `"plan ${r1.plan_hash.slice(0, 6)}", "full plan: …md", "Approve this plan? … Object" in ${capName('S6', seat)}` : `form text incomplete in ${capName('S6', seat)}`);
      }
    }
  }

  // ---- S7
  {
    const r1 = revs[0];
    const ob = r1 && log.find(e => e.kind === 'objection' && e.from === 'bob' && e.plan_hash === r1.plan_hash);
    add('S7', 'objection via=human from bob on the plan', ob && ob.via === 'human', fmt(ob));
    add('S7', 'Reason identical byte for byte', ob && ob.text === DEMO.reason7, ob ? `logged ${ob.text === DEMO.reason7 ? '===' : '!=='} typed: ${ob.text}` : 'no objection');
    const filled = cap('S7', 'bob', 1) || '';
    const tail = DEMO.reason7.slice(-30); // the box shows the end of a long reason
    add('S7', 'bob\'s form shown filled in (Object + reason) before submit', /Object to plan/.test(filled) && filled.includes(tail), `${capName('S7', 'bob', 1)}: ${/Object to plan/.test(filled) ? '"Object to plan" form' : 'no objection form'}, reason ${filled.includes(tail) ? 'typed' : 'absent'}`);
    const oR = panelRows(cap('S7', 'orch', 'last')).find(r => r.label === 'bob');
    const aR = panelRows(cap('S7', 'alice', 'last')).find(r => r.label === code);
    add('S7', 'The objection shows in the orch\'s bob row', !!(oR && /objection|objected|✖/.test(oR.text)), `orch: ${oR ? oR.line : 'none'}`);
    const aT = cap('S7', 'alice', 'last') || '';
    if (aR || !/requests your input/.test(aT)) {
      add('S7', 'The objection shows in alice\'s room row', !!(aR && /objection|objected|✖/.test(aR.text)), aR ? `alice: ${aR.line}` : 'no room row in alice\'s capture');
    } else {
      // Her own open form for the same plan covers her panel on screen (Claude Code draws the form in its place).
      // Evidence instead: the plugin's row renderer over the log as it stood at that capture.
      const rec = index.filter(r => r.scene === 'S7' && r.session === 'sh-alice').at(-1);
      const asOf = log.filter(e => Date.parse(e.at) <= Date.parse(rec.time));
      process.env.SUB_HUMAN_HOME = home;
      const rowsLib = require(path.join(REPO, 'plugin/sub-human/lib/rows.js'));
      const text = rowsLib.rowText(code, code, 'alice', { entries: asOf, members: stateAt('S7').members, now: Date.parse(rec.time) });
      add('S7', 'The objection is in alice\'s room row text (her open form covers the panel on screen)', /objection|✖/.test(text),
        `rowText(${code}, viewer alice) over the ${asOf.length} log entries at ${rec.txt}: "${text}"; on screen her sign-off form for the same plan is drawn over the panel`);
    }
  }

  // ---- S8
  const last = revs.at(-1);
  {
    add('S8', 'The orch revised: a second plan_rev', revs.length >= 2, revs.map(r => `#${r.id} ${r.plan_hash.slice(0, 6)}`).join(', '));
    if (revs.length >= 2) {
      const stale = debug.filter(l => / signoff: cancel \S+ plan (\w+) was replaced by (\w+)/.test(l));
      add('S8', 'Stale open form cancelled when the revision arrived', stale.length > 0, stale.map(l => clip(l.replace(/^\S+ /, ''), 120)).join(' ; ') || 'no cancel in mcp-debug.log (an answered form needs none)');
    }
    const ap = last ? last.approvers : [];
    const sig = ap.map(n => log.find(e => e.kind === 'signoff' && e.via === 'human' && e.from === n && e.plan_hash === (last && last.plan_hash)));
    add('S8', `Matrix complete: every approver signed ${last ? last.plan_hash.slice(0, 6) : ''} via=human`, ap.length > 0 && sig.every(Boolean), ap.map((n, i) => `${n}: ${sig[i] ? '#' + sig[i].id : 'missing'}`).join(', '));
    // the rows flip from ✓ signed to ✔ decided ~2 s after the last sign-off, so look across every S8 orch capture
    const caps = index.filter(r => r.scene === 'S8' && r.session === 'sh-orch').map(r => [r.txt, panelRows(readText(path.join(screens, r.txt)))]);
    const seen = ap.map(n => caps.find(([, rs]) => rs.some(r => r.label === n && /✓ signed/.test(r.text))));
    // The rows refresh every 5 s (Claude Code's subagentStatusLine tick). The decision follows the last sign-off
    // by ~2 s, so the last signer's row may go straight to ✔ decided: accepted only when the log shows that gap.
    const dec = last && log.find(e => e.kind === 'decision' && e.plan_hash === last.plan_hash);
    const lastSig = sig.filter(Boolean).sort((a, b) => a.id - b.id).at(-1);
    const gap = dec && lastSig ? Date.parse(dec.at) - Date.parse(lastSig.at) : null;
    const viaDecided = ap.map((n, i) => !seen[i] && lastSig && lastSig.from === n && gap != null && gap < 5000 &&
      caps.find(([, rs]) => rs.some(r => r.label === n && /✔ decided/.test(r.text))));
    add('S8', '✓ signed shown on each approver\'s row (orch panel)', ap.length > 0 && ap.every((n, i) => seen[i] || viaDecided[i]),
      ap.map((n, i) => `${n}: ${seen[i] ? seen[i][1].find(r => r.label === n).line + ' (' + seen[i][0] + ')' : viaDecided[i] ? `${viaDecided[i][1].find(r => r.label === n).line} (${viaDecided[i][0]}; the decision #${dec.id} came ${gap} ms after the last sign-off, inside one 5 s row refresh)` : 'never shown signed'}`).join('; '));
  }

  // ---- S9
  {
    const d = last && log.find(e => e.kind === 'decision' && e.plan_hash === last.plan_hash);
    const sigIds = last ? log.filter(e => e.kind === 'signoff' && e.via === 'human' && e.plan_hash === last.plan_hash).map(e => e.id) : [];
    add('S9', 'decision refs both sign-offs', d && sigIds.length >= 2 && sigIds.every(id => (d.refs || []).includes(id)), d ? `#${d.id} refs [${(d.refs || []).join(',')}], signoffs [${sigIds.join(',')}]` : 'no decision');
    { const ch = chainOk(home, code); add('S9', 'Hash chain valid', ch.ok, ch.evidence); }
    const t = cap('S9', 'orch') || '';
    const dialog = /Would you like to proceed|Ready to code\?|Yes, and auto-accept/.test(t);
    const planOn = /plan mode on/.test(t);
    add('S9', 'Orch left plan mode with no dialog', !!t && !dialog && !planOn, `${capName('S9', 'orch')}: approval dialog ${dialog ? 'present' : 'absent'}; "plan mode on" ${planOn ? 'still shown' : 'gone'}`);
    const asg = d && log.find(e => e.id > d.id && e.from === 'orch' && e.via === 'agent' && /assign|owner|owns|alice/i.test(e.text || ''));
    add('S9', 'Assignments posted after the decision', !!asg, fmt(asg));
    const oRows = panelRows(t);
    add('S9', 'Rows read ✓ decided', oRows.length > 0 && oRows.every(r => /decided/.test(r.text)), oRows.map(r => r.line).join(' | ') || 'no rows');
  }

  // ---- S10
  {
    const d = log.find(e => e.kind === 'decision');
    const st = log.filter(e => e.kind === 'status' && e.from === 'alice' && (!d || e.id > d.id));
    add('S10', 'alice posted status entries after the decision', st.length >= 2, st.map(fmt).join(' ; ') || 'none');
    const ev = st.find(e => /\b\d+\s*(tests?|pass(ed|ing)?|checks?)\b|\bpass(ed)?\b.*\d|✓|\bcommit [0-9a-f]{6,}|\S+\.(js|ts|json)\b/i.test(e.text || ''));
    add('S10', 'Status cites evidence (tests, path or commit)', !!ev, fmt(ev));
    const all = index.filter(r => r.scene === 'S10' && r.session === 'sh-alice').map(r => readText(path.join(screens, r.txt)) || '').join('\n');
    const bg = /general-purpose|Backgrounded agent|run_in_background/.test(all) || panelRows(cap('S10', 'alice')).some(r => r.label !== code);
    add('S10', 'alice\'s work runs in a native background subagent (shown in her panel)', bg, bg ? 'background agent visible in alice\'s S10 capture' : 'no background agent in alice\'s S10 captures');
    const oR = panelRows(cap('S10', 'orch', 'last')).find(r => r.label === 'alice');
    add('S10', 'Her status shows in the orch\'s alice row', !!(oR && /status/.test(oR.text)), `orch alice row: ${oR ? oR.line : 'none'}`);
  }

  // ---- S11
  {
    const a = panelRows(cap('S11', 'alice', 1));
    add('S11', `Rows present after /clear in alice's session (one ${code} row)`, a.filter(r => r.label === code).length === 1, `alice rows: ${a.map(r => r.line).join(' | ') || 'none'} (${capName('S11', 'alice', 1)})`);
    const b = panelRows(cap('S11', 'bob', 'last'));
    add('S11', `Rows re-created after bob's --continue (${code} row)`, b.some(r => r.label === code), `bob rows: ${b.map(r => r.line).join(' | ') || 'none'} (${capName('S11', 'bob', 'last')})`);
    // Phase 0 (0.9): row-rewake brings the rows back with no prompt. Evidence: bob's transcript entries between
    // his member_left (the /exit) and the last S11 capture hold the row-rewake wake and no prompt of his.
    {
      const w11 = sceneWindow('S11');
      const left = byKind('member_left', { from: 'bob' }).find(e => w11 && Date.parse(e.at) >= w11.from);
      const lastCap = index.filter(r => r.scene === 'S11' && r.session === 'sh-bob').at(-1);
      const fallback = index.some(r => r.scene === 'S11' && /^FALLBACK/.test(r.caption || ''));
      let ev = 'no member_left for bob in S11 or no capture';
      let ok = false;
      if (left && lastCap) {
        const from = left.at, to = lastCap.time;
        const es = transcriptFor('bob').files.flatMap(f => jsonl(f)).filter(e => e.timestamp && e.timestamp > from && e.timestamp <= to && !e.isSidechain);
        const prompts = es.filter(e => e.type === 'user' && !e.isMeta && !metrics.trigger(e) && !(e.origin && e.origin.kind === 'task-notification') &&
          !(Array.isArray(e.message && e.message.content) && e.message.content.every(c => c && c.type === 'tool_result')));
        const wake = es.find(e => metrics.trigger(e) === 'rewake');
        const after = wake && es.find(e => e.type === 'assistant' && e.timestamp >= wake.timestamp && JSON.stringify(e.message.content).includes('"Agent"'));
        ok = !!wake && !!after && prompts.length === 0 && !fallback && b.some(r => r.label === code);
        ev = `${wake ? `row-rewake wake at ${wake.timestamp.slice(11, 19)}` : 'no row-rewake wake'}; ${after ? `Agent call at ${after.timestamp.slice(11, 19)}` : 'no Agent call after it'}; ` +
          `${prompts.length} prompt(s) from bob between his /exit (#${left.id}) and ${lastCap.txt}${prompts.length ? ': ' + prompts.map(e => clip(typeof e.message.content === 'string' ? e.message.content : JSON.stringify(e.message.content), 60)).join(' / ') : ''}` +
          (fallback ? '; FALLBACK used: the driver typed "what did I miss?"' : '');
      }
      add('S11', 'bob\'s rows came back with no prompt (row-rewake woke his Claude)', ok, ev);
    }
    const st11 = stateAt('S11');
    const bm = st11.members.bob && st11.rowMaps[st11.members.bob.session_id];
    const w = sceneWindow('S11');
    const fresh = bm && w && Object.values(bm).some(r => r.kind === 'room' && Date.parse(r.at) > w.from);
    add('S11', 'bob\'s new room row is mapped after the resume', !!fresh, bm ? Object.values(bm).map(r => `${r.kind}:${r.name}@${r.at.slice(11, 19)}`).join(', ') : 'no rows map for bob\'s session');
  }

  // ---- S11b
  {
    const s1 = cap('S11b', 'alice', 1) || '', s2 = cap('S11b', 'alice', 2) || '', s3 = cap('S11b', 'alice', 3) || '';
    const rows1 = panelRows(s1);
    const nested = rows1.find(r => r.label === 'bob' && r.nested);
    const viewing = new RegExp(`─ ${esc(code)} ─`).test(s1); // the prompt box is titled after the viewed agent
    add('S11b', 'Opening the room row shows bob nested inside it', !!nested && viewing, `viewing ${viewing ? code : '?'}; rows: ${rows1.map(r => r.line).join(' | ') || 'none'}`);
    const view2 = /─ bob ─/.test(s2);
    const thread = (s2.match(/#\d+ (bob|bob's Claude|room|facilitator)( → \S+)? · [a-z_]+: .*/g) || []);
    add('S11b', 'Opening bob shows his thread (labelled entries)', view2 && thread.length > 0, `viewing ${view2 ? 'bob' : '?'}; ${thread.length ? thread.slice(-2).join(' / ') : 'no labelled entries'} (${capName('S11b', 'alice', 2)})`);
    const bc = /main\s*›/.test(s1 + s2 + s3);
    const back = new RegExp(`─ ${esc(code)} ─`).test(s3);
    add('S11b', 'No breadcrumb (P0 correction); ↑ + Enter returns to the parent', !bc && back, `breadcrumb ${bc ? 'found' : 'absent'}; step 3 ${back ? `views ${code} again` : 'not back on the room row'}`);
  }

  // ---- S12
  {
    const rj = byKind('member_joined', { from: 'bob' }).at(-1);
    const l = byKind('member_left', { from: 'bob' }).filter(e => !rj || e.id > rj.id).at(-1);
    add('S12', 'member_left bob (after his last rejoin), from /exit', !!l && /prompt_input_exit|exit/.test(l.text || ''), fmt(l));
    const waits = jsonl(path.join(screens, 'waits.jsonl')).filter(w => w.scene === 'S12');
    const dlg = waits.find(w => /Exit and stop tasks/.test(w.what));
    add('S12', 'Claude Code\'s "Background work is running" dialog was answered with 1. Exit and stop tasks', !!(dlg && dlg.ok), dlg ? `${dlg.what}: ${dlg.ok ? 'seen' : 'not seen'} after ${dlg.ms} ms` : 'no dialog wait recorded in S12');
    const o = panelRows(cap('S12', 'orch', 'last')).filter(r => r.label === 'bob' && !/left/.test(r.text));
    add('S12', 'bob\'s row reads left (or is gone) in the orch panel', !!cap('S12', 'orch', 'last') && o.length === 0, `orch rows: ${panelRows(cap('S12', 'orch', 'last')).map(r => r.line).join(' | ') || 'none'}`);
    const a = panelRows(cap('S12', 'alice', 'last')).filter(r => r.label === 'bob' && !/left/.test(r.text));
    add('S12', 'bob\'s row reads left (or is gone) in alice\'s panel', !!cap('S12', 'alice', 'last') && a.length === 0, `alice rows: ${panelRows(cap('S12', 'alice', 'last')).map(r => r.line).join(' | ') || 'none'}`);
  }

  // ---- Metrics: Phase 0 vs the vole-8126 baseline (scripts/metrics.js; transcripts + captures)
  const M = metrics.measure({ screens });
  if (M.error) add('Metrics', 'Run metrics computed', false, M.error);
  else {
    const B = metrics.BASELINE;
    const per = s => `${s} ${M.seats[s].wakes.turns}`;
    add('Metrics', `Room-caused model wakes ≤ 26 (baseline ${B.wakes.total})`, M.total.wakes <= 26,
      `${M.total.wakes} wakes (${['orch', 'alice', 'bob'].map(per).join(', ')}) from Monitor events, peer deliveries and row-rewake in the seats' transcripts; baseline orch ${B.wakes.orch}, alice ${B.wakes.alice}, bob ${B.wakes.bob}`);
    add('Metrics', 'UI noise lines per capture below the baseline', M.total.noise.perCapture < B.noise.perCapture,
      `${M.total.noise.lines} lines / ${M.total.noise.captures} captures = ${M.total.noise.perCapture} (excl. "Waiting for": ${M.total.noise.perCaptureExWaiting}); baseline ${B.noise.perCapture} (${B.noise.perCaptureExWaiting})`);
  }

  // order scenes like the plan
  const order = ['Metrics', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S11b', 'S12'];
  const res = {};
  for (const k of order) if (C[k]) res[k] = C[k];
  res._meta = { cost: cost(), run: `room ${code}, ${log.length} log entries, ${index.length} captures`, note: o.note || '' };
  if (!M.error) res._metrics = { run: { room: code, ...M }, baseline: metrics.BASELINE };
  fs.writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
  let p = 0, f = 0;
  for (const k of order) for (const c of res[k] || []) { c.pass ? p++ : f++; process.stdout.write(`${c.pass ? 'PASS' : 'FAIL'} ${k} ${c.check}${c.pass ? '' : ' — ' + c.evidence}\n`); }
  process.stdout.write(`checks: ${p} pass / ${f} fail -> ${path.relative(process.cwd(), out)} (${res._meta.cost})\n`);

  // ---------- helpers that need the run's context ----------
  function transcriptFor(seat) {
    const m = members[seat];
    const dir = path.join(os.homedir(), '.claude', 'projects', `-private-tmp-sh-demo-${seat}`);
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)); } catch { /* none */ }
    return { files, sid: m && m.session_id };
  }
  function noModelTurn(seat, e) {
    if (!e) return { pass: false, evidence: 'no entry' };
    const { files } = transcriptFor(seat);
    for (const f of files) {
      const es = jsonl(f);
      // typed mid-turn: the prompt is queued, and the hook drops it before the model sees it
      const q = es.find(x => x.type === 'queue-operation' && x.operation === 'remove' && x.reason === 'dropped_by_hook' && typeof x.content === 'string' && x.content.endsWith(e.text));
      if (q) return { pass: true, evidence: `${path.basename(f).slice(0, 8)}…: queued prompt removed with reason dropped_by_hook (#${e.id}); it never reached the model` };
      const i = es.findIndex(x => x.type === 'system' && typeof x.content === 'string' && x.content.includes(`posted to ${code} as #${e.id}`));
      if (i < 0) continue;
      for (let j = i + 1; j < es.length; j++) {
        const x = es[j];
        if (x.type === 'user' && !x.isMeta) return { pass: true, evidence: `${path.basename(f).slice(0, 8)}…: hook receipt for #${e.id}, no assistant message before the next user/notification entry` };
        if (x.type === 'assistant') return { pass: false, evidence: `assistant message right after the receipt for #${e.id}` };
      }
      return { pass: true, evidence: `${path.basename(f).slice(0, 8)}…: hook receipt for #${e.id} is the last turn activity` };
    }
    return { pass: false, evidence: `no hook receipt for #${e.id} in ${seat}'s transcripts` };
  }
  function cost() {
    // Approximate: tokens from every transcript (main + subagents) of the three seats, at list prices.
    const price = m => (/haiku/.test(m) ? [1, 5, 1.25, 0.1] : /sonnet/.test(m) ? [3, 15, 3.75, 0.3] : [5, 25, 6.25, 0.5]);
    let usd = 0;
    const since = index.length ? index.map(r => r.time).sort()[0].slice(0, 19) : '';
    const seen = new Set();
    const walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of es) { const p = path.join(d, x.name); if (x.isDirectory()) walk(p); else if (x.name.endsWith('.jsonl')) { for (const e of jsonl(p)) { const u = e.message && e.message.usage; if (!u || e.type !== 'assistant' || (since && e.timestamp < since)) continue; const id = e.message.id || e.uuid; if (seen.has(id)) continue; seen.add(id); const [i, o2, cw, cr] = price(e.message.model || ''); usd += ((u.input_tokens || 0) * i + (u.output_tokens || 0) * o2 + (u.cache_creation_input_tokens || 0) * cw + (u.cache_read_input_tokens || 0) * cr) / 1e6; } } } };
    for (const seat of ['orch', 'alice', 'bob']) walk(path.join(os.homedir(), '.claude', 'projects', `-private-tmp-sh-demo-${seat}`));
    return `≈ $${usd.toFixed(2)} (list-price estimate from transcript token usage since the first capture)`;
  }
}

function chainOk(home, code) {
  // the plugin's own verifier (prev = hash of the previous raw line)
  process.env.SUB_HUMAN_HOME = home;
  const room = require(path.join(REPO, 'plugin/sub-human/lib/room.js'));
  room.bind(code);
  const r = room.validateChain();
  return { ok: !!r.ok, evidence: r.ok ? `validateChain ok over ${r.count} entries` : `chain breaks at #${r.badAt} (${r.count} entries)` };
}

if (require.main === module) main();
module.exports = { panelRows, statusLine };
