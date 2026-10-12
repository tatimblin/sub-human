#!/usr/bin/env node
'use strict';
/**
 * capture: record the demo's panes for the trailer: trailer/capture/<take>/capture.jsonl + run.json, the format the
 * trailer renderer reads (a hand-made sample: trailer/capture/fixture/).
 *
 *   capture.js start <dir> [--sessions alice=sh-alice,bob=sh-bob,claude=sh-claude] [--interval 100] [--take NAME]
 *                         (a frame's session is the key: demo.sh --film passes tristan=sh-tristan,jess=sh-jess,claude=sh-claude)
 *                         the poller (demo.sh --film runs it in the background): every --interval ms, `tmux capture-pane
 *                         -ep` of each session; a frame line only when that pane's text changed. A session not there
 *                         yet (sh-claude before S1) or gone for a moment is skipped. SIGTERM/SIGINT: a last poll, then
 *                         the file is finalised (meta first with every session's size and the room, then all lines by t)
 *   capture.js mark <scene> <beat> <caption>     a marker line in the active capture (none active: does nothing)
 *   capture.js scene <scene> start|ok|aborted [reason]   a scene's timing and status in the active take's run.json
 *   capture.js stop [--checks FILE]              stop the active poller and wait for it to finalise; with --checks,
 *                                                put that checks.json's verdict in run.json
 *
 * Lines (t = ms since the capture started, one monotonic clock across processes: process.hrtime):
 *   {"t":0,"kind":"meta","sessions":{"alice":{"cols":120,"rows":36},…},"room":"vole-8126"}
 *   {"t":1234,"kind":"frame","session":"alice","ansi":"<capture-pane -ep, rows joined by \n>"}
 *   {"t":1300,"kind":"marker","scene":"S4","beat":"plan","caption":"…"}
 *
 * The active capture is named in $CAPTURE_ACTIVE (default trailer/capture/.active.json): {dir, pid, t0}.
 * Env: SUB_HUMAN_HOME / SUB_HUMAN_ROOM for the room code (scripts/snap.js roomCode()).
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { readJson } = require('./lib/io.js');

const REPO = path.resolve(__dirname, '..');
const ACTIVE = () => process.env.CAPTURE_ACTIVE || path.join(REPO, 'trailer', 'capture', '.active.json');
const DEFAULT_SESSIONS = 'alice=sh-alice,bob=sh-bob,claude=sh-claude';

const now = () => process.hrtime.bigint();
const msSince = t0 => Number((now() - BigInt(t0)) / 1_000_000n);
const line = o => JSON.stringify(o) + '\n';
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1) + '\n'); fs.renameSync(f + '.tmp', f); };

/** "alice=sh-alice,bob=sh-bob" -> [['alice','sh-alice'], …] */
const parseSessions = s => String(s || DEFAULT_SESSIONS).split(',').filter(Boolean).map(x => { const [k, v] = x.split('='); return [k, v || `sh-${k}`]; });

function tmux(args) {
  return new Promise(resolve => execFile('tmux', args, { encoding: 'utf8', maxBuffer: 16 << 20 }, (err, out) => resolve(err ? null : out)));
}

/** One pane: {ansi, cols, rows}, or null when the session is not there. ansi has no trailing newline. */
async function grab(target) {
  const t = target.includes(':') ? target : `${target}:`;
  const [out, dims] = await Promise.all([tmux(['capture-pane', '-e', '-p', '-t', t]), tmux(['display-message', '-p', '-t', t, '#{pane_width} #{pane_height}'])]);
  if (out == null) return null;
  const [cols, rows] = String(dims || '').trim().split(' ').map(Number);
  return { ansi: out.replace(/\n$/, ''), cols: cols || 0, rows: rows || 0 };
}

/**
 * The poller's state machine, apart from tmux and timers (tests drive it): feed(name, pane) returns the frame line to
 * write or null (unchanged / no pane), and remembers each session's latest size.
 */
