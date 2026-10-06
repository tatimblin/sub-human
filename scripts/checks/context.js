'use strict';
/**
 * context: everything a scene module reads, built once from a run's evidence (read-only).
 *
 *   const ctx = context({ screens, home, room })
 *
 * ctx.code, roomDir, log, members, orchSid, job, index (screens/index.json), props (proposals with a hash),
 * and helpers over the captures (cap, caps, capName, span), the per-step state (st, stText, nativeTasks),
 * the seats' transcripts (entries, inSpan, toolUses, assistantIds, peerIn, monitorIn, orchTurns, replyAfter,
 * noModelTurn, rowUserText, rowReply), the room log (byKind, fmt, logIn, shownVia), chainOk() and cost().
 */
const fs = require('node:fs');
const path = require('node:path');
const metrics = require('../metrics.js');
const paths = require('../lib/paths.js');
const { readJson, readText, jsonl, clip, textOf } = require('../lib/io.js');

/** The demo's scripted words (scripts/demo.sh): checks compare the log against them byte for byte. */
const DEMO = {
  alice3: "bob, can you take the parser tests? handler's in src/server.js",
  bob4: "@orch let's plan cursor paging for GET /tasks: ?limit&after, opaque cursor, newest first",
  note5: 'add a test for a cursor past the end — `after=zzz` must 400, not 500',
  viewer9: "hi orch, what's next?",
};

