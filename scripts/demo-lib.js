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
 *                        with option 2 ("Yes, and …" for the session; else 1. Yes) until the log matches
 *   demo-lib.js wait-holds <seat> <name> [--timeout S]   wait until <seat>'s room server holds <name>'s row
 *                                                  (rows/holds-<seat>.json, fresh)
 *   demo-lib.js count --kind K [same filters]     print the count now
 *   demo-lib.js last-id --kind K [same filters]   print the id of the last matching entry (0 if none)
 *   demo-lib.js log-max                           print the highest log id
 *   demo-lib.js latest-plan                       print the latest plan_rev hash
 *   demo-lib.js readonly <session>                exit 0 if a read-only client is attached
 *
 * Every wait appends {scene, what, ok, ms, time} to $SNAP_DIR/waits.jsonl (scene from $DEMO_SCENE)
 * and exits 1 on timeout (demo.sh treats that as best-effort and keeps going).
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

const REPO = path.resolve(__dirname, '..');
const SNAP_DIR = process.env.SNAP_DIR ? path.resolve(process.env.SNAP_DIR) : path.join(REPO, 'docs/rebuild/screens');

const tmux = (...a) => execFileSync('tmux', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tgt = s => (s.includes(':') ? s : `${s}:`);

const KEY_BYTES = {
  Enter: '\r', Esc: '\x1b', Escape: '\x1b', Tab: '\t', BTab: '\x1b[Z', Space: ' ', BSpace: '\x7f',
  Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D', 'C-c': '\x03', 'C-d': '\x04', 'C-j': '\n',
  'C-u': '\x15', 'C-l': '\x0c',
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
    if (Date.now() - t0 > timeoutS * 1000) { record(what, false, Date.now() - t0); process.stderr.write(`  ✗ timeout ${timeoutS}s: ${what}\n`); return false; }
    await sleep(700);
  }
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
  const T = +(o.timeout || 60);
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
      let approvals = 0, last = 0;
      const ok = await until(what, T, () => {
        if (filterLog(o).length >= n) return true;
        const p = pane(o._[0]);
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
      const home = process.env.SUB_HUMAN_HOME || path.join(require('node:os').homedir(), '.sub-human');
      const f = () => path.join(home, 'rooms', roomCode() || '-', 'rows', `holds-${o._[0]}.json`);
      const ok = await until(o.what || `${o._[0]}'s room holds ${o._[1]}'s row`, T, () => {
        const h = JSON.parse(fs.readFileSync(f(), 'utf8'));
        return Date.now() - Date.parse(h.at) < 90_000 && (h.members || []).includes(o._[1]);
      });
      return ok ? 0 : 1;
    }
    case 'count': process.stdout.write(filterLog(o).length + '\n'); return 0;
    case 'last-id': { const e = filterLog(o).at(-1); process.stdout.write((e ? e.id : 0) + '\n'); return e ? 0 : 1; }
    case 'log-max': { const es = readLog(roomCode()); process.stdout.write((es.length ? Math.max(...es.map(e => e.id || 0)) : 0) + '\n'); return 0; }
    case 'latest-plan': { const lp = readLog(roomCode()).filter(e => e.kind === 'plan_rev').at(-1); process.stdout.write((lp ? lp.plan_hash : '') + '\n'); return lp ? 0 : 1; }
    default:
      process.stderr.write('see the header of scripts/demo-lib.js for usage\n');
      return 2;
  }
}

if (require.main === module) main().then(c => process.exit(c), e => { process.stderr.write(`demo-lib: ${e.message}\n`); process.exit(2); });

module.exports = { KEY_BYTES, filterLog, opts };
