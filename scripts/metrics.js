#!/usr/bin/env node
'use strict';
/**
 * metrics: per-seat cost-of-the-room measurements for one demo run, from evidence only.
 *
 *   node scripts/metrics.js [--screens DIR] [--home DIR]   print the run's metrics as JSON
 *   require('./metrics.js').measure({screens, home})       same, as an object (used by checks.js)
 *
 * The run window is the first..last capture in screens/index.json (+30 s). Seats and their transcripts
 * (read-only): alice and bob are the top-level ~/.claude/projects/-private-tmp-sh-demo-SEAT/*.jsonl files; the
 * orch is a `claude --bg` job started in the joiner's folder, so its transcript is the file named after
 * members.json orch.session_id (wherever it is), and that file is left out of the folder's member seat.
 *
 * - wakes: room-caused model turns: a user entry that is a sub-human plugin prompt (the hooks module's wake:
 *   origin {kind: plugin, name: sub-human}, not isMeta), a peer delivery (origin.kind peer), or the row-rewake
 *   wake (its text "sub-human: this session was resumed…"), followed in file order by an assistant message before
 *   the next user prompt. Adjacent triggers that start one turn count once. `plugin` counts the plugin prompts.
 * - chat: `notices` = the hooks module's $.ui.log rows (system, level notice, "sub-human: …": what the
 *   person sees), `pulls` = its isMeta copies for the model (origin plugin sub-human), and `turns` / `calls` = model
 *   turns (and distinct assistant messages) that started with nothing but such rows since the previous turn ended:
 *   a chat burst should cost 0. `callsPerBurst` = calls / notices.
 * - injected: chars of hook additionalContext the seat's model received: `join` (UserPromptExpansion, the
 *   /sub-human join block), `total` (every hook_additional_context attachment, incl. restores and digests).
 * - noise: UI lines per capture of the seat's pane: the plugin prompt's framing ("The sub-human
 *   plugin sent a message", one per row), "Waiting for N background agents",
 *   "hook error", "blocked by hook", "Invalid tool parameters"; `perCapture` = all of them / captures,
 *   `perCaptureExWaiting` without "Waiting for". "Operation stopped by hook" (the @room receipt) is counted
 *   apart as `receipts`, not noise. `red`: lines drawn in a red foreground (from the .ansi capture) or
 *   reading "hook error".
 * - cards: for each consent card or plan-view review (an AskUserQuestion or ExitPlanMode call naming a proposal
 *   hash) in a member transcript,
 *   the model calls (distinct assistant message ids) from the entry that woke the turn to the card call
 *   (`toCard`, the card call included) and from the answer to the end of that turn (`after`).
 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./lib/paths.js');
const { readJson, jsonl, textOf } = require('./lib/io.js');

const SEATS = ['orch', 'alice', 'bob'];
const NOISE = {
  plugin: /The sub-human plugin sent a message/, // one per plugin prompt row (its framing line)
  waiting: /Waiting for \d+ background agents?/,
  hookError: /hook error/i,
  blocked: /blocked by hook/i,
  invalid: /Invalid tool parameters/,
};
const REWAKE = 'sub-human: this session was resumed';

/** Earlier runs to compare against (scripts/baselines.json runs; compare picks which fill checks.json _metrics). */
const BASELINES = require('./baselines.json');
const BASELINE = BASELINES.runs[BASELINES.compare.baseline];
const PHASE0 = BASELINES.runs[BASELINES.compare.phase0];
const PREV = BASELINES.runs[BASELINES.compare.prev];

const isToolResult = e => Array.isArray(e.message && e.message.content) && e.message.content.length > 0 && e.message.content.every(c => c && c.type === 'tool_result');

const projectsDir = p => p || paths.projectsDir();

/** The orch session id from <home>/rooms/<code>/members.json (the newest room), or null. */
function orchSession(home, code) {
  if (!home) return null;
  try {
    const rooms = path.join(home, 'rooms');
    const c = code || fs.readdirSync(rooms).map(d => ({ d, m: fs.statSync(path.join(rooms, d)).mtimeMs })).sort((a, b) => b.m - a.m)[0].d;
    const o = readJson(path.join(rooms, c, 'members.json'), {}).orch;
    return (o && o.session_id) || null;
  } catch { return null; }
}

