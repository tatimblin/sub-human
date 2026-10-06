#!/usr/bin/env node
'use strict';
// SessionStart(resume), registered with "asyncRewake": true (A-rows #10). Rows are in-memory tasks, so
// --continue / --resume restores none of them, and session-restore.js's additionalContext is read only on
// the next prompt. This hook runs in the background and, when this seat is missing rows, exits 2 with the
// exact Agent calls on stderr: Claude Code then wakes the model with that text and no user prompt (verified
// by probe on 2.1.281). Nothing missing, or not in a room: silent exit 0. row-guard.js still denies any
// duplicate spawn a later prompt might attempt.
//
// It runs concurrently with session-restore.js, which may re-join the seat (resume after session-end), so
// it polls up to SUB_HUMAN_REWAKE_WAIT_MS (3000) for the seat, preferring the moment it is bound to this
// claude process (CLAUDE_PID).
const path = require('node:path');
const identity = require(path.join(__dirname, '..', 'lib', 'identity.js'));
const rows = require(path.join(__dirname, '..', 'lib', 'rows.js'));
const { readInput, resolveMe } = require(path.join(__dirname, 'row-common.js'));

const LEAD = 'sub-human: this session was resumed and its rows did not survive it. Re-create them now, exactly as written:\n';
const TAIL = '\nWrite no text: make only these calls and end your turn.';
const envWait = Number(process.env.SUB_HUMAN_REWAKE_WAIT_MS);
const WAIT_MS = process.env.SUB_HUMAN_REWAKE_WAIT_MS && envWait >= 0 ? envWait : 3000;

const nap = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function findSeat(input) {
  let pid = null;
  try { pid = identity.claudePid(); } catch { pid = null; }
  const deadline = Date.now() + WAIT_MS;
  let me = null;
  for (;;) {
    me = resolveMe(input);
    if (me && (!pid || !me.pid || Number(me.pid) === Number(pid))) return me;
    if (Date.now() >= deadline) return me;
    nap(100);
  }
}

/** The rewake text for this seat, or '' when every row it should have is held. */
function rewakeText(me) {
  const members = identity.readMembers(me.code) || {};
  const held = rows.readHolds(me.code, me.name);
  const only = rows.rowsNeeded(me.code, me, { members, held });
  if (!only.length) return '';
  const calls = rows.rowCalls(me, members, { only });
  if (!/Agent\(/.test(calls)) return ''; // e.g. an orch with no members yet: nothing to spawn
  return LEAD + calls + TAIL;
}

let code = 0;
try {
  const input = readInput();
  if (!input.source || input.source === 'resume') {
    const me = findSeat(input);
    const text = me ? rewakeText(me) : '';
    if (text) { process.stderr.write(text + '\n'); code = 2; }
  }
} catch { code = 0; /* never disturb the session */ }
process.exitCode = code;
