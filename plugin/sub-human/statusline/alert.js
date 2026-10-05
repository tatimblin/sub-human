'use strict';
/**
 * plugin/sub-human/statusline/alert.js: alert the human (not their Claude) when the room waits on them (E6).
 * Used by `sub-human tail` on a member's side (never the orch).
 *
 *   createAlerter({me, dir, pid, env}) -> {onEntry(e), deliver(kind, title, text)}
 *       me = {code, name, role}; dir = the room dir (debounce state lives in <dir>/alert-<name>.json, so a
 *       restarted tail doesn't alert twice); pid = the claude process whose terminal gets the bell.
 *     onEntry(e) alerts on:
 *       a plan_rev whose approvers name me, when I have not signed it and it is not decided (checked against
 *         the log at that moment). At most once per plan hash, ever.
 *       an entry addressed to me (to === name, from !== name). At most once per 30 s (SUB_HUMAN_ALERT_GAP_MS).
 *       Entries older than 10 min are history (a tail catching up) and never alert. The orch never alerts.
 *     deliver: SUB_HUMAN_ALERT_FILE=path appends {at, kind, title, text} as a JSON line instead of the
 *       side effects below (tests). Otherwise, best-effort and never throwing:
 *         - macOS: `osascript display notification` (2 s timeout). It targets no app, so there is no
 *           Automation prompt; whether it shows depends on Notifications settings for Script Editor.
 *         - a BEL written to the claude process's terminal (ps -o tty=). A monitor has no controlling tty
 *           (/dev/tty is ENXIO there), but the claude tty is writable by the same user.
 *   SUB_HUMAN_NOTIFY=0 turns all of it off.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const STALE_MS = 10 * 60 * 1000;
const MAX_HASHES = 50;

const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const a = Array.from(s); return a.length > n ? a.slice(0, n - 1).join('') + '…' : s; };

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { plans: Array.isArray(s.plans) ? s.plans : [], msgAt: Number(s.msgAt) || 0 };
  } catch { return { plans: [], msgAt: 0 }; }
}
function writeState(file, s) {
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  } catch { /* best effort */ }
}

function ttyOf(pid) {
  if (!(Number(pid) > 0)) return null;
  try {
    const r = spawnSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
    const t = String(r.stdout || '').trim();
    return t && t !== '??' && t !== '?' ? (t.startsWith('/') ? t : `/dev/${t}`) : null;
  } catch { return null; }
}

function ringBell(pid) {
  const tty = ttyOf(pid);
  if (!tty) return false;
  try {
    const fd = fs.openSync(tty, fs.constants.O_WRONLY | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
    try { fs.writeSync(fd, '\x07'); } finally { fs.closeSync(fd); }
    return true;
  } catch { return false; }
}

function notify(title, subtitle, text) {
  if (process.platform !== 'darwin') return;
  try {
    // argv, not string interpolation: the text is room content.
    const c = spawn('osascript', ['-e', 'on run argv', '-e',
      'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)', '-e', 'end run',
      text, title, subtitle], { stdio: 'ignore', timeout: 2000 });
    c.on('error', () => {});
    c.unref();
  } catch { /* blocked or missing: fine */ }
}

function createAlerter({ me, dir, pid, env = process.env, now = () => Date.now(), lookup } = {}) {
  const off = env.SUB_HUMAN_NOTIFY === '0' || !me || me.role === 'orch';
  const file = dir ? path.join(dir, `alert-${me && me.name}.json`) : null;
  const gapEnv = env.SUB_HUMAN_ALERT_GAP_MS;
  const gap = gapEnv != null && gapEnv !== '' && Number(gapEnv) >= 0 ? Number(gapEnv) : 30_000;
  const sink = env.SUB_HUMAN_ALERT_FILE;

  function deliver(kind, title, text) {
    if (sink) {
      try { fs.appendFileSync(sink, JSON.stringify({ at: new Date(now()).toISOString(), kind, title, text }) + '\n'); } catch { /* ignore */ }
      return;
    }
    notify('sub-human', title, text);
    ringBell(pid);
  }

  function onEntry(e) {
    if (off || !e) return false;
    const t = Date.parse(e.at);
    if (Number.isFinite(t) && now() - t > STALE_MS) return false;
    if (e.kind === 'plan_rev' && e.plan_hash && Array.isArray(e.approvers) && e.approvers.includes(me.name)) {
      const st = file ? readState(file) : { plans: [], msgAt: 0 };
      if (st.plans.includes(e.plan_hash)) return false;
      // `lookup(hash)` -> {signedByMe, decided}; the hash is new, so this is almost always "needed".
      const cur = lookup ? lookup(e.plan_hash) : { signedByMe: false, decided: false };
      if (cur.signedByMe || cur.decided) return false;
      st.plans = [...st.plans, e.plan_hash].slice(-MAX_HASHES);
      if (file) writeState(file, st);
      deliver('signoff', `${me.code}: your sign-off is needed`,
        `Plan ${e.plan_hash.slice(0, 6)} waits on you: the sign-off form is in your Claude Code session.`);
      return true;
    }
    if (e.to === me.name && e.from !== me.name) {
      const st = file ? readState(file) : { plans: [], msgAt: 0 };
      if (now() - st.msgAt < gap) return false;
      st.msgAt = now();
      if (file) writeState(file, st);
      const who = e.via === 'system' ? 'room' : e.via === 'agent' && e.from !== 'orch' ? `${e.from}'s Claude` : e.from;
      deliver('message', `${me.code}: ${who} → you`, clip(oneLine(e.text), 160));
      return true;
    }
    return false;
  }

  return { onEntry, deliver };
}

module.exports = { createAlerter, ringBell, ttyOf, notify, STALE_MS };
