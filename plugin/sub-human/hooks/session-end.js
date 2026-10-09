#!/usr/bin/env node
'use strict';
// SessionEnd: mark the member left and log member_left (via system): lib/seats.js exit. Reasons "clear" and
// "resume" (/clear, and /resume from inside a running session) keep the claude process, so the seat stays and
// session-restore.js rebinds the new session id. `claude --resume` later rejoins the seat (session-restore).
// When no live member is left, exit starts `node lib/room-claude.js reap CODE` detached (on the host): after a grace
// period (a quick rejoin cancels it) it marks the room closing, tells the room's Claude to complete task 1, waits up to
// 20 s and runs `claude stop <job>`. The room Claude's own SessionEnd (it is stopped, or exits) only marks its seat left.
// Budget: SessionEnd gets a few seconds (hooks.json timeout; 1.5 s by default), so nothing here waits on a
// child: the seat is marked left and the reaper started (detached) before the log append, which is the
// only step that can wait on a lock. In a room hosted elsewhere the leave is one op over the link, within
// LINK_CALL_END_MS; the host logs member_left and runs the reaper.
const path = require('node:path');
const { identity, run, whoami } = require('./common.js');
const seats = require(path.join(__dirname, '..', 'lib', 'seats.js'));
const { LINK_CALL_END_MS } = require(path.join(__dirname, '..', 'lib', 'config.js'));

const KEEP = new Set(['clear', 'resume']);

run(input => {
  // This session id is over in this process (a /clear or /resume continues under another id, and mod-hello writes
  // that id's lease): a later --resume of it must say hello again before it can join.
  try { identity.deleteModLease(input.session_id); } catch { /* the join sweep prunes it */ }
  if (KEEP.has(input.reason)) return;
  const me = whoami(input);
  if (!me) return;
  if (me.role === 'claude') { try { identity.leave(me.code, me.name); } catch { /* gone */ } return; }
  seats.exit(me.code, me.name, input.reason || 'session ended', { deadlineMs: LINK_CALL_END_MS });
});
