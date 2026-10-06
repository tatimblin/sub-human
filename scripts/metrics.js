#!/usr/bin/env node
'use strict';
/**
 * metrics: per-seat cost-of-the-room measurements for one demo run, from evidence only.
 *
 *   node scripts/metrics.js [--screens DIR]     print the run's metrics as JSON
 *   require('./metrics.js').measure({screens})  same, as an object (used by checks.js)
 *
 * The run window is the first..last capture in screens/index.json (+30 s); a seat's transcripts are the
 * top-level ~/.claude/projects/-private-tmp-sh-demo-SEAT/*.jsonl files with entries inside it (read-only).
 *
 * - wakes: room-caused model turns: a user entry that is a sub-human Monitor event (origin.kind
 *   task-notification, "Monitor event: …sub-human…"), a peer delivery (origin.kind peer), or the
 *   row-rewake wake (its stderr text "sub-human: this session was resumed…"), followed in file order by an
 *   assistant message before the next user prompt. Adjacent triggers that start one turn count once.
 *   `notices` counts the Monitor-event entries themselves (the vole-8126 baseline counted these: 39).
 * - injected: chars of hook additionalContext the seat's model received: `join` (UserPromptExpansion, the
 *   /sub-human join block), `total` (every hook_additional_context attachment, incl. restores and digests).
 * - noise: UI lines per capture of the seat's pane: "Monitor event", "Waiting for N background agents",
 *   "hook error", "blocked by hook", "Invalid tool parameters"; `perCapture` = all of them / captures,
 *   `perCaptureExWaiting` without "Waiting for". "Operation stopped by hook" (the @room receipt) is counted
 *   apart as `receipts`, not noise.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SEATS = ['orch', 'alice', 'bob'];
const NOISE = {
  monitor: /Monitor event/,
  waiting: /Waiting for \d+ background agents?/,
  hookError: /hook error/i,
  blocked: /blocked by hook/i,
  invalid: /Invalid tool parameters/,
};
const REWAKE = 'sub-human: this session was resumed';

/** vole-8126 (commit e83ffb5), recomputed with this file from its 69 captures and the seats' transcripts. */
const BASELINE = {
  run: 'vole-8126',
  wakes: { orch: 12, alice: 17, bob: 10, total: 39 },
  noise: { captures: 69, lines: 320, perCapture: 4.64, perCaptureExWaiting: 2.33, monitor: 145, waiting: 159, hookError: 5, blocked: 6, invalid: 5 },
  joinChars: { orch: 7662, alice: 5732, bob: 5768 },
  injected: { orch: 7782, alice: 12987, bob: 13542, total: 34311 },
};

const jsonl = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && (x.text || (typeof x.content === 'string' ? x.content : ''))) || '').join('\n') : '');
const isToolResult = e => Array.isArray(e.message && e.message.content) && e.message.content.length > 0 && e.message.content.every(c => c && c.type === 'tool_result');

function transcripts(seat, from, to, projects) {
  const dir = path.join(projects || path.join(os.homedir(), '.claude', 'projects'), `-private-tmp-sh-demo-${seat}`);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)); } catch { return []; }
  return files.map(f => ({ file: f, es: jsonl(f) })).filter(({ es }) => es.some(e => e.timestamp && e.timestamp >= from && e.timestamp <= to))
    .map(t => ({ ...t, es: t.es.filter(e => !e.timestamp || (e.timestamp >= from && e.timestamp <= to)) }));
}

/** kind of room trigger a user entry is, or null */
function trigger(e) {
  if (e.type !== 'user' || isToolResult(e)) return null;
  const k = e.origin && e.origin.kind;
  const t = textOf(e.message && e.message.content);
  if (k === 'peer') return 'peer';
  if (t.includes(REWAKE)) return 'rewake';
  if (k === 'task-notification' && /Monitor event:[^\n]*sub-human/.test(t)) return 'monitor';
  return null;
}

function seatTranscriptMetrics(ts) {
  const w = { turns: 0, notices: 0, peer: 0, rewake: 0, rowNotifications: 0, humanPrompts: 0 };
  const inj = { join: 0, total: 0, count: 0, byEvent: {} };
  for (const { es } of ts) {
    let pending = null; // a trigger waiting for its assistant message
    for (const e of es) {
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
      if (e.type !== 'user' || e.isMeta || isToolResult(e)) continue;
      const k = trigger(e);
      if (k) {
        if (k === 'monitor') w.notices++; else w[k]++;
        pending = pending || k;
        continue;
      }
      pending = null; // a human prompt (or another notification) starts the next turn: not room-caused
      const kind = e.origin && e.origin.kind;
      if (kind === 'task-notification') w.rowNotifications++;
      else w.humanPrompts++;
    }
  }
  return { wakes: w, injected: inj };
}

function noiseFor(screens, index, seat) {
  const caps = index.filter(r => r.session === `sh-${seat}`);
  const n = { captures: caps.length, lines: 0, receipts: 0 };
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
  }
  n.perCapture = caps.length ? +(n.lines / caps.length).toFixed(2) : null;
  n.perCaptureExWaiting = caps.length ? +((n.lines - n.waiting) / caps.length).toFixed(2) : null;
  return n;
}

function measure({ screens, projects } = {}) {
  const index = (() => { try { return JSON.parse(fs.readFileSync(path.join(screens, 'index.json'), 'utf8')); } catch { return []; } })();
  const times = index.map(r => r.time).filter(Boolean).sort();
  if (!times.length) return { error: `no captures in ${screens}` };
  // the run starts a little before the first capture (S1's /sub-human); stop 30 s after the last one
  const from = new Date(Date.parse(times[0]) - 120_000).toISOString();
  const to = new Date(Date.parse(times.at(-1)) + 30_000).toISOString();
  const seats = {};
  const all = { lines: 0, captures: 0, waiting: 0 };
  let wakes = 0;
  for (const seat of SEATS) {
    const ts = transcripts(seat, from, to, projects);
    const m = seatTranscriptMetrics(ts);
    const noise = noiseFor(screens, index, seat);
    seats[seat] = { transcripts: ts.map(t => path.basename(t.file).slice(0, 8)), ...m, noise };
    wakes += m.wakes.turns;
    all.lines += noise.lines; all.captures += noise.captures; all.waiting += noise.waiting;
  }
  const kinds = Object.keys(NOISE);
  const sum = k => SEATS.reduce((a, s) => a + seats[s].noise[k], 0);
  return {
    window: { from, to },
    seats,
    total: {
      wakes,
      notices: SEATS.reduce((a, s) => a + seats[s].wakes.notices, 0),
      joinChars: SEATS.filter(s => s !== 'orch').map(s => seats[s].injected.join),
      injectedTotal: SEATS.reduce((a, s) => a + seats[s].injected.total, 0),
      noise: {
        captures: all.captures, lines: all.lines,
        perCapture: all.captures ? +(all.lines / all.captures).toFixed(2) : null,
        perCaptureExWaiting: all.captures ? +((all.lines - all.waiting) / all.captures).toFixed(2) : null,
        ...Object.fromEntries(kinds.map(k => [k, sum(k)])),
        receipts: sum('receipts'),
      },
    },
  };
}

if (require.main === module) {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[++i];
  const screens = path.resolve(o.screens || path.join(__dirname, '..', 'docs/rebuild/screens'));
  process.stdout.write(JSON.stringify(measure({ screens }), null, 1) + '\n');
}

module.exports = { measure, BASELINE, NOISE, trigger, seatTranscriptMetrics };