function framer() {
  const last = new Map(), sizes = {};
  return {
    sizes,
    feed(name, pane, t) {
      if (!pane) return null;
      sizes[name] = { cols: pane.cols, rows: pane.rows };
      if (last.get(name) === pane.ansi) return null;
      last.set(name, pane.ansi);
      return { t, kind: 'frame', session: name, ansi: pane.ansi };
    },
  };
}

/** Each line of a file, read in chunks (a long take is hundreds of MB: more than one JS string holds). */
function* fileLines(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  const buf = Buffer.alloc(1 << 20);
  let rest = Buffer.alloc(0), n;
  try {
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      let chunk = Buffer.concat([rest, buf.subarray(0, n)]), i;
      while ((i = chunk.indexOf(10)) >= 0) { yield chunk.subarray(0, i).toString('utf8'); chunk = chunk.subarray(i + 1); }
      rest = Buffer.from(chunk);
    }
    if (rest.length) yield rest.toString('utf8');
  } finally { fs.closeSync(fd); }
}

/** Rewrite a capture file: one meta line first (t 0), then every other line sorted by t (stable). Torn lines dropped. */
function finalise(file, meta) {
  const kept = []; // [t, kind, raw line]
  let prevMeta = {};
  for (const l of fileLines(file)) {
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; } // torn
    if (o.kind === 'meta') { prevMeta = o; continue; }
    kept.push([+o.t || 0, o.kind, l]);
  }
  const order = kept.map((k, i) => i).sort((a, b) => kept[a][0] - kept[b][0] || a - b);
  const m = { t: 0, kind: 'meta', sessions: { ...(prevMeta.sessions || {}), ...(meta.sessions || {}) }, room: meta.room || prevMeta.room || null };
  for (const k of Object.keys(meta)) if (!(k in m)) m[k] = meta[k];
  const fd = fs.openSync(file + '.tmp', 'w');
  try {
    fs.writeSync(fd, line(m));
    for (const i of order) fs.writeSync(fd, kept[i][2] + '\n');
  } finally { fs.closeSync(fd); }
  fs.renameSync(file + '.tmp', file);
  return { lines: kept.length + 1, frames: kept.filter(k => k[1] === 'frame').length, markers: kept.filter(k => k[1] === 'marker').length };
}

function roomNow() {
  try { return require('./snap.js').roomCode() || null; } catch { return null; }
}

async function start(o) {
  const dir = path.resolve(o._[0] || '');
  if (!o._[0]) throw new Error('capture.js start <dir>');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'capture.jsonl');
  const sessions = parseSessions(o.sessions);
  const interval = +(o.interval || 100);
  const t0 = String(now());
  fs.writeFileSync(file, line({ t: 0, kind: 'meta', sessions: {}, room: null }));
  const take = o.take || path.basename(dir);
  writeJson(path.join(dir, 'run.json'), { take, started: new Date().toISOString(), interval, sessions: Object.fromEntries(sessions), scenes: [] });
  writeJson(ACTIVE(), { dir, pid: process.pid, t0 });
  const fr = framer();
  let stopping = false, busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const t = msSince(t0);
      const panes = await Promise.all(sessions.map(([, s]) => grab(s)));
      const out = sessions.map(([name], i) => fr.feed(name, panes[i], t)).filter(Boolean);
      if (out.length) fs.appendFileSync(file, out.map(line).join(''));
    } finally { busy = false; }
  };
  const timer = setInterval(() => { poll().catch(() => {}); }, interval);
  await poll();
  const finish = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    while (busy) await new Promise(r => setTimeout(r, 20));
    await poll();
    const n = finalise(file, { sessions: fr.sizes, room: roomNow() });
    const run = readJson(path.join(dir, 'run.json'), {});
    writeJson(path.join(dir, 'run.json'), { ...run, ended: new Date().toISOString(), durationMs: msSince(t0), room: roomNow(), counts: n });
    const a = readJson(ACTIVE(), null);
    if (a && a.pid === process.pid) fs.rmSync(ACTIVE(), { force: true });
    process.stderr.write(`capture: ${n.frames} frames, ${n.markers} markers -> ${path.relative(process.cwd(), file)}\n`);
    process.exit(0);
  };
  process.on('SIGTERM', finish);
  process.on('SIGINT', finish);
  return new Promise(() => {}); // runs until signalled
}