function context({ screens, home, room }) {
  const index = readJson(path.join(screens, 'index.json'), []);
  let code = room || (index.find(r => r.room) || {}).room;
  if (!code) { try { code = fs.readdirSync(path.join(home, 'rooms')).sort().at(-1); } catch { /* none */ } }
  if (!code) throw new Error(`no room: none in ${path.join(screens, 'index.json')} and no rooms in ${home}`);
  const roomDir = path.join(home, 'rooms', code);
  const log = jsonl(path.join(roomDir, 'log.jsonl'));
  const members = readJson(path.join(roomDir, 'members.json'), {});
  const orchSid = members.orch && members.orch.session_id;
  const job = members.orch && members.orch.job;
  const projects = paths.projectsDir();

  // ---- captures and per-step state
  const caps = (scene, seat) => index.filter(r => r.scene === scene && r.session === `sh-${seat}`);
  const pick = (scene, seat, step) => { const rs = caps(scene, seat); return step === 'last' ? rs.at(-1) : rs.find(x => x.step === step); };
  const cap = (scene, seat, step = 1) => { const r = pick(scene, seat, step); return r ? readText(path.join(screens, r.txt)) : null; };
  const capName = (scene, seat, step = 1) => { const r = pick(scene, seat, step); return r ? r.txt : `(no ${scene} step ${step} capture of sh-${seat})`; };
  const win = scene => { const rs = index.filter(r => r.scene === scene); return rs.length ? { from: rs.map(r => r.time).sort()[0], to: rs.map(r => r.time).sort().at(-1) } : null; };
  // a scene's window runs from the previous scene's last capture to its own last capture
  const sceneOrder = [...new Set(index.map(r => r.scene))];
  const span = scene => {
    const w = win(scene); if (!w) return null;
    const i = sceneOrder.indexOf(scene);
    const prev = i > 0 ? win(sceneOrder[i - 1]) : null;
    return { from: prev ? prev.to : new Date(Date.parse(w.from) - 180_000).toISOString(), to: w.to };
  };
  const runStart = index.length ? new Date(Date.parse(index.map(r => r.time).sort()[0]) - 180_000).toISOString() : '';
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
  const stateFile = (...p) => path.join(screens, 'state', ...p);

  // ---- transcripts
  const seatFiles = seat => {
    if (seat === 'orch') { const f = []; try { for (const d of fs.readdirSync(projects)) { const p = path.join(projects, d, `${orchSid}.jsonl`); if (orchSid && fs.existsSync(p)) f.push(p); } } catch { /* none */ } return f; }
    const dir = paths.seatProjectDir(seat);
    // not an orch's transcript (this run's, or an earlier run's orch that also started in alice's folder)
    const isOrch = f => f === `${orchSid}.jsonl` || /"agentSetting":"sub-human:orchestrator"/.test((readText(path.join(dir, f)) || '').slice(0, 2000));
    try { return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !isOrch(f)).map(f => path.join(dir, f)); } catch { return []; }
  };
  const tcache = {};
  const entries = seat => (tcache[seat] = tcache[seat] || seatFiles(seat).flatMap(f => jsonl(f).map(e => ({ ...e, _file: path.basename(f) }))).filter(e => e.agentSetting !== 'sub-human:orchestrator' || seat === 'orch'));
  const inSpan = (es, s) => (s ? es.filter(e => e.timestamp && e.timestamp > s.from && e.timestamp <= s.to) : []);
  const toolUses = (es, name) => es.filter(e => e.type === 'assistant' && !e.isSidechain).flatMap(e => (e.message.content || []).filter(c => c && c.type === 'tool_use' && (!name || c.name === name || new RegExp(name).test(c.name))).map(c => ({ ...c, at: e.timestamp })));
  const assistantIds = es => new Set(es.filter(e => e.type === 'assistant' && !e.isSidechain).map(e => e.message.id || e.uuid));
  const peerIn = (es, from) => es.filter(e => e.type === 'user' && e.origin && e.origin.kind === 'peer' && (!from || String(e.origin.name || '').startsWith(from + '.')));
  const monitorIn = es => es.filter(e => metrics.trigger(e) === 'monitor');
  const orchTurns = s => assistantIds(inSpan(entries('orch'), s)).size;

  // ---- the room log
  const byKind = (k, f = {}) => log.filter(e => e.kind === k && Object.entries(f).every(([a, b]) => e[a] === b));
  const fmt = e => (e ? `#${e.id} ${e.from} ${e.via} ${e.kind}${e.hash ? ' ' + e.hash.slice(0, 6) : ''}${e.proposal_hash ? ' ' + e.proposal_hash.slice(0, 6) : ''}: ${clip(e.text, 90)}` : 'none');
  const logIn = s => (s ? log.filter(e => e.at > s.from && e.at <= s.to) : []);
  const props = log.filter(e => e.kind === 'proposal' && e.hash);

  /** The assistant turn a wake started in seat's transcript: its text (all text blocks, in order) and tool names, up to the next prompt or notice. */
  function replyAfter(seat, wake) {
    const f = seatFiles(seat).find(x => path.basename(x) === wake._file);
    if (!f) return null;
    const es = jsonl(f).filter(e => !e.isSidechain);
    const i = es.findIndex(e => e.uuid === wake.uuid);
    if (i < 0) return null;
    const text = [], tools = [];
    for (const e of es.slice(i + 1)) {
      if (e.type === 'user' && !e.isMeta && !(Array.isArray(e.message && e.message.content) && e.message.content.every(c => c && c.type === 'tool_result'))) break;
      if (e.type !== 'assistant') continue;
      for (const c of e.message.content || []) {
        if (c && c.type === 'text') text.push(c.text);
        if (c && c.type === 'tool_use') tools.push(c.name);
      }
    }
    return { text: text.join('\n'), tools };
  }
  /** How log entry id was shown to name as a join/leave line ("monitor" | "prompt" | "notification"), from rows/notices-NAME.json. */
  function shownVia(name, id) {
    const rec = readJson(path.join(roomDir, 'rows', `notices-${name}.json`), {});
    const x = (Array.isArray(rec.log) ? rec.log : []).find(y => y.id === id);
    return x ? x.via : null;
  }
  function noModelTurn(seat, e) {
    if (!e) return { pass: false, evidence: 'no entry' };
    for (const f of seatFiles(seat)) {
      const es = jsonl(f);
      const q = es.find(x => x.type === 'queue-operation' && x.operation === 'remove' && x.reason === 'dropped_by_hook' && typeof x.content === 'string' && x.content.endsWith(e.text));
      if (q) return { pass: true, evidence: `${path.basename(f).slice(0, 8)}…: queued prompt removed by the hook (#${e.id}); it never reached the model` };
      // the receipt carries no id: the first "✓ sent" system line at or after the entry (within 10 s)
      const i = es.findIndex(x => x.type === 'system' && typeof x.content === 'string' && /✓ sent/.test(x.content) && x.timestamp >= new Date(Date.parse(e.at) - 2000).toISOString() && x.timestamp <= new Date(Date.parse(e.at) + 10_000).toISOString());
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
  /** Each entry of a seat's row-subagent transcripts (…/SESSION/subagents/*.jsonl), with its file name. */
  function* rowEntries(seat) {
    const dir = paths.seatProjectDir(seat);
    let ds = [];
    try { ds = fs.readdirSync(dir).filter(d => fs.existsSync(path.join(dir, d, 'subagents'))); } catch { return; }
    for (const d of ds) for (const f of fs.readdirSync(path.join(dir, d, 'subagents')).filter(x => x.endsWith('.jsonl'))) {
      for (const e of jsonl(path.join(dir, d, 'subagents', f))) yield { e, file: f };
    }
  }
  /** A user message matching re delivered to one of a seat's row subagents after `since`. */
  function rowUserText(seat, since, re) {
    for (const { e, file } of rowEntries(seat)) {
      if (e.type !== 'user' || !e.timestamp || e.timestamp < since) continue;
      const c = e.message && e.message.content;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join('\n') : '';
      if (re.test(t)) return { at: e.timestamp, file };
    }
    return null;
  }
  /** A row subagent's "read-only row" text in a seat's subagent transcripts after `since`. */
  function rowReply(seat, since) {
    for (const { e, file } of rowEntries(seat)) {
      if (e.type !== 'assistant' || !e.timestamp || e.timestamp < since) continue;
      const tx = (e.message.content || []).find(c => c && c.type === 'text' && /read-only row/.test(c.text));
      if (tx) return { at: e.timestamp, text: tx.text, file };
    }
    return null;
  }
  /** The room's hash chain, validated by the plugin's own room lib. */
  function chainOk() {
    process.env.SUB_HUMAN_HOME = home;
    const r = paths.pluginLib('room.js').open(code).validateChain();
    return { ok: !!r.ok, evidence: r.ok ? `validateChain ok over ${r.count} entries` : `chain breaks at #${r.badAt} (${r.count} entries)` };
  }
  /** Approximate cost: tokens from every transcript (main + subagents) of the seats and the orch, at list prices (baselines.json prices). */
  function cost() {
    const P = metrics.BASELINES.prices;
    const price = m => (Object.entries(P).find(([k]) => k !== 'default' && m.includes(k)) || [null, P.default])[1];
    let usd = 0;
    const until = index.length ? new Date(Date.parse(index.map(r => r.time).sort().at(-1)) + 60_000).toISOString() : ''; // not later runs
    const seen = new Set();
    const byModel = {};
    const walk = d => {
      let es = [];
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const x of es) {
        const p = path.join(d, x.name);
        if (x.isDirectory()) { walk(p); continue; }
        if (!x.name.endsWith('.jsonl')) continue;
        for (const e of jsonl(p)) {
          const u = e.message && e.message.usage;
          if (!u || e.type !== 'assistant' || (runStart && e.timestamp < runStart) || (until && e.timestamp > until)) continue;
          const id = e.message.id || e.uuid;
          if (seen.has(id)) continue;
          seen.add(id);
          const m = e.message.model || '';
          const [i, o2, cw, cr] = price(m);
          const c = ((u.input_tokens || 0) * i + (u.output_tokens || 0) * o2 + (u.cache_creation_input_tokens || 0) * cw + (u.cache_read_input_tokens || 0) * cr) / 1e6;
          usd += c; byModel[m] = (byModel[m] || 0) + c;
        }
      }
    };
    for (const seat of ['alice', 'bob']) walk(paths.seatProjectDir(seat)); // the orch's transcript is in alice's folder
    return `≈ $${usd.toFixed(2)} (${Object.entries(byModel).map(([m, c]) => `${m.replace(/^claude-/, '')} $${c.toFixed(2)}`).join(', ')}; list-price estimate from transcript token usage within the run)`;
  }

  return {
    DEMO, screens, home, code, roomDir, log, members, orchSid, job, index, props, runStart,
    caps, cap, capName, span, stateDir, st, stText, nativeTasks, stateFile,
    seatFiles, entries, inSpan, toolUses, assistantIds, peerIn, monitorIn, orchTurns, textOf,
    byKind, fmt, logIn, replyAfter, shownVia, noModelTurn, rowUserText, rowReply, chainOk, cost,
  };
}

module.exports = { context, DEMO };