/** Transcript files of a seat: [{file, es}] limited to the window. */
function transcripts(seat, from, to, projects, orchSid) {
  const base = projectsDir(projects);
  let files = [];
  if (seat === 'orch') {
    if (!orchSid) return [];
    try { for (const d of fs.readdirSync(base)) { const f = path.join(base, d, `${orchSid}.jsonl`); if (fs.existsSync(f)) files.push(f); } } catch { return []; }
  } else {
    const dir = path.join(base, path.basename(paths.seatProjectDir(seat)));
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && (!orchSid || f !== `${orchSid}.jsonl`)).map(f => path.join(dir, f)); } catch { return []; }
  }
  return files.map(f => ({ file: f, es: jsonl(f) }))
    .filter(({ es }) => seat === 'orch' || !es.some(e => e.agentSetting === 'sub-human:orchestrator')) // another room's orch in this folder
    .filter(({ es }) => es.some(e => e.timestamp && e.timestamp >= from && e.timestamp <= to))
    .map(t => ({ ...t, es: t.es.filter(e => !e.timestamp || (e.timestamp >= from && e.timestamp <= to)) }));
}

/** kind of room trigger a user entry is, or null */
function trigger(e) {
  if (e.type !== 'user' || isToolResult(e)) return null;
  const k = e.origin && e.origin.kind;
  const t = textOf(e.message && e.message.content);
  if (k === 'peer') return 'peer';
  if (t.includes(REWAKE)) return 'rewake';
  if (k === 'plugin' && e.origin.name === 'sub-human' && !e.isMeta) return 'plugin';
  return null;
}

/** The hooks module's chat row ($.ui.log: a system notice "sub-human: …"), or its isMeta copy for the model. */
const isChatNotice = e => e.type === 'system' && e.level === 'notice' && typeof e.content === 'string' && e.content.startsWith('sub-human: ');
const isPull = e => e.type === 'user' && e.isMeta && e.origin && e.origin.kind === 'plugin' && e.origin.name === 'sub-human';

const HASH_RE = /proposal\s+([0-9a-f]{6,12})\b/;  // the member text asks for "proposal <hash>"; a model may write only 6 hex
/** Consent-card calls in one transcript's entries: [{at, hash, toCard, after}]. */
function cardTurns(es) {
  const out = [];
  const main = es.filter(e => !e.isSidechain && (e.type === 'user' || e.type === 'assistant'));
  for (let i = 0; i < main.length; i++) {
    const e = main[i];
    if (e.type !== 'assistant') continue;
    // the card, or the plan view (ExitPlanMode "proposal <hash>": hooks/consent.js shows the proposal in the plan dialog)
    const call = (e.message.content || []).find(c => c && c.type === 'tool_use' && (c.name === 'AskUserQuestion' || c.name === 'ExitPlanMode') && HASH_RE.test(JSON.stringify(c.input || {})));
    if (!call) continue;
    // back to the entry that started this turn (a user entry that is not a tool result)
    let s = i - 1;
    const starts = x => x.type === 'user' && !isToolResult(x) && (!x.isMeta || (x.origin && x.origin.kind === 'peer'));
    while (s >= 0 && !starts(main[s])) s--;
    const ids = new Set();
    for (let j = s + 1; j <= i; j++) if (main[j].type === 'assistant') ids.add(main[j].message.id || main[j].uuid);
    // forward to the end of the turn
    const after = new Set();
    let j = i + 1;
    for (; j < main.length; j++) {
      const x = main[j];
      if (starts(x)) break;
      if (x.type === 'assistant') { const id = x.message.id || x.uuid; if (!ids.has(id)) after.add(id); }
    }
    out.push({ at: e.timestamp, hash: HASH_RE.exec(JSON.stringify(call.input))[1], toCard: ids.size, after: after.size });
  }
  // the card call and its answer can be split over several assistant entries with one message id: dedupe by call
  const seen = new Set();
  return out.filter(c => { const k = c.at + c.hash; if (seen.has(k)) return false; seen.add(k); return true; });
}

