#!/usr/bin/env node
'use strict';
/**
 * demo-lib: tmux + room-log helpers for scripts/demo.sh (no jq, no deps).
 *
 *   demo-lib.js type  <session> <text>            type text (paste-buffer, never send-keys -l)
 *   demo-lib.js keys  <session> <Key>…            Enter Esc Up Down Left Right Tab Space BSpace C-c C-d
 *   demo-lib.js literal <session> <text>          type text as keystrokes (send-keys -l): for form text boxes
 *   demo-lib.js submit <session> <text>           type text, Enter; for a "/command", Enter again if the
 *                                                  picker swallowed the first Enter
 *   demo-lib.js select-row <session> <label> [--key Down|Up]   move the agent-panel cursor (❯) onto the
 *                                                  row labelled <label> (└ children too), one key at a time
 *   demo-lib.js ready <session> [--timeout S]     handle the trust dialog (choose "Yes, I trust this folder"
 *                                                  explicitly), then wait for the prompt
 *   demo-lib.js wait-pane <session> <regex> [--timeout S] [--absent] [--what TEXT]
 *   demo-lib.js wait-room [--timeout S]           wait for a room dir; prints the code
 *   demo-lib.js wait-log --kind K [--from N] [--via V] [--count N] [--latest-plan] [--after ID]
 *                        [--text-has S] [--timeout S] [--what TEXT]
 *   demo-lib.js approve-until <session> --kind K [wait-log filters] [--timeout S]
 *                        play the seat's human while its Claude works: answer each permission dialog
 *                        with option 2 ("Yes, and …" for the session; else 1. Yes) until the log matches;
 *                        with --quiet S, then keep at it until its background agents are done (only the room
 *                        row left in its panel) and no dialog has shown for S seconds
 *   demo-lib.js wait-holds <seat> <name> [--timeout S]   wait until <seat>'s room server holds <name>'s row
 *                                                  (rows/holds-<seat>.json, fresh)
 *   demo-lib.js member-field <name> <field>       print members.json[name][field] ('' if none)
 *   demo-lib.js wait-member <name> <field> --not V [--timeout S]   wait until that field differs from V
 *   demo-lib.js count --kind K [same filters]     print the count now
 *   demo-lib.js last-id --kind K [same filters]   print the id of the last matching entry (0 if none)
 *   demo-lib.js log-max                           print the highest log id
 *   demo-lib.js latest-plan                       print the latest plan_rev hash
 *   demo-lib.js readonly <session>                exit 0 if a read-only client is attached
 *   demo-lib.js wait-idle <session> [--timeout S] [--quiet S]   wait until the main prompt is idle (no
 *                                                  "esc to interrupt" and the pane unchanged for --quiet S, 3)
 *   demo-lib.js card <session> <Not yet|Agree|Object> [note]   answer the open proposal: in the plan view (Agree =
 *                                                  the "Yes" that keeps the seat's mode, Object = "Tell Claude what
 *                                                  to change" + note, Not yet = Esc) or, the fallback, on the card
 *   demo-lib.js wait-native-task <subject> [--timeout S]   wait until the orch's native list has it
 *   demo-lib.js wait-tasks [--owner N] [--id N] [--status S] [--timeout S]   wait on <room>/tasks.json
 *   demo-lib.js task-id --owner N                 print the id of N's newest task in <room>/tasks.json
 *   demo-lib.js wait-orch-idle [--after ID] [--timeout S]   wait until the orch's transcript has an
 *                                                  end_turn after log entry ID and 6 s of quiet
 *   demo-lib.js orch-transcript                   print the orch session's transcript path
 *   demo-lib.js synthetic-gate <id>               run hooks/tasks.js as the orch's TaskCompleted for task <id> over the
 *                                                  real log; print {status, stderr} (exit 2 = refused)
 *   demo-lib.js synthetic-orch-prompt             run hooks/at-room.js as the orch's UserPromptSubmit (shim stdin) for a
 *                                                  typed "hi" (CLAUDE_PID = the orch's pid); print its output
 *
 * Every wait appends {scene, what, ok, ms, time} to $SNAP_DIR/waits.jsonl (scene from $DEMO_SCENE)
 * and exits 1 on timeout (demo.sh's `need` aborts the scene on it; `settle` and evidence waits go on). --timeout 0 waits with no
 * limit (a person's own step in --human mode), printing a reminder every minute.
 *
 * Keys: when a read-only client is attached (ours or anyone's), tmux may refuse send-keys ("client is
 * read-only": it checks the best client it can find, even one on another session). So keys go through a writable helper client attached to a tiny
 * separate session (sh-keys) and `send-keys -c <helper> -t <pane>`. Raw paste-buffer bytes are no
 * substitute: Claude Code's form text fields take pasted escape sequences literally.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { roomCode, readLog, strip } = require('./snap.js');
const paths = require('./lib/paths.js');
const { panelRows, cardState, planState } = require('./lib/panes.js');

const REPO = paths.REPO;
const SNAP_DIR = process.env.SNAP_DIR ? path.resolve(process.env.SNAP_DIR) : path.join(REPO, 'docs/rebuild/screens');

const tmux = (...a) => execFileSync('tmux', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tgt = s => (s.includes(':') ? s : `${s}:`);

const KEY_BYTES = {
  Enter: '\r', Esc: '\x1b', Escape: '\x1b', Tab: '\t', BTab: '\x1b[Z', Space: ' ', BSpace: '\x7f',
  Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D', 'C-c': '\x03', 'C-d': '\x04', 'C-j': '\n',
  'C-u': '\x15', 'C-l': '\x0c', PageDown: '\x1b[6~', PageUp: '\x1b[5~',
};
const SEND_KEYS = { Esc: 'Escape', Space: 'Space', BSpace: 'BSpace', BTab: 'BTab' };

function readonlyAttached(session) {
  try { return tmux('list-clients', '-t', session, '-F', '#{client_readonly}').split('\n').some(l => l.trim() === '1'); } catch { return false; }
}

let bufN = 0;
function pasteRaw(session, bytes) {
  const buf = `shdemo-${process.pid}-${bufN++}`;
  tmux('set-buffer', '-b', buf, '--', bytes);
  // -r: keep LF as LF (default turns LF into CR); -d: delete the buffer afterwards
  tmux('paste-buffer', '-r', '-d', '-b', buf, '-t', tgt(session));
}

function typeText(session, text) { pasteRaw(session, text); }

const KEYS_SESSION = 'sh-keys';
function writableClient(session) {
  try { return tmux('list-clients', '-t', session, '-F', '#{client_name} #{client_readonly}').split('\n').map(l => l.trim().split(' ')).find(([n, ro]) => n && ro === '0')?.[0] || null; } catch { return null; }
}
async function helperClient() {
  let c = writableClient(KEYS_SESSION);
  if (c) return c;
  try { tmux('has-session', '-t', KEYS_SESSION); } catch { tmux('new-session', '-d', '-s', KEYS_SESSION, '-x', '20', '-y', '5', 'sleep 1000000'); }
  // a writable client needs a tty: script(1) gives it one; stdin is a pipe that never sends a byte
  spawn('sh', ['-c', `sleep 1000000 | script -q /dev/null tmux attach -t ${KEYS_SESSION} >/dev/null 2>&1`], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30 && !(c = writableClient(KEYS_SESSION)); i++) await sleep(100);
  if (!c) throw new Error('could not attach the sh-keys helper client');
  return c;
}

async function keys(session, list, gap = 120) {
  // always via the helper: with no writable client anywhere tmux falls back to some read-only one
  const via = ['-c', await helperClient()];
  for (const k of list) {
    if (!(k in KEY_BYTES) && k.length !== 1) throw new Error(`unknown key ${k}`);
    tmux('send-keys', ...via, '-t', tgt(session), SEND_KEYS[k] || k);
    await sleep(k === 'Esc' || k === 'Escape' ? 400 : gap); // a lone ESC needs a pause or it merges with the next key
  }
}

async function literal(session, text) {
  tmux('send-keys', '-c', await helperClient(), '-l', '-t', tgt(session), '--', text);
}

function pane(session) { return strip(tmux('capture-pane', '-p', '-J', '-t', tgt(session))); }

function record(what, ok, ms) {
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    fs.appendFileSync(path.join(SNAP_DIR, 'waits.jsonl'), JSON.stringify({ scene: process.env.DEMO_SCENE || '', what, ok, ms, time: new Date().toISOString() }) + '\n');
  } catch { /* best effort */ }
}

