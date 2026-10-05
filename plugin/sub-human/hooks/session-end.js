#!/usr/bin/env node
'use strict';
// SessionEnd: log member_left (via system) and mark the member left. Reasons "clear" and "resume"
// (/clear, and /resume from inside a running session) keep the claude process, so the seat stays and
// session-restore.js rebinds the new session id. A departed member stays a required approver of the
// current plan until a new plan excludes them. `claude --resume` later rejoins the seat (session-restore).
const { identity, room, run, whoami } = require('./common.js');

const KEEP = new Set(['clear', 'resume']);

run(input => {
  if (KEEP.has(input.reason)) return;
  const me = whoami(input);
  if (!me) return;
  room.append({ kind: 'member_left', text: `${me.name} left (${input.reason || 'session ended'})` }, { via: 'system', from: me.name, system: true });
  try { identity.leave(me.code, me.name); } catch { /* the log entry is what counts */ }
});