function seatTranscriptMetrics(ts) {
  const w = { turns: 0, plugin: 0, peer: 0, rewake: 0, rowNotifications: 0, humanPrompts: 0 };
  const chat = { notices: 0, pulls: 0, turns: 0, calls: 0 };
  const inj = { join: 0, total: 0, count: 0, byEvent: {} };
  const cards = [];
  for (const { es } of ts) {
    let pending = null; // a trigger waiting for its assistant message
    // chat: since the last turn end, did anything but chat rows arrive? (null: no turn open, 'chat': only chat)
    let since = 'other', chatIds = null;
    for (const e of es) {
      if (e.type === 'system' && e.subtype === 'turn_duration') { since = null; chatIds = null; continue; }
      if (isChatNotice(e)) { chat.notices++; if (since === null) since = 'chat'; continue; }
      if (isPull(e)) { chat.pulls++; if (since === null) since = 'chat'; continue; }
      // a queued prompt (a notification, a wake) starts the next turn, even when its user entry is written later
      if ((e.type === 'user' && !e.isSidechain && !isToolResult(e) && !isPull(e)) || (e.type === 'queue-operation' && e.operation === 'enqueue')) since = 'other';
      // Claude Code's own "No response requested." on --continue is no model call
      if (e.type === 'assistant' && !e.isSidechain && since === 'chat' && e.message.model !== '<synthetic>') {
        if (!chatIds) { chatIds = new Set(); chat.turns++; }
        const id = e.message.id || e.uuid;
        if (!chatIds.has(id)) { chatIds.add(id); chat.calls++; }
      }
      if (e.attachment && e.attachment.type === 'hook_additional_context') {
        const n = [].concat(e.attachment.content || []).join('\n').length;
        inj.total += n; inj.count++;
        const ev = e.attachment.hookEvent || '?';
        inj.byEvent[ev] = (inj.byEvent[ev] || 0) + n;
        if (ev === 'UserPromptExpansion') inj.join += n;
        continue;
      }
      if (e.isSidechain) continue;
      if (e.type === 'assistant') { if (pending) { w.turns++; pending = null; } continue; }
      // a peer delivery is written isMeta; any other meta entry is not a prompt
      if (e.type !== 'user' || (e.isMeta && !(e.origin && e.origin.kind === 'peer')) || isToolResult(e)) continue;
      const k = trigger(e);
      if (k) {
        w[k]++;
        pending = pending || k;
        continue;
      }
      pending = null; // a human prompt (or another notification) starts the next turn: not room-caused
      const kind = e.origin && e.origin.kind;
      if (kind === 'task-notification') w.rowNotifications++;
      else w.humanPrompts++;
    }
    cards.push(...cardTurns(es));
  }
  chat.callsPerBurst = chat.notices ? +(chat.calls / chat.notices).toFixed(2) : null;
  return { wakes: w, chat, injected: inj, cards };
}

/** A line drawn in a red foreground: SGR 31/91, 256-color reds, or a truecolor red. */
function isRed(line) {
  for (const m of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const p = m[1].split(';').map(Number);
    for (let i = 0; i < p.length; i++) {
      if (p[i] === 31 || p[i] === 91) return true;
      if (p[i] === 38 && p[i + 1] === 5) { if ([1, 9, 124, 160, 161, 196, 197, 203, 204, 210].includes(p[i + 2])) return true; i += 2; continue; }
      if (p[i] === 38 && p[i + 1] === 2) { const [r, g, b] = p.slice(i + 2, i + 5); if (r >= 200 && g <= 115 && b <= 140 && r - g >= 120) return true; i += 4; }
    }
  }
  return false;
}