/** The active capture ({dir, pid, t0}) or null (none, or its poller is gone). */
function active() {
  const a = readJson(ACTIVE(), null);
  if (!a || !a.dir || !a.t0) return null;
  try { process.kill(a.pid, 0); } catch { return null; }
  return a;
}

function mark(o) {
  const a = active();
  if (!a) return 0;
  const [scene, beat, ...cap] = o._;
  fs.appendFileSync(path.join(a.dir, 'capture.jsonl'), line({ t: msSince(a.t0), kind: 'marker', scene: scene || '', beat: beat || '', caption: cap.join(' ') }));
  return 0;
}

function scene(o) {
  const a = active();
  if (!a) return 0;
  const [name, status, ...why] = o._;
  const f = path.join(a.dir, 'run.json');
  const run = readJson(f, {});
  const scenes = Array.isArray(run.scenes) ? run.scenes : [];
  const t = msSince(a.t0);
  if (status === 'start') scenes.push({ scene: name, startT: t, started: new Date().toISOString() });
  else {
    const s = scenes.filter(x => x.scene === name).at(-1) || (scenes.push({ scene: name }), scenes.at(-1));
    Object.assign(s, { endT: t, ended: new Date().toISOString(), status }, why.length ? { reason: why.join(' ') } : {});
  }
  writeJson(f, { ...run, scenes });
  return 0;
}

/** checks.json -> {summary, failed: [SCENE: check]} for run.json */
function verdict(checks) {
  const c = readJson(checks, null);
  if (!c) return { error: `no checks at ${checks}` };
  const failed = [];
  for (const [k, list] of Object.entries(c)) if (!k.startsWith('_') && Array.isArray(list)) for (const x of list) if (x.status === 'fail') failed.push(`${k}: ${x.check}`);
  return { summary: (c._meta || {}).summary || null, failed, pass: failed.length === 0 };
}

async function stop(o) {
  const a = readJson(ACTIVE(), null);
  if (a && a.pid) {
    try { process.kill(a.pid, 'SIGTERM'); } catch { /* gone */ }
    // done when the poller has removed the active file (its last step) or is gone; up to 2 min: finalising a long
    // take rewrites it. (An exited poller can linger as a zombie until its parent reaps it: the file says it is done.)
    const live = () => { try { process.kill(a.pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 1200 && live() && (readJson(ACTIVE(), {}) || {}).pid === a.pid; i++) await new Promise(r => setTimeout(r, 100));
  }
  const dir = o.dir ? path.resolve(o.dir) : a && a.dir;
  if (o.checks && dir) {
    const f = path.join(dir, 'run.json');
    writeJson(f, { ...readJson(f, {}), checks: verdict(path.resolve(o.checks)) });
  }
  return 0;
}

function opts(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) o[args[i].slice(2)] = args[++i]; else o._.push(args[i]);
  }
  return o;
}

const COMMANDS = { start, mark, scene, stop };

async function main(argv = process.argv.slice(2)) {
  const [cmd, ...args] = argv;
  if (!Object.hasOwn(COMMANDS, cmd || '')) { process.stderr.write('see the header of scripts/capture.js for usage\n'); return 2; }
  return COMMANDS[cmd](opts(args));
}

if (require.main === module) main().then(c => process.exit(c), e => { process.stderr.write(`capture: ${e.message}\n`); process.exit(2); });

module.exports = { framer, finalise, parseSessions, verdict, grab, main };