async function until(what, timeoutS, fn) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch { v = false; }
    if (v) { record(what, true, Date.now() - t0); process.stderr.write(`  ✓ ${what} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`); return v; }
    if (timeoutS > 0 && Date.now() - t0 > timeoutS * 1000) { record(what, false, Date.now() - t0); process.stderr.write(`  ✗ timeout ${timeoutS}s: ${what}\n`); return false; }
    if (!(timeoutS > 0) && Date.now() - (until.nudged || t0) > 60_000) {
      until.nudged = Date.now();
      process.stderr.write(`  … still waiting for you (${Math.round((Date.now() - t0) / 60_000)} min, no time limit): ${what}\n`);
    }
    await sleep(700);
  }
}


const HOME_DIR = paths.home;
const roomFile = f => path.join(HOME_DIR(), 'rooms', roomCode() || '-', f);
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function orchTranscript() {
  const o = readJ(roomFile('members.json'), {}).orch || {};
  if (!o.session_id) return null;
  const proj = paths.projectsDir();
  for (const d of fs.readdirSync(proj)) {
    const f = path.join(proj, d, `${o.session_id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
function readJsonl(f) {
  try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
function filterLog(o) {
  const code = roomCode();
  let es = readLog(code);
  if (o.after != null) es = es.filter(e => e.id > +o.after);
  if (o.kind) { const ks = o.kind.split(','); es = es.filter(e => ks.includes(e.kind)); }
  if (o.from) es = es.filter(e => e.from === o.from);
  if (o.via) es = es.filter(e => e.via === o.via);
  if (o['text-has']) es = es.filter(e => String(e.text || '').includes(o['text-has']));
  if (o['latest-plan']) {
    const lp = readLog(code).filter(e => e.kind === 'plan_rev' && e.plan_hash).at(-1);
    es = lp ? es.filter(e => e.plan_hash === lp.plan_hash) : [];
  }
  return es;
}

function opts(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['absent', 'latest-plan'].includes(k)) o[k] = true; else o[k] = args[++i];
    } else o._.push(a);
  }
  return o;
}

async function ready(session, timeoutS) {
  const t0 = Date.now();
  let trusted = false;
  while (Date.now() - t0 < timeoutS * 1000) {
    const p = pane(session);
    if (/trust this folder/i.test(p) && /Yes, I trust this folder/.test(p)) {
      const lines = p.split('\n');
      const cur = lines.findIndex(l => /^\s*❯/.test(l));
      const yes = lines.findIndex(l => /Yes, I trust this folder/.test(l));
      if (cur === yes) { await keys(session, ['Enter']); trusted = true; process.stderr.write('  ✓ trust dialog: chose "Yes, I trust this folder"\n'); await sleep(1500); continue; }
      await keys(session, [cur >= 0 && cur > yes ? 'Up' : 'Down']);
      await sleep(300);
      continue;
    }
    // any other first-run dialog is never answered blindly: we just time out and report it
    if (/❯/.test(p) && /(for shortcuts|mode on|shift\+tab|\? for|Try ")/i.test(p)) {
      record(`${session} ready${trusted ? ' (trusted)' : ''}`, true, Date.now() - t0);
      return true;
    }
    await sleep(700);
  }
  record(`${session} ready`, false, Date.now() - t0);
  process.stderr.write(`  ✗ ${session}: prompt not ready after ${timeoutS}s\n`);
  return false;
}

async function submit(session, text) {
  typeText(session, text);
  await sleep(500);
  await keys(session, ['Enter']);
  if (!text.startsWith('/')) return;
  // the slash picker may take the first Enter as "accept completion": check the input line
  await sleep(1200);
  const cmd = text.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // the input line is the ❯ line right under a ──── rule (submitted prompts also show as ❯ lines)
  const p = pane(session).split('\n');
  const input = p.filter((l, i) => /^\s*❯/.test(l) && i > 0 && /^\s*─{10,}/.test(p[i - 1])).at(-1) || '';
  if (new RegExp(`❯\\s*${cmd}`).test(input)) await keys(session, ['Enter']);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = opts(rest);
  const T = o.timeout == null ? 60 : +o.timeout; // 0 = no limit
  switch (cmd) {
    case 'type': typeText(o._[0], o._.slice(1).join(' ')); return 0;
    case 'keys': await keys(o._[0], o._.slice(1)); return 0;
    case 'literal': await literal(o._[0], o._.slice(1).join(' ')); return 0;
    case 'submit': await submit(o._[0], o._.slice(1).join(' ')); return 0;
    case 'select-row': {
      const label = o._[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^❯\\s+(└\\s*)?[⏺◯●]\\s+${label}(\\s|$)`, 'm');
      for (let i = 0; i < 8; i++) {
        if (re.test(pane(o._[0]))) { record(`${o._[0]}: panel cursor on ${o._[1]}`, true, 0); return 0; }
        await keys(o._[0], [o.key || 'Down']);
        await sleep(700);
      }
      record(`${o._[0]}: panel cursor on ${o._[1]}`, false, 0);
      process.stderr.write(`  ✗ ${o._[0]}: could not select the ${o._[1]} row\n`);
      return 1;
    }
    case 'ready': return (await ready(o._[0], T)) ? 0 : 1;
    case 'readonly': return readonlyAttached(o._[0]) ? 0 : 1;
    case 'pane': process.stdout.write(pane(o._[0])); return 0;
    case 'wait-pane': {
      const re = new RegExp(o._[1], 'm');
      const what = o.what || `${o._[0]} pane ${o.absent ? '!~' : '~'} /${o._[1]}/`;
      return (await until(what, T, () => (o.absent ? !re.test(pane(o._[0])) : re.test(pane(o._[0]))))) ? 0 : 1;
    }
    case 'wait-room': {
      const code = await until('room dir exists', T, () => roomCode());
      if (code) process.stdout.write(code + '\n');
      return code ? 0 : 1;
    }
    case 'wait-log': {
      const n = +(o.count || 1);
      const what = o.what || `log: ${n}× ${o.kind}${o.from ? ` from ${o.from}` : ''}${o.via ? ` via=${o.via}` : ''}${o['latest-plan'] ? ' on latest plan' : ''}`;
      return (await until(what, T, () => filterLog(o).length >= n)) ? 0 : 1;
    }
    case 'approve-until': {
      const n = +(o.count || 1);
      const what = o.what || `${o._[0]}: approve its Claude's permission dialogs until ${n}× ${o.kind}${o.from ? ` from ${o.from}` : ''}`;
      let approvals = 0, last = 0, met = 0, calm = 0;
      const quietMs = +(o.quiet || 0) * 1000;
      const ok = await until(what + (quietMs ? `, then its background agents finish` : ''), T, () => {
        const p = pane(o._[0]);
        if (!met && filterLog(o).length >= n) met = Date.now();
        if (met && !quietMs) return true;
        if (met) {
          const busy = /Do you want to /.test(p) || panelRows(p).some(r => !r.nested && r.label !== roomCode());
          if (busy) calm = 0; else if (!calm) calm = Date.now();
          if (calm && Date.now() - calm >= quietMs) return true;
        }
        const m = /Do you want to ([^\n?]*)\?/.exec(p);
        if (m && /❯\s*1\. Yes/.test(p) && Date.now() - last > 2500) {
          last = Date.now();
          const two = /^\s*2\. Yes, (and|allow)/m.test(p);
          approvals++;
          record(`${o._[0]}: human approved "${m[1].trim().slice(0, 80)}" (${two ? '2. Yes, and…' : '1. Yes'})`, true, 0);
          // fire and forget; the next poll sees the result
          keys(o._[0], two ? ['Down', 'Enter'] : ['Enter']).catch(() => {});
        }
        return false;
      });
      process.stderr.write(`  (${approvals} permission dialog${approvals === 1 ? '' : 's'} approved)\n`);
      return ok ? 0 : 1;
    }
    case 'wait-holds': {
      const f = () => roomFile(path.join('rows', `holds-${o._[0]}.json`));
      const ok = await until(o.what || `${o._[0]}'s room holds ${o._[1]}'s row`, T, () => {
        const h = JSON.parse(fs.readFileSync(f(), 'utf8'));
        return Date.now() - Date.parse(h.at) < 90_000 && (h.members || []).includes(o._[1]);
      });
      return ok ? 0 : 1;
    }
    case 'member-field': {
      const ms = JSON.parse(fs.readFileSync(roomFile('members.json'), 'utf8'));
      process.stdout.write(String((ms[o._[0]] || {})[o._[1]] ?? '') + '\n');
      return 0;
    }
    case 'wait-member': {
      const f = () => roomFile('members.json');
      const ok = await until(o.what || `${o._[0]}'s ${o._[1]} changes`, T, () => {
        const v = (JSON.parse(fs.readFileSync(f(), 'utf8'))[o._[0]] || {})[o._[1]];
        return v != null && String(v) !== String(o.not);
      });
      return ok ? 0 : 1;
    }

    case 'wait-idle': {
      const quiet = (o.quiet == null ? 3 : +o.quiet) * 1000;
      let last = null, since = 0;
      const ok = await until(o.what || `${o._[0]} idle`, T, () => {
        const p = pane(o._[0]);
        // the scripted human declines unplanned work: a permission dialog gets Esc (recorded in waits.jsonl)
        if (/Do you want to proceed\?|Do you want to (make this edit|create)/.test(p) && /Esc to cancel/.test(p)) {
          record(`${o._[0]}: the human declined a permission dialog (Esc): ${(/^\s*(\S.*)\n\s*Run shell command|Do you want to [^\n]*/m.exec(p) || [''])[0].trim().slice(0, 80)}`, true, 0);
          keys(o._[0], ['Esc']).catch(() => {});
          last = null; return false;
        }
        const busy = /esc to interrupt/.test(p) || cardState(p) || planState(p);
        const body = p.replace(/\d+[smh]\b|[✻✶✳✢·✽*]/g, '');
        if (busy || body !== last) { last = body; since = Date.now(); return false; }
        return Date.now() - since >= quiet;
      });
      return ok ? 0 : 1;
    }
    case 'card': {
      const [session, choice, ...noteParts] = o._;
      const note = noteParts.join(' ');
      if (!(await until(`${session}: proposal open (plan view or card)`, T, () => planState(pane(session)) || cardState(pane(session))))) return 1;
      await sleep(1200);
      const pv = planState(pane(session));
      if (pv) {
        if (choice === 'Not yet') { await keys(session, ['Escape']); record(`${session}: closed the plan view (Esc)`, true, 0); return 0; }
        // read it all, as a person would: PgDn to the end, where the hook's line names the proposal and the "Yes" that keeps the mode
        for (let i = 0; i < 40 && !/room proposal [0-9a-f]{12}/.test(pane(session)); i++) { await keys(session, ['PageDown']); await sleep(250); }
        const keep = (/Agree: "([^"]+)" keeps/.exec(pane(session).replace(/\s*\n\s*│?\s*/g, ' ')) || [])[1];
        const want = choice === 'Agree'
          ? pv.opts.find(x => x.label === keep) || pv.opts.find(x => /^Yes/.test(x.label))
          : pv.opts.find(x => /Tell Claude what to change|No, keep planning/.test(x.label));
        if (!want) { process.stderr.write(`no option for ${choice}\n`); return 1; }
        for (let i = 0; i < 6; i++) {
          const cur = (planState(pane(session)) || pv).opts.find(x => x.cur);
          if (!cur || cur.n === want.n) break;
          await keys(session, [cur.n < want.n ? 'Down' : 'Up']);
          await sleep(300);
        }
        if (choice === 'Object') { await literal(session, note || 'object'); await sleep(600); }
        await keys(session, ['Enter']);
        await sleep(1500);
        record(`${session}: answered in the plan view ${choice}${choice === 'Object' ? ` with note "${note}"` : ` (${want.label})`}`, true, 0);
        return 0;
      }
      let st = cardState(pane(session));
      const want = st.opts.find(x => x.label === choice);
      if (!want) { process.stderr.write(`no option ${choice}\n`); return 1; }
      for (let i = 0; i < 6; i++) {
        st = cardState(pane(session));
        const cur = st && st.opts.find(x => x.cur);
        if (!cur || cur.label === choice) break;
        await keys(session, [cur.n < want.n ? 'Down' : 'Up']);
        await sleep(300);
      }
      if (note) {
        await keys(session, ['n']);
        await sleep(800);
        await literal(session, note);
        await sleep(600);
      }
      await keys(session, ['Enter']);
      await sleep(1500);
      // a review step ("Submit answers") takes one more Enter
      const p = pane(session);
      if (/Submit answers|Review your answers/i.test(p) && /❯\s*1\.\s*Submit/.test(p)) { await keys(session, ['Enter']); await sleep(800); }
      record(`${session}: answered the card ${choice}${note ? ` with note "${note}"` : ''}`, true, 0);
      return 0;
    }
    case 'wait-native-task': {
      const subj = o._[0];
      const ok = await until(o.what || `orch's native list has "${subj}"`, T, () => {
        const dir = paths.tasksDir(roomCode());
        return fs.readdirSync(dir).filter(f => f.endsWith('.json')).some(f => (readJ(path.join(dir, f), {}) || {}).subject === subj);
      });
      return ok ? 0 : 1;
    }
    case 'wait-tasks': {
      const ok = await until(o.what || `tasks.json has a task${o.id ? ' #' + o.id : ''}${o.owner ? ' owned by ' + o.owner : ''}${o.status ? ' ' + o.status : ''}`, T, () =>
        (readJ(roomFile('tasks.json'), []) || []).some(t => (!o.id || String(t.id) === String(o.id)) && (!o.owner || t.owner === o.owner) && (!o.status || t.status === o.status)));
      return ok ? 0 : 1;
    }
    case 'task-id': {
      const t = (readJ(roomFile('tasks.json'), []) || []).filter(x => !o.owner || x.owner === o.owner).at(-1);
      process.stdout.write((t ? t.id : '') + '\n');
      return t ? 0 : 1;
    }
    case 'orch-transcript': { const f = orchTranscript(); process.stdout.write((f || '') + '\n'); return f ? 0 : 1; }
    case 'wait-orch-idle': {
      const after = o.after != null ? readLog(roomCode()).find(e => e.id === +o.after) : null;
      const t0 = after ? after.at : new Date().toISOString();
      let n = -1, since = Date.now();
      const ok = await until(o.what || `the orch's turn after #${o.after || 'now'} ends`, T, () => {
        const es = readJsonl(orchTranscript());
        if (es.length !== n) { n = es.length; since = Date.now(); return false; }
        const lastA = es.filter(e => e.type === 'assistant' && e.timestamp > t0).at(-1);
        return !!lastA && lastA.message && lastA.message.stop_reason === 'end_turn' && Date.now() - since > 6000;
      });
      return ok ? 0 : 1;
    }
    case 'synthetic-gate': {
      const o2 = readJ(roomFile('members.json'), {}).orch || {};
      const plugin = paths.PLUGIN;
      const input = { hook_event_name: 'TaskCompleted', session_id: o2.session_id, task_id: String(o._[0]), task_subject: '' };
      const r = require('node:child_process').spawnSync(process.execPath, [path.join(plugin, 'hooks', 'tasks.js')], {
        input: JSON.stringify(input), encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SUB_HUMAN_HOME: HOME_DIR(), CLAUDE_PID: String(o2.pid || ''), CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_CODE_TASK_LIST_ID: paths.taskListId(roomCode()) },
      });
      process.stdout.write(JSON.stringify({ input, status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), logMax: Math.max(0, ...readLog(roomCode()).map(e => e.id)) }, null, 1) + '\n');
      return 0;
    }
    case 'synthetic-orch-prompt': {
      const o2 = readJ(roomFile('members.json'), {}).orch || {};
      const plugin = paths.PLUGIN;
      const input = { hook_event_name: 'UserPromptSubmit', session_id: o2.session_id, transcript_path: orchTranscript() || '', cwd: process.cwd(), prompt: 'hi', prompt_id: 'synthetic-1', permission_mode: 'plan', sub_human_origin: 'composer' }; // as the mod's shim hands a typed prompt over
      const r = require('node:child_process').spawnSync(process.execPath, [path.join(plugin, 'hooks', 'at-room.js')], {
        input: JSON.stringify(input), encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SUB_HUMAN_HOME: HOME_DIR(), CLAUDE_PID: String(o2.pid || ''), CLAUDE_PLUGIN_ROOT: plugin },
      });
      process.stdout.write(JSON.stringify({ input: { prompt: input.prompt, session_id: input.session_id, pid: o2.pid }, status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() }, null, 1) + '\n');
      return 0;
    }
    case 'count': process.stdout.write(filterLog(o).length + '\n'); return 0;
    case 'last-id': { const e = filterLog(o).at(-1); process.stdout.write((e ? (o.field ? e[o.field] ?? '' : e.id) : 0) + '\n'); return e ? 0 : 1; }
    case 'log-max': { const es = readLog(roomCode()); process.stdout.write((es.length ? Math.max(...es.map(e => e.id || 0)) : 0) + '\n'); return 0; }
    case 'latest-plan': { const lp = readLog(roomCode()).filter(e => e.kind === 'plan_rev').at(-1); process.stdout.write((lp ? lp.plan_hash : '') + '\n'); return lp ? 0 : 1; }
    default:
      process.stderr.write('see the header of scripts/demo-lib.js for usage\n');
      return 2;
  }
}

if (require.main === module) main().then(c => process.exit(c), e => { process.stderr.write(`demo-lib: ${e.message}\n`); process.exit(2); });

module.exports = { KEY_BYTES, opts };