function noiseFor(screens, index, seat) {
  const caps = index.filter(r => r.session === `sh-${seat}`);
  const n = { captures: caps.length, lines: 0, receipts: 0, red: 0 };
  for (const k of Object.keys(NOISE)) n[k] = 0;
  for (const r of caps) {
    let t = '';
    try { t = fs.readFileSync(path.join(screens, r.txt), 'utf8'); } catch { continue; }
    for (const l of t.split('\n')) {
      if (/Operation stopped by hook/.test(l)) n.receipts++;
      let hit = false;
      for (const [k, re] of Object.entries(NOISE)) if (re.test(l)) { n[k]++; hit = true; }
      if (hit) n.lines++;
    }
    let a = null;
    try { a = fs.readFileSync(path.join(screens, r.txt.replace(/\.txt$/, '.ansi')), 'utf8'); } catch { /* none */ }
    for (const l of (a || t).split('\n')) if ((a && isRed(l)) || /hook error/i.test(l.replace(/\x1b\[[0-9;]*m/g, ''))) n.red++;
  }
  n.perCapture = caps.length ? +(n.lines / caps.length).toFixed(2) : null;
  n.perCaptureExWaiting = caps.length ? +((n.lines - n.waiting) / caps.length).toFixed(2) : null;
  return n;
}

function measure({ screens, projects, home, code } = {}) {
  const index = screens ? readJson(path.join(screens, 'index.json'), []) : [];
  const times = index.map(r => r.time).filter(Boolean).sort();
  if (!times.length) return { error: `no captures in ${screens}` };
  // the run starts a little before the first capture (S1's /sub-human); stop 30 s after the last one
  const from = new Date(Date.parse(times[0]) - 120_000).toISOString();
  const to = new Date(Date.parse(times.at(-1)) + 30_000).toISOString();
  const orchSid = orchSession(home || process.env.SUB_HUMAN_HOME, code);
  const seats = {};
  const all = { lines: 0, captures: 0, waiting: 0, red: 0 };
  let wakes = 0;
  const cards = [];
  for (const seat of SEATS) {
    const ts = transcripts(seat, from, to, projects, orchSid);
    const m = seatTranscriptMetrics(ts);
    const noise = noiseFor(screens, index, seat);
    seats[seat] = { transcripts: ts.map(t => path.basename(t.file).slice(0, 8)), ...m, noise };
    wakes += m.wakes.turns;
    if (seat !== 'orch') cards.push(...m.cards.map(c => ({ seat, ...c })));
    all.lines += noise.lines; all.captures += noise.captures; all.waiting += noise.waiting; all.red += noise.red;
  }
  const kinds = Object.keys(NOISE);
  const sum = k => SEATS.reduce((a, s) => a + seats[s].noise[k], 0);
  const avg = k => (cards.length ? +(cards.reduce((a, c) => a + c[k], 0) / cards.length).toFixed(2) : null);
  return {
    window: { from, to },
    orchSession: orchSid,
    seats,
    total: {
      wakes,
      roomWakesMembers: seats.alice.wakes.turns + seats.bob.wakes.turns,
      pluginWakes: SEATS.reduce((a, s) => a + seats[s].wakes.plugin, 0),
      chat: (() => {
        const c = { notices: 0, pulls: 0, turns: 0, calls: 0 };
        for (const s of SEATS) for (const k of Object.keys(c)) c[k] += seats[s].chat[k];
        c.callsPerBurst = c.notices ? +(c.calls / c.notices).toFixed(2) : null;
        return c;
      })(),
      joinChars: SEATS.filter(s => s !== 'orch').map(s => seats[s].injected.join),
      injectedTotal: SEATS.reduce((a, s) => a + seats[s].injected.total, 0),
      cards: { count: cards.length, toCard: avg('toCard'), after: avg('after'), perCard: cards.length ? +(cards.reduce((a, c) => a + c.toCard + c.after, 0) / cards.length).toFixed(2) : null, list: cards },
      noise: {
        captures: all.captures, lines: all.lines,
        perCapture: all.captures ? +(all.lines / all.captures).toFixed(2) : null,
        perCaptureExWaiting: all.captures ? +((all.lines - all.waiting) / all.captures).toFixed(2) : null,
        ...Object.fromEntries(kinds.map(k => [k, sum(k)])),
        receipts: sum('receipts'),
        red: all.red,
      },
    },
  };
}

if (require.main === module) {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[++i];
  const screens = path.resolve(o.screens || path.join(__dirname, '..', 'docs/rebuild/screens'));
  process.stdout.write(JSON.stringify(measure({ screens, home: o.home || paths.demoHome() }), null, 1) + '\n');
}

module.exports = { measure, BASELINES, BASELINE, PHASE0, PREV, NOISE, trigger, isChatNotice, isPull, seatTranscriptMetrics, cardTurns, isRed };
