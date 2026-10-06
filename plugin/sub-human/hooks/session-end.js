#!/usr/bin/env node
'use strict';
// SessionEnd: log member_left (via system) and mark the member left. Reasons "clear" and "resume"
// (/clear, and /resume from inside a running session) keep the claude process, so the seat stays and
// session-restore.js rebinds the new session id. `claude --resume` later rejoins the seat (session-restore).
// When no live member is left, start `node lib/orch.js reap CODE` detached: after a grace period (a quick
// rejoin cancels it) it marks the room closing, tells the orch to complete task 1, waits up to 20 s and runs
// `claude stop <job>`. The orch's own SessionEnd (it is stopped, or exits) only marks its seat left.
const path = require('node:path');
const { identity, room, run, whoami } = require('./common.js');
const orch = require(path.join(__dirname, '..', 'lib', 'orch.js'));

const KEEP = new Set(['clear', 'resume']);

run(input => {
  if (KEEP.has(input.reason)) return;
  const me = whoami(input);
  if (!me) return;
  if (me.role === 'orch') { try { identity.leave(me.code, me.name); } catch { /* gone */ } return; }
  room.append({ kind: 'member_left', text: `${me.name} left (${input.reason || 'session ended'})` }, { via: 'system', from: me.name, system: true });
  try { identity.leave(me.code, me.name); } catch { /* the log entry is what counts */ }
  if (!identity.liveMembers(me.code).length) orch.reapDetached(me.code);
});
